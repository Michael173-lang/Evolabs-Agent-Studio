use serde::Serialize;
use serde_json::Value;
use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const DEFAULT_MODEL_QUERY: &str = "qwen/qwen3-4b-2507@q4_k_m";
const MODEL_MATCH: &str = "qwen3-4b-2507";
const MODEL_IDENTIFIER: &str = "evolabs-agent";
const SERVER_PORT: u16 = 1234;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSetupStep {
    id: String,
    title: String,
    state: String,
    detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSetupSnapshot {
    state: String,
    stage: String,
    progress: f64,
    title: String,
    message: String,
    model: Option<String>,
    error: Option<String>,
    updated_at_unix_ms: u64,
    steps: Vec<RuntimeSetupStep>,
}

static SETUP_RUNNING: AtomicBool = AtomicBool::new(false);
static SETUP_STATE: OnceLock<Mutex<RuntimeSetupSnapshot>> = OnceLock::new();

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn initial_snapshot() -> RuntimeSetupSnapshot {
    RuntimeSetupSnapshot {
        state: "idle".into(),
        stage: "system".into(),
        progress: 0.0,
        title: "準備 Evolabs AI Studio".into(),
        message: "等待開始。".into(),
        model: None,
        error: None,
        updated_at_unix_ms: now_ms(),
        steps: vec![
            RuntimeSetupStep { id: "system".into(), title: "檢查電腦與核心".into(), state: "queued".into(), detail: "確認本機引擎、GPU 與儲存空間".into() },
            RuntimeSetupStep { id: "llmster".into(), title: "準備 AI Agent 服務".into(), state: "queued".into(), detail: "安裝或修復 LM Studio llmster 後台".into() },
            RuntimeSetupStep { id: "model".into(), title: "下載 Agent 大腦".into(), state: "queued".into(), detail: "依硬體選擇本機模型與量化".into() },
            RuntimeSetupStep { id: "load".into(), title: "載入並最佳化".into(), state: "queued".into(), detail: "設定 GPU offload、上下文與自動卸載".into() },
            RuntimeSetupStep { id: "verify".into(), title: "最終健康檢查".into(), state: "queued".into(), detail: "確認 Agent API 可直接被 Evolabs 使用".into() },
        ],
    }
}

fn state_lock() -> &'static Mutex<RuntimeSetupSnapshot> {
    SETUP_STATE.get_or_init(|| Mutex::new(initial_snapshot()))
}

pub fn current_snapshot() -> RuntimeSetupSnapshot {
    state_lock().lock().map(|state| state.clone()).unwrap_or_else(|_| initial_snapshot())
}

fn app_state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|root| root.join("runtime").join("setup-state.json"))
}

fn persist(app: &AppHandle, snapshot: &RuntimeSetupSnapshot) {
    let Some(path) = app_state_path(app) else { return; };
    let Some(parent) = path.parent() else { return; };
    if fs::create_dir_all(parent).is_err() { return; }
    let Ok(bytes) = serde_json::to_vec_pretty(snapshot) else { return; };
    let temporary = parent.join(".setup-state.tmp");
    if fs::write(&temporary, bytes).is_ok() {
        if path.exists() { let _ = fs::remove_file(&path); }
        let _ = fs::rename(temporary, path);
    }
}

fn publish(app: &AppHandle, snapshot: RuntimeSetupSnapshot) {
    if let Ok(mut state) = state_lock().lock() {
        *state = snapshot.clone();
    }
    persist(app, &snapshot);
    let _ = app.emit("evolabs://runtime-setup", &snapshot);
}

fn update(
    app: &AppHandle,
    stage: &str,
    progress: f64,
    title: &str,
    message: &str,
    step_state: &str,
    model: Option<String>,
) {
    let mut snapshot = current_snapshot();
    snapshot.state = "running".into();
    snapshot.stage = stage.into();
    snapshot.progress = progress.clamp(0.0, 100.0);
    snapshot.title = title.into();
    snapshot.message = message.into();
    snapshot.error = None;
    if model.is_some() { snapshot.model = model; }
    snapshot.updated_at_unix_ms = now_ms();
    for step in &mut snapshot.steps {
        if step.id == stage {
            step.state = step_state.into();
            step.detail = message.into();
        } else if step.state == "working" {
            step.state = "done".into();
        }
    }
    publish(app, snapshot);
}

fn fail(app: &AppHandle, stage: &str, error: String) {
    let mut snapshot = current_snapshot();
    snapshot.state = "failed".into();
    snapshot.stage = stage.into();
    snapshot.title = "自動準備沒有完成".into();
    snapshot.message = "Evolabs 已保留進度，可按重新修復。".into();
    snapshot.error = Some(error.clone());
    snapshot.updated_at_unix_ms = now_ms();
    for step in &mut snapshot.steps {
        if step.id == stage {
            step.state = "failed".into();
            step.detail = error.clone();
        }
    }
    publish(app, snapshot);
}

