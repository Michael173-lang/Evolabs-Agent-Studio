use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use sysinfo::Disks;
use tauri::{AppHandle, Manager};

const MAX_SCAN_ENTRIES: usize = 100_000;
const MODEL_EXTENSIONS: &[&str] = &["safetensors", "ckpt", "gguf", "pt", "pth", "bin", "onnx"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageItem {
    id: String,
    name: String,
    description: String,
    kind: String,
    path: String,
    bytes: u64,
    file_count: u64,
    removable: bool,
    active: bool,
    legacy: bool,
    version: Option<String>,
    modified_at: Option<String>,
    warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOverview {
    root_path: String,
    drive_name: String,
    drive_total_bytes: u64,
    drive_free_bytes: u64,
    evolabs_bytes: u64,
    model_bytes: u64,
    cache_bytes: u64,
    output_bytes: u64,
    temporary_bytes: u64,
    scanned_at: String,
    truncated: bool,
    items: Vec<StorageItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCleanupResult {
    message: String,
    freed_bytes: u64,
    overview: StorageOverview,
}

#[derive(Default)]
struct ScanStats {
    bytes: u64,
    files: u64,
    entries: usize,
    modified: Option<SystemTime>,
    truncated: bool,
}

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map_err(|error| error.to_string())
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
        && value != "."
        && value != ".."
}

fn safe_relative(path: &Path) -> bool {
    path.components().all(|component| matches!(component, Component::Normal(_)))
}

fn modified_iso(value: Option<SystemTime>) -> Option<String> {
    value.and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|duration| {
        // JavaScript can parse this stable UTC timestamp even without a chrono dependency.
        duration.as_secs().to_string()
    })
}

fn scan_path(path: &Path, stats: &mut ScanStats) -> Result<(), String> {
    if stats.entries >= MAX_SCAN_ENTRIES {
        stats.truncated = true;
        return Ok(());
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    stats.entries += 1;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if let Ok(modified) = metadata.modified() {
        stats.modified = Some(stats.modified.map_or(modified, |current| current.max(modified)));
    }
    if metadata.is_file() {
        stats.files = stats.files.saturating_add(1);
        stats.bytes = stats.bytes.saturating_add(metadata.len());
        return Ok(());
    }
    if !metadata.is_dir() {
        return Ok(());
    }
    let entries = match fs::read_dir(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            stats.truncated = true;
            return Ok(());
        }
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        if stats.entries >= MAX_SCAN_ENTRIES {
            stats.truncated = true;
            break;
        }
        let entry = entry.map_err(|error| error.to_string())?;
        scan_path(&entry.path(), stats)?;
    }
    Ok(())
}

fn stats_for(path: &Path) -> ScanStats {
    let mut stats = ScanStats::default();
    if scan_path(path, &mut stats).is_err() {
        stats.truncated = true;
    }
    stats
}

fn item(
    id: String,
    name: String,
    description: String,
    kind: &str,
    path: &Path,
    removable: bool,
    active: bool,
    legacy: bool,
    version: Option<String>,
    warning: Option<String>,
) -> StorageItem {
    let stats = stats_for(path);
    StorageItem {
        id,
        name,
        description,
        kind: kind.into(),
        path: path.to_string_lossy().to_string(),
        bytes: stats.bytes,
        file_count: stats.files,
        removable,
        active,
        legacy,
        version,
        modified_at: modified_iso(stats.modified),
        warning,
    }
}

fn active_model_version(pack_root: &Path, pack_id: &str) -> Option<String> {
    let current = fs::read(pack_root.join("current.json")).ok()?;
    let value: Value = serde_json::from_slice(&current).ok()?;
    if value.get("id").and_then(Value::as_str) != Some(pack_id) {
        return None;
    }
    value
        .get("version")
        .and_then(Value::as_str)
        .filter(|version| valid_component(version))
        .map(str::to_string)
}

fn scan_model_versions(models_root: &Path, items: &mut Vec<StorageItem>) {
    let Ok(packs) = fs::read_dir(models_root) else { return; };
    for pack in packs.flatten() {
        let Ok(metadata) = pack.metadata() else { continue; };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let pack_id = pack.file_name().to_string_lossy().to_string();
        if !valid_component(&pack_id) {
            continue;
        }
        let pack_root = pack.path();
        let active_version = active_model_version(&pack_root, &pack_id);
        let Ok(versions) = fs::read_dir(&pack_root) else { continue; };
        for version in versions.flatten() {
            let Ok(metadata) = version.metadata() else { continue; };
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                continue;
            }
            let version_name = version.file_name().to_string_lossy().to_string();
            if !valid_component(&version_name) || version_name.starts_with('.') {
                continue;
            }
            let active = active_version.as_deref() == Some(version_name.as_str());
            items.push(item(
                format!("model-version:{pack_id}:{version_name}"),
                format!("{pack_id} {version_name}"),
                if active { "目前啟用的參考圖／動態漫畫模型版本。" } else { "未啟用的舊模型版本；刪除前請確認舊專案不再使用此版本。" }.into(),
                "legacy-model",
                &version.path(),
                true,
                active,
                !active,
                Some(version_name),
                active.then(|| "解除安裝目前版本後，使用此模型的動態漫畫或參考圖功能將暫停。".into()),
            ));
        }
    }
}

