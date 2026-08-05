use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::{
    env,
    ffi::OsString,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use sysinfo::Disks;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:8188";
const STATUS_FILE: &str = "managed-comfyui-status.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedComfyUiStep {
    id: String,
    title: String,
    state: String,
    detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedComfyUiStatus {
    installed: bool,
    running: bool,
    available: bool,
    state: String,
    progress: u8,
    message: String,
    install_path: Option<String>,
    version: Option<String>,
    process_id: Option<u32>,
    downloaded_bytes: u64,
    total_bytes: u64,
    installed_bytes: u64,
    endpoint: String,
    error: Option<String>,
    steps: Vec<ManagedComfyUiStep>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedComfyUiActionResult {
    ok: bool,
    message: String,
    freed_bytes: u64,
}

static STATUS: OnceLock<Mutex<ManagedComfyUiStatus>> = OnceLock::new();

fn unix_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn managed_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("managed")
        .join("comfyui"))
}

fn comfy_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(managed_root(app)?.join("ComfyUI"))
}

fn tool_venv_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(managed_root(app)?.join("tool-venv"))
}

fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(managed_root(app)?.join("logs").join("managed-comfyui.log"))
}

fn status_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(managed_root(app)?.join(STATUS_FILE))
}

#[cfg(windows)]
fn venv_python(root: &Path) -> PathBuf {
    root.join("Scripts").join("python.exe")
}

#[cfg(not(windows))]
fn venv_python(root: &Path) -> PathBuf {
    root.join("bin").join("python")
}

#[cfg(windows)]
fn comfy_executable(root: &Path) -> PathBuf {
    root.join("Scripts").join("comfy.exe")
}

#[cfg(not(windows))]
fn comfy_executable(root: &Path) -> PathBuf {
    root.join("bin").join("comfy")
}


fn available_space_for(path: &Path) -> u64 {
    let disks = Disks::new_with_refreshed_list();
    let existing = path
        .ancestors()
        .find(|candidate| candidate.exists())
        .unwrap_or(path);
    let canonical = existing.canonicalize().unwrap_or_else(|_| existing.to_path_buf());
    disks
        .iter()
        .filter(|disk| canonical.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())
        .map(|disk| disk.available_space())
        .unwrap_or(0)
}

fn ensure_install_space(root: &Path, repair: bool) -> Result<(), String> {
    const GIB: u64 = 1024 * 1024 * 1024;
    let required = if repair { 2 * GIB } else { 8 * GIB };
    let available = available_space_for(root);
    if available > 0 && available < required {
        return Err(format!(
            "可用儲存空間不足。AI 影片引擎{}至少需要 {:.0} GB，目前僅剩 {:.1} GB。請先在「設定 → 空間管理」清理舊模型、快取或輸出檔案。",
            if repair { "修復" } else { "安裝" },
            required as f64 / GIB as f64,
            available as f64 / GIB as f64,
        ));
    }
    Ok(())
}

fn directory_size(path: &Path) -> u64 {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(_) => return 0,
    };
    if metadata.file_type().is_symlink() {
        return 0;
    }
    if metadata.is_file() {
        return metadata.len();
    }
    if !metadata.is_dir() {
        return 0;
    }
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| directory_size(&entry.path()))
        .fold(0_u64, u64::saturating_add)
}

fn remove_path(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() {
        return Err("基於安全考量，Evolabs 不會刪除符號連結。".into());
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else if metadata.is_file() {
        fs::remove_file(path).map_err(|error| error.to_string())
    } else {
        Err("選取的路徑不是一般檔案或資料夾。".into())
    }
}

fn step_state(progress: u8, done_at: u8, working_from: u8, failed: bool) -> &'static str {
    if failed && progress >= working_from && progress < done_at {
        "failed"
    } else if progress >= done_at {
        "done"
    } else if progress >= working_from {
        "working"
    } else {
        "queued"
    }
}

fn build_steps(progress: u8, error: Option<&str>) -> Vec<ManagedComfyUiStep> {
    let failed = error.is_some();
    [
        ("system", "檢查系統工具", 12_u8, 1_u8, "確認 Python、Git 與安裝目錄。"),
        ("download", "安裝管理元件", 35_u8, 12_u8, "準備 ComfyUI 管理工具與相依套件。"),
        ("extract", "安裝 ComfyUI", 82_u8, 35_u8, "建立 ComfyUI 執行環境。"),
        ("launch", "啟動影片引擎", 95_u8, 82_u8, "以低顯存設定啟動背景服務。"),
        ("verify", "驗證服務", 100_u8, 95_u8, "確認本機服務與 API 可用。"),
    ]
    .into_iter()
    .map(|(id, title, done_at, working_from, detail)| ManagedComfyUiStep {
        id: id.into(),
        title: title.into(),
        state: step_state(progress, done_at, working_from, failed).into(),
        detail: if failed && progress >= working_from && progress < done_at {
            error.unwrap_or(detail).to_string()
        } else {
            detail.into()
        },
    })
    .collect()
}

