use reqwest::{Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::Write,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const CONFIG_FILE: &str = "video-provider.json";
const MAX_WORKFLOW_BYTES: usize = 12 * 1024 * 1024;
const MAX_OBJECT_INFO_BYTES: usize = 32 * 1024 * 1024;
const MAX_NODES: usize = 2_048;
const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:8188";

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoProviderCapabilities {
    text_to_video: bool,
    image_to_video: bool,
    output_video: bool,
    prompt_binding: bool,
    negative_prompt_binding: bool,
    seed_binding: bool,
    dimensions_binding: bool,
    frame_binding: bool,
    fps_binding: bool,
    input_image_binding: bool,
    output_prefix_binding: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProviderStatus {
    configured: bool,
    available: bool,
    provider_id: Option<String>,
    kind: Option<String>,
    name: Option<String>,
    endpoint: Option<String>,
    workflow_name: Option<String>,
    workflow_valid: bool,
    node_count: usize,
    capabilities: VideoProviderCapabilities,
    detected_models: Vec<String>,
    compatibility: String,
    message: String,
    last_verified_at: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProviderConfig {
    schema_version: u64,
    provider_id: String,
    kind: String,
    name: String,
    endpoint: String,
    workflow_name: String,
    workflow: Value,
    saved_at_unix_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureComfyUiRequest {
    endpoint: Option<String>,
    workflow_name: String,
    workflow: Value,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|root| root.join(CONFIG_FILE))
        .map_err(|error| format!("無法取得 Evolabs 設定目錄：{error}"))
}

fn normalize_endpoint(raw: Option<&str>) -> Result<String, String> {
    let value = raw.unwrap_or(DEFAULT_ENDPOINT).trim().trim_end_matches('/');
    let parsed = Url::parse(value).map_err(|error| format!("ComfyUI 位址格式無效：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("ComfyUI 位址必須使用 HTTP 或 HTTPS。".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("ComfyUI 位址不得包含帳號或密碼。".into());
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1") {
        return Err("本機影片模型服務只允許連接這台電腦上的 ComfyUI。".into());
    }
    if !matches!(parsed.path(), "" | "/") || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("ComfyUI 位址只能包含通訊協定、主機名稱與連接埠。".into());
    }
    Ok(value.to_string())
}

fn load_config(app: &AppHandle) -> Result<Option<StoredProviderConfig>, String> {
    let path = config_path(app)?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("無法讀取影片模型服務設定：{error}")),
    };
    if bytes.len() > MAX_WORKFLOW_BYTES + 64 * 1024 {
        return Err("影片模型服務設定檔超過安全大小限制。".into());
    }
    let config: StoredProviderConfig = serde_json::from_slice(&bytes)
        .map_err(|error| format!("影片模型服務設定檔損壞：{error}"))?;
    if config.schema_version != 1 || config.provider_id != "comfyui-local" || config.kind != "comfyui" {
        return Err("影片模型服務設定版本不受支援。".into());
    }
    Ok(Some(config))
}

fn write_config(app: &AppHandle, config: &StoredProviderConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "影片模型服務設定路徑無效。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("無法建立設定目錄：{error}"))?;
    let encoded = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_WORKFLOW_BYTES + 64 * 1024 {
        return Err("影片工作流超過 12 MB 安全上限。".into());
    }

    let temporary = path.with_extension(format!("json.{}.tmp", now_millis()));
    {
        let mut file = File::create(&temporary)
            .map_err(|error| format!("無法建立影片模型服務暫存設定：{error}"))?;
        file.write_all(&encoded)
            .map_err(|error| format!("無法寫入影片模型服務設定：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("無法同步影片模型服務設定：{error}"))?;
    }

    if let Err(first_error) = fs::rename(&temporary, &path) {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("無法取代舊的影片模型服務設定：{first_error}；{error}"))?;
            fs::rename(&temporary, &path)
                .map_err(|error| format!("無法提交影片模型服務設定：{error}"))?;
        } else {
            let _ = fs::remove_file(&temporary);
            return Err(format!("無法提交影片模型服務設定：{first_error}"));
        }
    }
    Ok(())
}

fn workflow_nodes(workflow: &Value) -> Result<&Map<String, Value>, String> {
    workflow
        .as_object()
        .filter(|nodes| !nodes.is_empty() && nodes.len() <= MAX_NODES)
        .ok_or_else(|| "請匯入 ComfyUI 的 API 格式工作流；節點數必須介於 1 到 2048。".to_string())
}

fn workflow_class_types(workflow: &Value) -> Result<BTreeSet<String>, String> {
    let nodes = workflow_nodes(workflow)?;
    let mut class_types = BTreeSet::new();
    for (node_id, node) in nodes {
        let object = node
            .as_object()
            .ok_or_else(|| format!("工作流節點 {node_id} 不是有效物件。"))?;
        let class_type = object
            .get("class_type")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.chars().count() <= 240 && !value.chars().any(char::is_control))
            .ok_or_else(|| format!("工作流節點 {node_id} 缺少有效的 class_type。"))?;
        if !object.get("inputs").is_some_and(Value::is_object) {
            return Err(format!("工作流節點 {node_id} 缺少 inputs 物件。"));
        }
        class_types.insert(class_type.to_string());
    }
    Ok(class_types)
}