fn scan_comfy_models(comfy_root: &Path, items: &mut Vec<StorageItem>) {
    let models_root = comfy_root.join("ComfyUI").join("models");
    if !models_root.is_dir() {
        return;
    }
    let mut stack = vec![models_root.clone()];
    let mut visited = 0_usize;
    while let Some(directory) = stack.pop() {
        if visited >= MAX_SCAN_ENTRIES {
            break;
        }
        let Ok(entries) = fs::read_dir(&directory) else { continue; };
        for entry in entries.flatten() {
            visited += 1;
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else { continue; };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
            if !MODEL_EXTENSIONS.contains(&extension.as_str()) {
                continue;
            }
            let Ok(relative) = path.strip_prefix(&models_root) else { continue; };
            if !safe_relative(relative) {
                continue;
            }
            let encoded = URL_SAFE_NO_PAD.encode(relative.to_string_lossy().as_bytes());
            let name = path.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_else(|| "影片模型".into());
            items.push(item(
                format!("comfy-model:{encoded}"),
                name,
                format!("ComfyUI 模型檔案：{}", relative.display()),
                "video-model",
                &path,
                true,
                true,
                false,
                None,
                Some("刪除此檔案後，依賴它的 ComfyUI 工作流將無法執行。".into()),
            ));
        }
    }
}

fn fixed_items(root: &Path, items: &mut Vec<StorageItem>) {
    let engine = root.join("engine");
    let managed_comfy = root.join("managed").join("comfyui");
    let managed_workspace = managed_comfy.join("ComfyUI");
    let definitions = [
        ("downloads", "下載快取", "已完成或未完成的模型與元件下載檔案。", "download-cache", engine.join("downloads"), true, false),
        ("engine-cache", "生成快取", "可重新建立的生成與參考圖快取。", "render-cache", engine.join("cache"), true, false),
        ("outputs", "生成輸出", "Evolabs 產生的影片、預覽與工作輸出。", "render-output", engine.join("outputs"), true, false),
        ("jobs", "工作暫存", "已完成或中斷的生成工作資料。", "temporary", engine.join("jobs"), true, false),
        ("installs", "安裝暫存", "模型安裝程序的狀態與紀錄。", "temporary", engine.join("installs"), true, false),
        ("references", "角色參考圖", "專案匯入的角色身份參考素材。", "reference", root.join("assets").join("references"), true, false),
        ("comfy-output", "ComfyUI 輸出", "由受管理 ComfyUI 產生的影片與預覽。", "render-output", managed_workspace.join("output"), true, false),
        ("comfy-temp", "ComfyUI 暫存", "ComfyUI 可重新建立的暫存資料。", "temporary", managed_workspace.join("temp"), true, false),
        ("managed-comfyui", "AI 影片引擎", "Evolabs 管理的 ComfyUI Portable 執行環境。", "managed-runtime", managed_comfy.clone(), true, true),
    ];
    for (id, name, description, kind, path, removable, active) in definitions {
        if path.exists() {
            let warning = match id {
                "outputs" | "comfy-output" => Some("刪除後無法從 Evolabs 復原這些影片或預覽。".into()),
                "references" => Some("使用這些參考圖的專案需要重新匯入素材。".into()),
                "managed-comfyui" => Some("解除安裝 AI 影片引擎不會自動刪除獨立列出的影片模型；解除安裝前會先停止執行中的引擎。".into()),
                _ => None,
            };
            items.push(item(id.into(), name.into(), description.into(), kind, &path, removable, active, false, None, warning));
        }
    }
}