fn initial_status(app: Option<&AppHandle>) -> ManagedComfyUiStatus {
    let install_path = app.and_then(|app| managed_root(app).ok()).map(|path| path.to_string_lossy().to_string());
    ManagedComfyUiStatus {
        installed: false,
        running: false,
        available: false,
        state: "not-installed".into(),
        progress: 0,
        message: "尚未安裝 AI 影片引擎。".into(),
        install_path,
        version: None,
        process_id: None,
        downloaded_bytes: 0,
        total_bytes: 0,
        installed_bytes: 0,
        endpoint: DEFAULT_ENDPOINT.into(),
        error: None,
        steps: build_steps(0, None),
        updated_at: Some(unix_timestamp()),
    }
}

fn status_lock() -> &'static Mutex<ManagedComfyUiStatus> {
    STATUS.get_or_init(|| Mutex::new(initial_status(None)))
}

fn endpoint_is_ready() -> bool {
    Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()
        .and_then(|client| client.get(format!("{DEFAULT_ENDPOINT}/system_stats")).send().ok())
        .is_some_and(|response| response.status().is_success())
}

fn write_status(app: &AppHandle, mut next: ManagedComfyUiStatus) {
    next.updated_at = Some(unix_timestamp());
    next.install_path = managed_root(app).ok().map(|path| path.to_string_lossy().to_string());
    next.installed_bytes = managed_root(app).ok().map(|path| directory_size(&path)).unwrap_or(0);
    next.available = next.running && endpoint_is_ready();
    next.steps = build_steps(next.progress, next.error.as_deref());
    if let Ok(mut guard) = status_lock().lock() {
        *guard = next.clone();
    }
    if let Ok(path) = status_path(app) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(encoded) = serde_json::to_vec_pretty(&next) {
            let temporary = path.with_extension("json.tmp");
            if fs::write(&temporary, encoded).is_ok() {
                let _ = fs::remove_file(&path);
                let _ = fs::rename(temporary, path);
            }
        }
    }
}

fn read_persisted_status(app: &AppHandle) -> Option<ManagedComfyUiStatus> {
    let bytes = fs::read(status_path(app).ok()?).ok()?;
    if bytes.len() > 256 * 1024 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn current_status(app: &AppHandle) -> ManagedComfyUiStatus {
    let mut status = status_lock()
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| initial_status(Some(app)));
    if status.install_path.is_none() {
        if let Some(persisted) = read_persisted_status(app) {
            status = persisted;
        }
    }
    let tool_root = tool_venv_root(app).unwrap_or_default();
    let installed = comfy_executable(&tool_root).is_file() && comfy_root(app).unwrap_or_default().join("main.py").is_file();
    let running = installed && endpoint_is_ready();
    status.installed = installed;
    status.running = running;
    status.available = running;
    status.install_path = managed_root(app).ok().map(|path| path.to_string_lossy().to_string());
    status.installed_bytes = managed_root(app).ok().map(|path| directory_size(&path)).unwrap_or(0);
    if running && !matches!(status.state.as_str(), "installing" | "repairing" | "uninstalling") {
        status.state = "running".into();
        status.progress = 100;
        status.message = "AI 影片引擎正在背景執行。".into();
        status.error = None;
    } else if installed && !matches!(status.state.as_str(), "installing" | "repairing" | "starting" | "uninstalling") {
        status.state = "idle".into();
        status.progress = 100;
        status.message = "AI 影片引擎已安裝，目前尚未啟動。".into();
        status.error = None;
    } else if !installed && !matches!(status.state.as_str(), "installing" | "repairing" | "failed" | "uninstalling") {
        status = initial_status(Some(app));
    }
    status.steps = build_steps(status.progress, status.error.as_deref());
    status
}

fn append_log(path: &Path, line: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{}] {}", unix_timestamp(), line);
    }
}