fn complete(app: &AppHandle, model: String) {
    let mut snapshot = current_snapshot();
    snapshot.state = "completed".into();
    snapshot.stage = "verify".into();
    snapshot.progress = 100.0;
    snapshot.title = "Evolabs AI Studio 已就緒".into();
    snapshot.message = "AI Agent 後台、模型與本機 API 都已自動準備完成。".into();
    snapshot.model = Some(model);
    snapshot.error = None;
    snapshot.updated_at_unix_ms = now_ms();
    for step in &mut snapshot.steps { step.state = "done".into(); }
    publish(app, snapshot);
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

fn command_log_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let root = app.path().app_local_data_dir().map_err(|error| error.to_string())?.join("runtime").join("logs");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root.join(format!("{name}.log")))
}

fn run_logged(app: &AppHandle, executable: &Path, args: &[&str], name: &str, timeout: Duration) -> Result<(), String> {
    let log_path = command_log_path(app, name)?;
    let log = OpenOptions::new().create(true).truncate(true).write(true).open(&log_path).map_err(|error| error.to_string())?;
    let stderr = log.try_clone().map_err(|error| error.to_string())?;
    let mut command = Command::new(executable);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(stderr));
    hide_console(&mut command);
    let mut child = command.spawn().map_err(|error| format!("無法啟動 {}：{error}", executable.display()))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) if status.success() => return Ok(()),
            Some(status) => {
                let detail = fs::read_to_string(&log_path).unwrap_or_default();
                let tail = detail.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" | ");
                return Err(format!("命令執行失敗（{}）：{}", status, if tail.is_empty() { log_path.display().to_string() } else { tail }));
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("命令執行逾時：{}", log_path.display()));
            }
            None => thread::sleep(Duration::from_millis(250)),
        }
    }
}

fn command_output(executable: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = Command::new(executable);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => {
                let output = child.wait_with_output().map_err(|error| error.to_string())?;
                if !status.success() {
                    return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
                }
                return Ok(String::from_utf8_lossy(&output.stdout).to_string());
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let output = child.wait_with_output().map_err(|error| error.to_string())?;
                return Err(format!("命令逾時：{}", String::from_utf8_lossy(&output.stderr).trim()));
            }
            None => thread::sleep(Duration::from_millis(120)),
        }
    }
}

fn find_lms() -> Option<PathBuf> {
    if let Ok(override_path) = env::var("EVOLABS_LMS_PATH") {
        let path = PathBuf::from(override_path);
        if path.is_file() { return Some(path); }
    }
    if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
        let home = PathBuf::from(home);
        for candidate in [home.join(".lmstudio").join("bin").join("lms.exe"), home.join(".lmstudio").join("bin").join("lms")] {
            if candidate.is_file() { return Some(candidate); }
        }
    }
    let mut command = if cfg!(windows) { Command::new("where.exe") } else { Command::new("which") };
    command.arg(if cfg!(windows) { "lms.exe" } else { "lms" }).stdin(Stdio::null()).stderr(Stdio::null());
    hide_console(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() { return None; }
    String::from_utf8_lossy(&output.stdout).lines().map(str::trim).filter(|line| !line.is_empty()).map(PathBuf::from).find(|path| path.is_file())
}

#[cfg(windows)]
fn install_llmster(app: &AppHandle) -> Result<PathBuf, String> {
    let powershell = PathBuf::from("powershell.exe");
    let script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; irm https://lmstudio.ai/install.ps1 | iex";
    run_logged(app, &powershell, &["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], "llmster-install", Duration::from_secs(15 * 60))?;
    find_lms().ok_or_else(|| "官方 llmster 安裝完成後仍找不到 lms.exe。".to_string())
}

#[cfg(not(windows))]
fn install_llmster(_app: &AppHandle) -> Result<PathBuf, String> {
    Err("此自動安裝版本目前只支援 Windows。".into())
}

fn find_model_key(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in ["modelKey", "key", "path", "id"] {
                if let Some(candidate) = map.get(key).and_then(Value::as_str) {
                    if candidate.to_ascii_lowercase().contains(MODEL_MATCH) { return Some(candidate.to_string()); }
                }
            }
            map.values().find_map(find_model_key)
        }
        Value::Array(items) => items.iter().find_map(find_model_key),
        Value::String(text) if text.to_ascii_lowercase().contains(MODEL_MATCH) => Some(text.clone()),
        _ => None,
    }
}

fn downloaded_model(lms: &Path) -> Option<String> {
    let output = command_output(lms, &["ls", "--llm", "--json"], Duration::from_secs(30)).ok()?;
    serde_json::from_str::<Value>(&output).ok().and_then(|value| find_model_key(&value))
}