fn collect_strings(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::String(text) => output.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|item| collect_strings(item, output)),
        Value::Object(map) => map.values().for_each(|item| collect_strings(item, output)),
        _ => {}
    }
}

fn workflow_input_strings(workflow: &Value) -> Result<Vec<String>, String> {
    let nodes = workflow_nodes(workflow)?;
    let mut strings = Vec::new();
    for node in nodes.values() {
        let inputs = node
            .get("inputs")
            .and_then(Value::as_object)
            .ok_or_else(|| "影片工作流節點缺少 inputs 物件。".to_string())?;
        inputs.values().for_each(|value| collect_strings(value, &mut strings));
    }
    Ok(strings)
}

fn is_video_output_class(class_type: &str) -> bool {
    let normalized = class_type.to_ascii_lowercase().replace('-', "").replace(' ', "");
    let output_action = ["save", "output", "combine", "export", "encode", "writer"]
        .iter()
        .any(|marker| normalized.contains(marker));
    if normalized.contains("load") && !output_action {
        return false;
    }
    [
        "vhs_videocombine",
        "videocombine",
        "savevideo",
        "videosave",
        "videosaver",
        "videooutput",
        "outputvideo",
        "exportvideo",
        "videoexport",
        "encodevideo",
        "videowriter",
        "ffmpegoutput",
        "saveanimated",
        "animatedwebp",
        "savegif",
        "savewebm",
        "savemp4",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn analyze_workflow(workflow: &Value) -> Result<(usize, VideoProviderCapabilities, Vec<String>), String> {
    let nodes = workflow_nodes(workflow)?;
    let class_types = workflow_class_types(workflow)?;
    let encoded = serde_json::to_string(workflow).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_WORKFLOW_BYTES {
        return Err("影片工作流超過 12 MB 安全上限。".into());
    }

    let input_strings = workflow_input_strings(workflow)?;
    let inputs_text = input_strings.join("\n");
    let prompt_binding = inputs_text.contains("{{EVOLABS_PROMPT}}");
    let negative_prompt_binding = inputs_text.contains("{{EVOLABS_NEGATIVE_PROMPT}}");
    let seed_binding = inputs_text.contains("{{EVOLABS_SEED}}");
    let dimensions_binding = inputs_text.contains("{{EVOLABS_WIDTH}}") && inputs_text.contains("{{EVOLABS_HEIGHT}}");
    let frame_binding = inputs_text.contains("{{EVOLABS_FRAMES}}");
    let fps_binding = inputs_text.contains("{{EVOLABS_FPS}}");
    let input_image_binding = inputs_text.contains("{{EVOLABS_INPUT_IMAGE}}");
    let output_prefix_binding = inputs_text.contains("{{EVOLABS_OUTPUT_PREFIX}}");
    let output_video = class_types.iter().any(|class_type| is_video_output_class(class_type));

    if !output_video {
        return Err("工作流沒有可辨識的影片輸出節點。請匯入能輸出 MP4、WebM 或動畫序列的 ComfyUI API 工作流。".into());
    }
    let missing = [
        (prompt_binding, "{{EVOLABS_PROMPT}}"),
        (negative_prompt_binding, "{{EVOLABS_NEGATIVE_PROMPT}}"),
        (seed_binding, "{{EVOLABS_SEED}}"),
        (frame_binding, "{{EVOLABS_FRAMES}}"),
        (fps_binding, "{{EVOLABS_FPS}}"),
        (output_prefix_binding, "{{EVOLABS_OUTPUT_PREFIX}}"),
    ]
    .into_iter()
    .filter_map(|(present, label)| (!present).then_some(label))
    .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!(
            "工作流缺少 Evolabs 必要綁定：{}。這些欄位用於安全限制、重試、輸出隔離與鏡頭時長控制。",
            missing.join("、")
        ));
    }

    let mut strings = Vec::new();
    collect_strings(workflow, &mut strings);
    let mut models = BTreeSet::new();
    for text in strings {
        let trimmed = text.trim();
        let normalized = trimmed.to_ascii_lowercase();
        if normalized.ends_with(".safetensors")
            || normalized.ends_with(".gguf")
            || normalized.ends_with(".ckpt")
            || normalized.ends_with(".pt")
            || normalized.ends_with(".pth")
        {
            models.insert(trimmed.to_string());
        }
    }

    Ok((
        nodes.len(),
        VideoProviderCapabilities {
            text_to_video: !input_image_binding,
            image_to_video: input_image_binding,
            output_video,
            prompt_binding,
            negative_prompt_binding,
            seed_binding,
            dimensions_binding,
            frame_binding,
            fps_binding,
            input_image_binding,
            output_prefix_binding,
        },
        models.into_iter().take(64).collect(),
    ))
}