fn command_for(program: &Path) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn run_logged(program: &Path, arguments: &[OsString], log: &Path, current_dir: Option<&Path>) -> Result<(), String> {
    if let Some(parent) = log.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let stdout = OpenOptions::new().create(true).append(true).open(log).map_err(|error| error.to_string())?;
    let stderr = stdout.try_clone().map_err(|error| error.to_string())?;
    append_log(
        log,
        &format!(
            "執行：{} {}",
            program.display(),
            arguments.iter().map(|item| item.to_string_lossy()).collect::<Vec<_>>().join(" ")
        ),
    );
    let mut command = command_for(program);
    command.args(arguments).stdout(Stdio::from(stdout)).stderr(Stdio::from(stderr));
    if let Some(directory) = current_dir {
        command.current_dir(directory);
    }
    let status = command.status().map_err(|error| format!("無法啟動 {}：{error}", program.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{} 執行失敗（離開碼 {:?}）。請查看 AI 影片引擎日誌。", program.display(), status.code()))
    }
}

fn command_succeeds(program: &Path, args: &[&str]) -> bool {
    let mut command = command_for(program);
    command.args(args).stdout(Stdio::null()).stderr(Stdio::null());
    command.status().is_ok_and(|status| status.success())
}

#[cfg(windows)]
fn install_with_winget(package_id: &str, log: &Path) -> Result<(), String> {
    run_logged(
        Path::new("winget.exe"),
        &[
            OsString::from("install"),
            OsString::from("--id"),
            OsString::from(package_id),
            OsString::from("--exact"),
            OsString::from("--silent"),
            OsString::from("--accept-package-agreements"),
            OsString::from("--accept-source-agreements"),
        ],
        log,
        None,
    )
}

fn discover_python() -> Result<(PathBuf, Vec<OsString>), String> {
    let mut candidates: Vec<(PathBuf, Vec<OsString>)> = Vec::new();
    if let Some(path) = env::var_os("EVOLABS_PYTHON") {
        candidates.push((PathBuf::from(path), vec![]));
    }
    #[cfg(windows)]
    {
        for version in ["-3.12", "-3.11", "-3.10"] {
            candidates.push((PathBuf::from("py.exe"), vec![OsString::from(version)]));
        }
        candidates.push((PathBuf::from("python.exe"), vec![]));
    }
    #[cfg(not(windows))]
    {
        candidates.push((PathBuf::from("python3"), vec![]));
        candidates.push((PathBuf::from("python"), vec![]));
    }
    for (program, prefix) in candidates {
        let mut command = command_for(&program);
        command.args(&prefix).arg("--version").stdout(Stdio::null()).stderr(Stdio::null());
        if command.status().is_ok_and(|status| status.success()) {
            return Ok((program, prefix));
        }
    }
    Err("找不到可用的 Python 3.10 至 3.12。".into())
}

fn ensure_python(log: &Path) -> Result<(PathBuf, Vec<OsString>), String> {
    if let Ok(value) = discover_python() {
        return Ok(value);
    }
    #[cfg(windows)]
    {
        if !command_succeeds(Path::new("winget.exe"), &["--version"]) {
            return Err("找不到 Python，也無法使用 Windows Package Manager 自動安裝。請先安裝官方 Python 3.11。".into());
        }
        append_log(log, "未偵測到相容的 Python，正在透過 Windows Package Manager 安裝 Python 3.11。");
        install_with_winget("Python.Python.3.11", log)?;
        return discover_python().map_err(|_| "Python 已安裝，但目前程序尚未偵測到新環境。請重新啟動 Evolabs 後按「修復」。".into());
    }
    #[cfg(not(windows))]
    Err("找不到可用的 Python 3.10 至 3.12。請先安裝 Python，再按「修復」。".into())
}

fn ensure_git(log: &Path) -> Result<(), String> {
    if command_succeeds(Path::new("git"), &["--version"]) || command_succeeds(Path::new("git.exe"), &["--version"]) {
        return Ok(());
    }
    #[cfg(windows)]
    {
        if command_succeeds(Path::new("winget.exe"), &["--version"]) {
            append_log(log, "未偵測到 Git，正在透過 Windows Package Manager 安裝官方 Git for Windows。");
            install_with_winget("Git.Git", log)?;
            return Ok(());
        }
    }
    Err("找不到 Git。請先安裝 Git for Windows，再按「修復」。".into())
}

fn start_impl(app: &AppHandle) -> Result<(), String> {
    if endpoint_is_ready() {
        let mut status = current_status(app);
        status.state = "running".into();
        status.running = true;
        status.available = true;
        status.progress = 100;
        status.message = "AI 影片引擎已在背景執行。".into();
        status.error = None;
        write_status(app, status);
        return Ok(());
    }
    let root = managed_root(app)?;
    let tool_root = tool_venv_root(app)?;
    let comfy = comfy_executable(&tool_root);
    if !comfy.is_file() || !comfy_root(app)?.join("main.py").is_file() {
        return Err("尚未完成 AI 影片引擎安裝。".into());
    }
    let log = log_path(app)?;
    let arguments = vec![
        OsString::from(format!("--workspace={}", root.to_string_lossy())),
        OsString::from("launch"),
        OsString::from("--background"),
        OsString::from("--"),
        OsString::from("--listen"),
        OsString::from("127.0.0.1"),
        OsString::from("--port"),
        OsString::from("8188"),
        OsString::from("--lowvram"),
        OsString::from("--preview-method"),
        OsString::from("none"),
    ];
    run_logged(&comfy, &arguments, &log, Some(&root))?;
    for _ in 0..90 {
        if endpoint_is_ready() {
            let mut status = current_status(app);
            status.state = "running".into();
            status.running = true;
            status.available = true;
            status.installed = true;
            status.progress = 100;
            status.message = "AI 影片引擎已啟動，並已套用低顯存設定。".into();
            status.error = None;
            write_status(app, status);
            return Ok(());
        }
        thread::sleep(Duration::from_secs(1));
    }
    Err("AI 影片引擎已啟動，但 90 秒內未通過連線檢查。請查看日誌或執行修復。".into())
}

fn install_impl(app: AppHandle, repair: bool) {
    let result = (|| -> Result<(), String> {
        let root = managed_root(&app)?;
        let tool_root = tool_venv_root(&app)?;
        let log = log_path(&app)?;
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        ensure_install_space(&root, repair)?;
        append_log(&log, if repair { "開始修復 AI 影片引擎。" } else { "開始安裝 AI 影片引擎。" });

        let mut status = current_status(&app);
        status.state = if repair { "repairing".into() } else { "installing".into() };
        status.running = false;
        status.available = false;
        status.progress = 5;
        status.message = "正在檢查系統工具與安裝目錄。".into();
        status.error = None;
        write_status(&app, status);

        let (python, prefix) = ensure_python(&log)?;
        ensure_git(&log)?;
        if !venv_python(&tool_root).is_file() {
            let mut arguments = prefix.clone();
            arguments.extend([OsString::from("-m"), OsString::from("venv"), tool_root.as_os_str().to_owned()]);
            run_logged(&python, &arguments, &log, None)?;
        }

        let mut status = current_status(&app);
        status.state = if repair { "repairing".into() } else { "installing".into() };
        status.progress = 24;
        status.message = "正在準備 ComfyUI 管理元件。".into();
        write_status(&app, status);
        let venv_python = venv_python(&tool_root);
        run_logged(
            &venv_python,
            &[
                OsString::from("-m"),
                OsString::from("pip"),
                OsString::from("install"),
                OsString::from("--disable-pip-version-check"),
                OsString::from("--upgrade"),
                OsString::from("pip"),
                OsString::from("comfy-cli"),
            ],
            &log,
            None,
        )?;

        let mut status = current_status(&app);
        status.state = if repair { "repairing".into() } else { "installing".into() };
        status.progress = 48;
        status.message = "正在安裝 ComfyUI 與必要相依套件。".into();
        write_status(&app, status);
        let comfy = comfy_executable(&tool_root);
        run_logged(
            &comfy,
            &[
                OsString::from(format!("--workspace={}", root.to_string_lossy())),
                OsString::from("install"),
                OsString::from("--fast-deps"),
            ],
            &log,
            Some(&root),
        )?;

        let mut status = current_status(&app);
        status.state = "starting".into();
        status.installed = true;
        status.progress = 86;
        status.message = "安裝完成，正在啟動 AI 影片引擎。".into();
        status.error = None;
        write_status(&app, status);
        start_impl(&app)?;
        Ok(())
    })();

    if let Err(error) = result {
        let mut status = current_status(&app);
        status.state = "failed".into();
        status.running = false;
        status.available = false;
        status.message = "AI 影片引擎安裝或修復未完成。".into();
        status.error = Some(error.clone());
        if let Ok(path) = log_path(&app) {
            append_log(&path, &format!("失敗：{error}"));
        }
        write_status(&app, status);
    }
}

#[tauri::command]
pub fn get_managed_comfyui_status(app: AppHandle) -> Result<ManagedComfyUiStatus, String> {
    Ok(current_status(&app))
}

#[tauri::command]
pub fn install_managed_comfyui(app: AppHandle) -> Result<ManagedComfyUiStatus, String> {
    let mut next = current_status(&app);
    if matches!(next.state.as_str(), "installing" | "repairing" | "starting") {
        return Ok(next);
    }
    next.state = "installing".into();
    next.progress = 1;
    next.message = "已建立 AI 影片引擎安裝工作。".into();
    next.error = None;
    write_status(&app, next.clone());
    let worker_app = app.clone();
    thread::spawn(move || install_impl(worker_app, false));
    Ok(next)
}

#[tauri::command]
pub fn repair_managed_comfyui(app: AppHandle) -> Result<ManagedComfyUiStatus, String> {
    let mut next = current_status(&app);
    if matches!(next.state.as_str(), "installing" | "repairing" | "starting") {
        return Ok(next);
    }
    next.state = "repairing".into();
    next.progress = 1;
    next.message = "已建立 AI 影片引擎修復工作。".into();
    next.error = None;
    write_status(&app, next.clone());
    let worker_app = app.clone();
    thread::spawn(move || install_impl(worker_app, true));
    Ok(next)
}

#[tauri::command]
pub fn start_managed_comfyui(app: AppHandle) -> Result<ManagedComfyUiStatus, String> {
    let mut next = current_status(&app);
    if next.running {
        return Ok(next);
    }
    next.state = "starting".into();
    next.progress = 86;
    next.message = "正在啟動 AI 影片引擎。".into();
    next.error = None;
    write_status(&app, next.clone());
    let worker_app = app.clone();
    thread::spawn(move || {
        if let Err(error) = start_impl(&worker_app) {
            let mut failed = current_status(&worker_app);
            failed.state = "failed".into();
            failed.running = false;
            failed.available = false;
            failed.message = "AI 影片引擎啟動失敗。".into();
            failed.error = Some(error);
            write_status(&worker_app, failed);
        }
    });
    Ok(next)
}

pub fn stop_managed_comfyui_for_storage(app: &AppHandle) -> Result<(), String> {
    let root = managed_root(app)?;
    let comfy = comfy_executable(&tool_venv_root(app)?);
    if comfy.is_file() {
        let _ = run_logged(
            &comfy,
            &[
                OsString::from(format!("--workspace={}", root.to_string_lossy())),
                OsString::from("stop"),
            ],
            &log_path(app)?,
            Some(&root),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn stop_managed_comfyui(app: AppHandle) -> Result<ManagedComfyUiStatus, String> {
    stop_managed_comfyui_for_storage(&app)?;
    let mut status = current_status(&app);
    status.state = if status.installed { "idle".into() } else { "not-installed".into() };
    status.running = false;
    status.available = false;
    status.progress = if status.installed { 100 } else { 0 };
    status.message = if status.installed { "AI 影片引擎已停止。".into() } else { "尚未安裝 AI 影片引擎。".into() };
    status.error = None;
    write_status(&app, status.clone());
    Ok(status)
}

fn remove_dir_contents_except(directory: &Path, preserved_name: &str) -> Result<(), String> {
    if !directory.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name() == preserved_name {
            continue;
        }
        remove_path(&entry.path())?;
    }
    Ok(())
}

#[tauri::command]
pub fn uninstall_managed_comfyui(app: AppHandle, preserve_models: bool) -> Result<ManagedComfyUiActionResult, String> {
    let _ = stop_managed_comfyui_for_storage(&app);
    let root = managed_root(&app)?;
    let before = directory_size(&root);
    if preserve_models {
        let comfy = comfy_root(&app)?;
        remove_dir_contents_except(&comfy, "models")?;
        for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry.file_name() == "ComfyUI" {
                continue;
            }
            remove_path(&entry.path())?;
        }
    } else {
        remove_path(&root)?;
    }
    let after = directory_size(&root);
    let status = initial_status(Some(&app));
    write_status(&app, status);
    Ok(ManagedComfyUiActionResult {
        ok: true,
        message: if preserve_models {
            "AI 影片引擎已解除安裝；影片模型檔案已保留。".into()
        } else {
            "AI 影片引擎與其模型已全部移除。".into()
        },
        freed_bytes: before.saturating_sub(after),
    })
}