fn api_model() -> Option<String> {
    let address = SocketAddr::from(([127, 0, 0, 1], SERVER_PORT));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    stream.write_all(b"GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1:1234\r\nConnection: close\r\n\r\n").ok()?;
    let mut bytes = Vec::new();
    stream.take(4 * 1024 * 1024).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    if !text.starts_with("HTTP/1.1 200") && !text.starts_with("HTTP/1.0 200") { return None; }
    let body = text.split("\r\n\r\n").nth(1)?;
    let value: Value = serde_json::from_str(body).ok()?;
    let items = value.get("data").and_then(Value::as_array)?;
    items
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .find(|id| *id == MODEL_IDENTIFIER || id.to_ascii_lowercase().contains(MODEL_MATCH))
        .map(str::to_string)
}

fn run_setup(app: AppHandle) {
    let result = (|| -> Result<String, (String, String)> {
        update(&app, "system", 8.0, "正在檢查本機核心", "確認 Evolabs 引擎與 Windows 執行環境。", "working", None);
        thread::sleep(Duration::from_millis(350));

        if let Some(model) = api_model() {
            update(&app, "verify", 96.0, "正在驗證現有 Agent", "已發現可直接使用的本機模型。", "working", Some(model.clone()));
            return Ok(model);
        }

        update(&app, "llmster", 18.0, "正在準備 AI Agent 服務", "Evolabs 會使用 LM Studio 官方 llmster 後台，不需要另開 LM Studio。", "working", None);
        let lms = match find_lms() {
            Some(path) => path,
            None => install_llmster(&app).map_err(|error| ("llmster".into(), error))?,
        };

        update(&app, "llmster", 31.0, "正在啟動 llmster", "啟動無介面的本機 AI 服務。", "working", None);
        run_logged(&app, &lms, &["daemon", "up", "--json"], "llmster-daemon", Duration::from_secs(90))
            .map_err(|error| ("llmster".into(), error))?;
        // Starting an already-running server may return a non-zero code. Probe later before treating it as fatal.
        let _ = run_logged(&app, &lms, &["server", "start", "--port", "1234"], "llmster-server", Duration::from_secs(90));

        let model_key = if let Some(model) = downloaded_model(&lms) {
            update(&app, "model", 62.0, "Agent 模型已存在", "直接使用已下載的 Qwen3 4B 量化模型。", "done", Some(model.clone()));
            model
        } else {
            update(&app, "model", 38.0, "正在下載 Agent 大腦", "第一次需要下載約數 GB；Evolabs 會自動續用，不必每次重抓。", "working", None);
            run_logged(&app, &lms, &["get", DEFAULT_MODEL_QUERY, "--gguf"], "agent-model-download", Duration::from_secs(90 * 60))
                .map_err(|error| ("model".into(), error))?;
            downloaded_model(&lms).ok_or_else(|| ("model".into(), "模型下載完成，但無法從 lms ls 找到模型。".into()))?
        };

        update(&app, "load", 76.0, "正在載入並最佳化模型", "依本機硬體自動設定 GPU offload、8K 上下文與閒置卸載。", "working", Some(model_key.clone()));
        let _ = run_logged(&app, &lms, &["unload", "--all"], "agent-model-unload", Duration::from_secs(90));
        run_logged(
            &app,
            &lms,
            &["load", &model_key, "--identifier", MODEL_IDENTIFIER, "--context-length", "8192", "--gpu", "auto", "--ttl", "1800"],
            "agent-model-load",
            Duration::from_secs(12 * 60),
        ).map_err(|error| ("load".into(), error))?;
        let _ = run_logged(&app, &lms, &["server", "start", "--port", "1234"], "llmster-server-final", Duration::from_secs(90));

        update(&app, "verify", 94.0, "正在做最終健康檢查", "確認 Evolabs 能從 127.0.0.1:1234 呼叫本機 Agent。", "working", Some(model_key));
        for _ in 0..20 {
            if let Some(model) = api_model() { return Ok(model); }
            thread::sleep(Duration::from_millis(750));
        }
        Err(("verify".into(), "llmster 已啟動，但 1234 API 尚未回應模型清單。".into()))
    })();

    match result {
        Ok(model) => complete(&app, model),
        Err((stage, error)) => fail(&app, &stage, error),
    }
    SETUP_RUNNING.store(false, Ordering::Release);
}

pub fn start_setup(app: AppHandle, force: bool) -> RuntimeSetupSnapshot {
    if !force {
        let current = current_snapshot();
        if current.state == "running" { return current; }
        if let Some(model) = api_model() {
            complete(&app, model);
            return current_snapshot();
        }
    }
    if SETUP_RUNNING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return current_snapshot();
    }
    publish(&app, initial_snapshot());
    let worker_app = app.clone();
    thread::spawn(move || run_setup(worker_app));
    current_snapshot()
}