fn compatibility_from_stats(stats: &Value) -> String {
    let mut vram_values = Vec::new();
    if let Some(devices) = stats.pointer("/devices").and_then(Value::as_array) {
        for device in devices {
            for key in ["vram_total", "vramTotal", "total_memory", "totalMemory"] {
                if let Some(value) = device.get(key).and_then(Value::as_u64) {
                    vram_values.push(value);
                }
            }
        }
    }
    let maximum = vram_values.into_iter().max().unwrap_or(0);
    if maximum == 0 {
        "unknown".into()
    } else if maximum < 12 * 1024 * 1024 * 1024 {
        "experimental".into()
    } else {
        "recommended".into()
    }
}

async fn bounded_json(response: Response, limit: usize, label: &str) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(format!("{label}回傳 HTTP {}。", response.status()));
    }
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return Err(format!("{label}回應超過安全大小限制。"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("無法讀取{label}回應：{error}"))?;
    if bytes.len() > limit {
        return Err(format!("{label}回應超過安全大小限制。"));
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("{label}格式無法辨識：{error}"))
}

fn validate_registered_nodes(workflow: &Value, object_info: &Value) -> Result<(), String> {
    let available = object_info
        .as_object()
        .ok_or_else(|| "ComfyUI 節點清單格式無法辨識。".to_string())?;
    let required = workflow_class_types(workflow)?;
    let missing = required
        .iter()
        .filter(|class_type| !available.contains_key(class_type.as_str()))
        .take(20)
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!(
            "ComfyUI 缺少工作流所需節點：{}。請安裝對應自訂節點後重新驗證。",
            missing.join("、")
        ));
    }
    Ok(())
}