fn drive_for(path: &Path) -> (String, u64, u64) {
    let disks = Disks::new_with_refreshed_list();
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let best = disks
        .iter()
        .filter(|disk| canonical.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count());
    best.map(|disk| (
        disk.name().to_string_lossy().to_string(),
        disk.total_space(),
        disk.available_space(),
    )).unwrap_or_else(|| ("目前磁碟".into(), 0, 0))
}

#[tauri::command]
pub fn get_storage_overview(app: AppHandle) -> Result<StorageOverview, String> {
    let root = app_data(&app)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let mut items = Vec::new();
    scan_model_versions(&root.join("engine").join("models"), &mut items);
    scan_comfy_models(&root.join("managed").join("comfyui"), &mut items);
    fixed_items(&root, &mut items);
    items.sort_by(|left, right| right.bytes.cmp(&left.bytes).then_with(|| left.name.cmp(&right.name)));

    let root_stats = stats_for(&root);
    let (drive_name, drive_total_bytes, drive_free_bytes) = drive_for(&root);
    let model_bytes = items.iter().filter(|item| matches!(item.kind.as_str(), "video-model" | "legacy-model")).map(|item| item.bytes).sum();
    let cache_bytes = items.iter().filter(|item| matches!(item.kind.as_str(), "download-cache" | "render-cache")).map(|item| item.bytes).sum();
    let output_bytes = items.iter().filter(|item| item.kind == "render-output").map(|item| item.bytes).sum();
    let temporary_bytes = items.iter().filter(|item| item.kind == "temporary").map(|item| item.bytes).sum();
    Ok(StorageOverview {
        root_path: root.to_string_lossy().to_string(),
        drive_name,
        drive_total_bytes,
        drive_free_bytes,
        evolabs_bytes: root_stats.bytes,
        model_bytes,
        cache_bytes,
        output_bytes,
        temporary_bytes,
        scanned_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().to_string(),
        truncated: root_stats.truncated,
        items,
    })
}

fn remove_path(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("基於安全考量，Evolabs 不會刪除符號連結。".into());
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else if metadata.is_file() {
        fs::remove_file(path).map_err(|error| error.to_string())
    } else {
        Err("選取的儲存項目不是一般檔案或資料夾。".into())
    }
}

fn fixed_path(root: &Path, id: &str) -> Option<PathBuf> {
    let engine = root.join("engine");
    let comfy = root.join("managed").join("comfyui");
    let workspace = comfy.join("ComfyUI");
    match id {
        "downloads" => Some(engine.join("downloads")),
        "engine-cache" => Some(engine.join("cache")),
        "outputs" => Some(engine.join("outputs")),
        "jobs" => Some(engine.join("jobs")),
        "installs" => Some(engine.join("installs")),
        "references" => Some(root.join("assets").join("references")),
        "comfy-output" => Some(workspace.join("output")),
        "comfy-temp" => Some(workspace.join("temp")),
        "managed-comfyui" => Some(comfy),
        _ => None,
    }
}

fn resolve_item(root: &Path, id: &str) -> Result<(PathBuf, String, bool), String> {
    if let Some(path) = fixed_path(root, id) {
        let name = match id {
            "downloads" => "下載快取",
            "engine-cache" => "生成快取",
            "outputs" => "生成輸出",
            "jobs" => "工作暫存",
            "installs" => "安裝暫存",
            "references" => "角色參考圖",
            "comfy-output" => "ComfyUI 輸出",
            "comfy-temp" => "ComfyUI 暫存",
            "managed-comfyui" => "AI 影片引擎",
            _ => "儲存項目",
        };
        return Ok((path, name.into(), id == "managed-comfyui"));
    }
    if let Some(rest) = id.strip_prefix("model-version:") {
        let mut parts = rest.split(':');
        let pack = parts.next().unwrap_or_default();
        let version = parts.next().unwrap_or_default();
        if parts.next().is_some() || !valid_component(pack) || !valid_component(version) {
            return Err("模型版本識別碼無效。".into());
        }
        return Ok((root.join("engine").join("models").join(pack).join(version), format!("{pack} {version}"), false));
    }
    if let Some(encoded) = id.strip_prefix("comfy-model:") {
        let decoded = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| "影片模型識別碼無效。".to_string())?;
        let relative = PathBuf::from(String::from_utf8(decoded).map_err(|_| "影片模型路徑無效。".to_string())?);
        if !safe_relative(&relative) {
            return Err("影片模型路徑不在允許範圍。".into());
        }
        let path = root.join("managed").join("comfyui").join("ComfyUI").join("models").join(&relative);
        let name = path.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_else(|| "影片模型".into());
        return Ok((path, name, true));
    }
    Err("不支援的儲存項目。".into())
}