async fn probe_config(config: &StoredProviderConfig) -> Result<VideoProviderStatus, String> {
    let (node_count, capabilities, detected_models) = analyze_workflow(&config.workflow)?;
    let endpoint = normalize_endpoint(Some(&config.endpoint))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| error.to_string())?;

    let stats = bounded_json(
        client
            .get(format!("{endpoint}/system_stats"))
            .send()
            .await
            .map_err(|error| format!("無法連線至 ComfyUI：{error}"))?,
        2 * 1024 * 1024,
        "ComfyUI 系統狀態",
    )
    .await?;
    let object_info = bounded_json(
        client
            .get(format!("{endpoint}/object_info"))
            .send()
            .await
            .map_err(|error| format!("無法讀取 ComfyUI 節點清單：{error}"))?,
        MAX_OBJECT_INFO_BYTES,
        "ComfyUI 節點清單",
    )
    .await?;
    validate_registered_nodes(&config.workflow, &object_info)?;

    let compatibility = compatibility_from_stats(&stats);
    let dimensions_note = if capabilities.dimensions_binding {
        "解析度可由 Evolabs 控制。"
    } else {
        "工作流使用固定解析度；請確認該設定符合目前硬體。"
    };
    Ok(VideoProviderStatus {
        configured: true,
        available: true,
        provider_id: Some(config.provider_id.clone()),
        kind: Some(config.kind.clone()),
        name: Some(config.name.clone()),
        endpoint: Some(endpoint),
        workflow_name: Some(config.workflow_name.clone()),
        workflow_valid: true,
        node_count,
        capabilities,
        detected_models,
        compatibility: compatibility.clone(),
        message: if compatibility == "experimental" {
            format!(
                "ComfyUI 與全部必要節點已通過驗證。這台電腦屬於低顯示記憶體實驗路徑；實際可用性取決於影片模型與工作流。{dimensions_note}"
            )
        } else {
            format!("ComfyUI 與全部必要節點已通過驗證。{dimensions_note}")
        },
        last_verified_at: Some(now_millis().to_string()),
        error: None,
    })
}

fn unconfigured_status(message: String, error: Option<String>) -> VideoProviderStatus {
    VideoProviderStatus {
        configured: false,
        available: false,
        provider_id: None,
        kind: None,
        name: None,
        endpoint: None,
        workflow_name: None,
        workflow_valid: false,
        node_count: 0,
        capabilities: VideoProviderCapabilities::default(),
        detected_models: vec![],
        compatibility: "unknown".into(),
        message,
        last_verified_at: None,
        error,
    }
}

#[tauri::command]
pub async fn get_video_provider_status(app: AppHandle) -> Result<VideoProviderStatus, String> {
    let config = match load_config(&app) {
        Ok(Some(config)) => config,
        Ok(None) => {
            return Ok(unconfigured_status(
                "尚未設定真正的影片模型服務。請連接本機 ComfyUI 並匯入 API 格式工作流。".into(),
                None,
            ));
        }
        Err(error) => {
            return Ok(unconfigured_status(
                "影片模型服務設定無法讀取。".into(),
                Some(error),
            ));
        }
    };
    match probe_config(&config).await {
        Ok(status) => Ok(status),
        Err(error) => {
            let (node_count, capabilities, detected_models) = analyze_workflow(&config.workflow)
                .unwrap_or((0, VideoProviderCapabilities::default(), vec![]));
            Ok(VideoProviderStatus {
                configured: true,
                available: false,
                provider_id: Some(config.provider_id),
                kind: Some(config.kind),
                name: Some(config.name),
                endpoint: Some(config.endpoint),
                workflow_name: Some(config.workflow_name),
                workflow_valid: node_count > 0,
                node_count,
                capabilities,
                detected_models,
                compatibility: "unknown".into(),
                message: "影片模型服務已設定，但尚未通過連線與節點驗證。".into(),
                last_verified_at: None,
                error: Some(error),
            })
        }
    }
}

#[tauri::command]
pub async fn configure_comfyui_provider(
    app: AppHandle,
    request: ConfigureComfyUiRequest,
) -> Result<VideoProviderStatus, String> {
    let endpoint = normalize_endpoint(request.endpoint.as_deref())?;
    let workflow_name = request.workflow_name.trim();
    if workflow_name.is_empty()
        || workflow_name.chars().count() > 240
        || workflow_name.chars().any(char::is_control)
    {
        return Err("工作流名稱格式無效。".into());
    }
    analyze_workflow(&request.workflow)?;
    let config = StoredProviderConfig {
        schema_version: 1,
        provider_id: "comfyui-local".into(),
        kind: "comfyui".into(),
        name: "本機 ComfyUI 影片模型服務".into(),
        endpoint,
        workflow_name: workflow_name.to_string(),
        workflow: request.workflow,
        saved_at_unix_ms: now_millis(),
    };
    let status = probe_config(&config).await?;
    write_config(&app, &config)?;
    Ok(status)
}

#[tauri::command]
pub async fn clear_video_provider(app: AppHandle) -> Result<Value, String> {
    let path = config_path(&app)?;
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("無法清除影片模型服務設定：{error}")),
    }
    Ok(json!({"ok": true}))
}