#[tauri::command]
pub fn remove_storage_item(app: AppHandle, item_id: String, confirmation: String) -> Result<StorageOverview, String> {
    let root = app_data(&app)?;
    let (path, expected_name, stop_comfy) = resolve_item(&root, item_id.trim())?;
    if confirmation.trim() != expected_name {
        return Err(format!("請輸入「{expected_name}」以確認刪除。"));
    }
    if !path.exists() {
        return get_storage_overview(app);
    }
    if stop_comfy {
        let _ = crate::comfyui_manager::stop_managed_comfyui_for_storage(&app);
    }
    // When the currently active version is removed, remove its activation file as well.
    if let Some(rest) = item_id.strip_prefix("model-version:") {
        let mut parts = rest.split(':');
        let pack = parts.next().unwrap_or_default();
        let version = parts.next().unwrap_or_default();
        let pack_root = root.join("engine").join("models").join(pack);
        if active_model_version(&pack_root, pack).as_deref() == Some(version) {
            let _ = fs::remove_file(pack_root.join("current.json"));
        }
    }
    remove_path(&path)?;
    get_storage_overview(app)
}

#[tauri::command]
pub fn remove_old_model_versions(app: AppHandle, confirmation: String) -> Result<StorageCleanupResult, String> {
    if confirmation.trim() != "清除舊版本" {
        return Err("請確認要清除所有未啟用的舊模型版本。".into());
    }
    let root = app_data(&app)?;
    let models_root = root.join("engine").join("models");
    let mut freed_bytes = 0_u64;
    let Ok(packs) = fs::read_dir(&models_root) else {
        return Ok(StorageCleanupResult {
            message: "目前沒有可清除的舊模型版本。".into(),
            freed_bytes: 0,
            overview: get_storage_overview(app)?,
        });
    };
    for pack in packs.flatten() {
        let Ok(metadata) = fs::symlink_metadata(pack.path()) else { continue; };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let pack_id = pack.file_name().to_string_lossy().to_string();
        if !valid_component(&pack_id) {
            continue;
        }
        let pack_root = pack.path();
        let active_version = active_model_version(&pack_root, &pack_id);
        let Ok(versions) = fs::read_dir(&pack_root) else { continue; };
        for version in versions.flatten() {
            let version_name = version.file_name().to_string_lossy().to_string();
            if !valid_component(&version_name) || active_version.as_deref() == Some(version_name.as_str()) {
                continue;
            }
            let path = version.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                continue;
            }
            let before = stats_for(&path).bytes;
            remove_path(&path)?;
            freed_bytes = freed_bytes.saturating_add(before);
        }
    }
    Ok(StorageCleanupResult {
        message: if freed_bytes > 0 {
            "未啟用的舊模型版本已清除。".into()
        } else {
            "目前沒有可清除的舊模型版本。".into()
        },
        freed_bytes,
        overview: get_storage_overview(app)?,
    })
}

#[tauri::command]
pub fn reveal_storage_item(app: AppHandle, item_id: String) -> Result<(), String> {
    let root = app_data(&app)?;
    let (path, _, _) = resolve_item(&root, item_id.trim())?;
    let target = if path.exists() { path } else { path.parent().unwrap_or(&root).to_path_buf() };
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(&target)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(&target).spawn().map_err(|error| error.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(&target).spawn().map_err(|error| error.to_string())?;
    }
    Ok(())
}