pub async fn validated_provider_snapshot(app: &AppHandle) -> Result<Value, String> {
    let config = load_config(app)?.ok_or_else(|| {
        "AI 影片模式尚未設定真正的影片模型服務。請先連接本機 ComfyUI 並匯入 API 格式工作流。".to_string()
    })?;
    let status = probe_config(&config).await?;
    if !status.available || !status.workflow_valid {
        return Err(status.error.unwrap_or(status.message));
    }
    Ok(json!({
        "providerId": config.provider_id,
        "kind": config.kind,
        "name": config.name,
        "endpoint": config.endpoint,
        "workflowName": config.workflow_name,
        "workflow": config.workflow,
        "verifiedAtUnixMs": now_millis(),
        "capabilities": status.capabilities,
        "detectedModels": status.detected_models,
    }))
}

#[cfg(test)]
mod tests {
    use super::{analyze_workflow, is_video_output_class, normalize_endpoint, validate_registered_nodes};
    use serde_json::json;

    fn valid_workflow() -> serde_json::Value {
        json!({
            "1": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": "{{EVOLABS_PROMPT}} {{EVOLABS_NEGATIVE_PROMPT}}",
                    "seed": "{{EVOLABS_SEED}}"
                }
            },
            "2": {
                "class_type": "VHS_VideoCombine",
                "inputs": {
                    "frame_rate": "{{EVOLABS_FPS}}",
                    "frames": "{{EVOLABS_FRAMES}}",
                    "filename_prefix": "{{EVOLABS_OUTPUT_PREFIX}}"
                }
            }
        })
    }

    #[test]
    fn endpoint_must_be_loopback() {
        assert!(normalize_endpoint(Some("http://127.0.0.1:8188")).is_ok());
        assert!(normalize_endpoint(Some("https://example.com")).is_err());
        assert!(normalize_endpoint(Some("http://localhost:8188/api")).is_err());
    }

    #[test]
    fn workflow_requires_control_bindings_and_video_output() {
        let workflow = valid_workflow();
        let (_, capabilities, _) = analyze_workflow(&workflow).unwrap();
        assert!(capabilities.prompt_binding);
        assert!(capabilities.negative_prompt_binding);
        assert!(capabilities.output_video);
        assert!(capabilities.output_prefix_binding);
        assert!(analyze_workflow(&json!({
            "1": {"class_type": "SaveImage", "inputs": {"text": "{{EVOLABS_PROMPT}}"}}
        }))
        .is_err());
    }

    #[test]
    fn input_video_nodes_cannot_masquerade_as_video_outputs() {
        assert!(!is_video_output_class("LoadVideo"));
        assert!(!is_video_output_class("VideoLoader"));
        assert!(is_video_output_class("VHS_VideoCombine"));
        assert!(is_video_output_class("SaveVideo"));
        assert!(is_video_output_class("VideoSaver"));
        assert!(analyze_workflow(&json!({
            "1": {
                "class_type": "LoadVideo",
                "inputs": {
                    "prompt": "{{EVOLABS_PROMPT}} {{EVOLABS_NEGATIVE_PROMPT}}",
                    "seed": "{{EVOLABS_SEED}}",
                    "frames": "{{EVOLABS_FRAMES}}",
                    "fps": "{{EVOLABS_FPS}}",
                    "video": "input-reference.mp4"
                }
            }
        })).is_err());
    }


    #[test]
    fn bindings_in_node_metadata_do_not_count_as_runtime_inputs() {
        let mut workflow = valid_workflow();
        workflow["2"]["inputs"].as_object_mut().unwrap().remove("filename_prefix");
        workflow["2"]["_meta"] = json!({"note": "{{EVOLABS_OUTPUT_PREFIX}}"});
        assert!(analyze_workflow(&workflow).is_err());
    }

    #[test]
    fn workflow_nodes_must_exist_in_comfyui_registry() {
        let workflow = valid_workflow();
        let registry = json!({
            "CLIPTextEncode": {},
            "VHS_VideoCombine": {}
        });
        assert!(validate_registered_nodes(&workflow, &registry).is_ok());
        assert!(validate_registered_nodes(&workflow, &json!({"CLIPTextEncode": {}})).is_err());
    }
}
