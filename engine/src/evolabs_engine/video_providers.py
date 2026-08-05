from __future__ import annotations

import copy
import json
import mimetypes
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


MAX_WORKFLOW_BYTES = 12 * 1024 * 1024
MAX_NODES = 2_048
REQUIRED_BINDINGS = (
    "{{EVOLABS_PROMPT}}",
    "{{EVOLABS_NEGATIVE_PROMPT}}",
    "{{EVOLABS_SEED}}",
    "{{EVOLABS_FRAMES}}",
    "{{EVOLABS_FPS}}",
    "{{EVOLABS_OUTPUT_PREFIX}}",
)
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv", ".gif", ".webp"}


class VideoProviderError(RuntimeError):
    def __init__(self, code: str, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


@dataclass(frozen=True)
class VideoGenerationRequest:
    prompt: str
    negative_prompt: str
    seed: int
    width: int
    height: int
    frames: int
    fps: int
    output_prefix: str
    input_image: Path | None = None


@dataclass(frozen=True)
class GeneratedVideo:
    path: Path
    provider_id: str
    workflow_name: str
    model_names: tuple[str, ...]
    seed: int
    prompt_id: str


def _safe_endpoint(raw: Any) -> str:
    value = str(raw or "").strip().rstrip("/")
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in {"http", "https"}:
        raise VideoProviderError("VIDEO_PROVIDER_ENDPOINT", "ComfyUI 位址必須使用 HTTP 或 HTTPS。")
    if parsed.username or parsed.password:
        raise VideoProviderError("VIDEO_PROVIDER_ENDPOINT", "ComfyUI 位址不得包含帳號或密碼。")
    host = (parsed.hostname or "").lower()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise VideoProviderError("VIDEO_PROVIDER_ENDPOINT", "本機影片模型服務只允許連接這台電腦上的 ComfyUI。")
    if parsed.path not in {"", "/"} or parsed.params or parsed.query or parsed.fragment:
        raise VideoProviderError("VIDEO_PROVIDER_ENDPOINT", "ComfyUI 位址只能包含通訊協定、主機名稱與連接埠。")
    return value


def _json_request(url: str, payload: Any | None = None, timeout: float = 30.0, limit: int = 16 * 1024 * 1024) -> Any:
    data = None
    headers = {"Accept": "application/json"}
    method = "GET"
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = "POST"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(limit + 1)
    except urllib.error.HTTPError as error:
        detail = error.read(64 * 1024).decode("utf-8", errors="replace")
        raise VideoProviderError("COMFYUI_HTTP", f"ComfyUI 回傳 HTTP {error.code}。", detail) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise VideoProviderError("COMFYUI_UNAVAILABLE", "無法連線至本機 ComfyUI。", str(error)) from error
    if len(raw) > limit:
        raise VideoProviderError("COMFYUI_RESPONSE_TOO_LARGE", "ComfyUI 回應超過安全大小限制。")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VideoProviderError("COMFYUI_RESPONSE_INVALID", "ComfyUI 回應格式無法辨識。", str(error)) from error


def _workflow_class_types(workflow: Any) -> set[str]:
    if not isinstance(workflow, dict) or not workflow or len(workflow) > MAX_NODES:
        raise VideoProviderError("VIDEO_WORKFLOW_INVALID", "影片工作流必須是包含 1 到 2048 個節點的 ComfyUI API 格式物件。")
    class_types: set[str] = set()
    for node_id, node in workflow.items():
        if not isinstance(node_id, str) or not isinstance(node, dict):
            raise VideoProviderError("VIDEO_WORKFLOW_INVALID", "影片工作流包含無效節點。")
        class_type = node.get("class_type")
        inputs = node.get("inputs")
        if not isinstance(class_type, str) or not class_type.strip() or len(class_type) > 240:
            raise VideoProviderError("VIDEO_WORKFLOW_INVALID", f"工作流節點 {node_id} 缺少有效的 class_type。")
        if not isinstance(inputs, dict):
            raise VideoProviderError("VIDEO_WORKFLOW_INVALID", f"工作流節點 {node_id} 缺少 inputs 物件。")
        class_types.add(class_type.strip())
    return class_types


def _is_video_output_class(class_type: str) -> bool:
    normalized = class_type.lower().replace("-", "").replace(" ", "")
    if "load" in normalized and not any(marker in normalized for marker in ("save", "output", "combine", "export", "encode", "writer")):
        return False
    markers = (
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
    )
    return any(marker in normalized for marker in markers)


def _collect_strings(value: Any, output: list[str]) -> None:
    if isinstance(value, str):
        output.append(value)
    elif isinstance(value, list):
        for item in value:
            _collect_strings(item, output)
    elif isinstance(value, dict):
        for item in value.values():
            _collect_strings(item, output)


def _workflow_input_text(workflow: Any) -> str:
    strings: list[str] = []
    for node in workflow.values():
        inputs = node.get("inputs") if isinstance(node, dict) else None
        if not isinstance(inputs, dict):
            raise VideoProviderError("VIDEO_WORKFLOW_INVALID", "影片工作流節點缺少 inputs 物件。")
        for value in inputs.values():
            _collect_strings(value, strings)
    return "\n".join(strings)


def _validate_workflow(workflow: Any) -> set[str]:
    class_types = _workflow_class_types(workflow)
    encoded = json.dumps(workflow, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_WORKFLOW_BYTES:
        raise VideoProviderError("VIDEO_WORKFLOW_TOO_LARGE", "影片工作流超過 12 MB 安全上限。")
    output_video = any(_is_video_output_class(class_type) for class_type in class_types)
    if not output_video:
        raise VideoProviderError(
            "COMFYUI_VIDEO_OUTPUT_REQUIRED",
            "影片工作流沒有可辨識的影片輸出節點；AI 影片模式不能使用只輸出靜態圖片的工作流。",
        )
    input_text = _workflow_input_text(workflow)
    missing = [token for token in REQUIRED_BINDINGS if token not in input_text]
    if missing:
        raise VideoProviderError(
            "VIDEO_WORKFLOW_BINDING",
            f"影片工作流缺少必要綁定：{'、'.join(missing)}。",
            "必要綁定用於角色安全限制、重試、幀數、輸出隔離與鏡頭時長控制。",
        )
    return class_types


def _validate_registered_nodes(class_types: set[str], object_info: Any) -> None:
    if not isinstance(object_info, dict):
        raise VideoProviderError("COMFYUI_NODE_REGISTRY_INVALID", "ComfyUI 節點清單格式無法辨識。")
    missing = sorted(class_type for class_type in class_types if class_type not in object_info)
    if missing:
        shown = "、".join(missing[:20])
        suffix = "……" if len(missing) > 20 else ""
        raise VideoProviderError(
            "COMFYUI_NODES_MISSING",
            f"ComfyUI 缺少工作流所需節點：{shown}{suffix}",
            "請安裝對應的 ComfyUI 自訂節點後重新驗證影片模型服務。",
        )


def _multipart_upload(endpoint: str, image: Path, timeout: float = 120.0) -> str:
    if not image.is_file() or image.stat().st_size > 20 * 1024 * 1024:
        raise VideoProviderError("INPUT_IMAGE_INVALID", "影片首幀參考圖不存在或超過 20 MB。", str(image))
    boundary = f"----Evolabs{uuid.uuid4().hex}"
    extension = image.suffix.lower() if image.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"} else ".png"
    upload_name = f"evolabs-{uuid.uuid4().hex}{extension}"
    mime = mimetypes.guess_type(upload_name)[0] or "application/octet-stream"
    body = bytearray()

    def add_line(value: str) -> None:
        body.extend(value.encode("utf-8"))
        body.extend(b"\r\n")

    add_line(f"--{boundary}")
    add_line(f'Content-Disposition: form-data; name="image"; filename="{upload_name}"')
    add_line(f"Content-Type: {mime}")
    add_line("")
    body.extend(image.read_bytes())
    body.extend(b"\r\n")
    add_line(f"--{boundary}")
    add_line('Content-Disposition: form-data; name="overwrite"')
    add_line("")
    add_line("true")
    add_line(f"--{boundary}--")
    request = urllib.request.Request(
        f"{endpoint}/upload/image",
        data=bytes(body),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise VideoProviderError("COMFYUI_UPLOAD_FAILED", "ComfyUI 參考圖上傳回應超過安全大小限制。")
        value = json.loads(raw.decode("utf-8"))
    except VideoProviderError:
        raise
    except urllib.error.HTTPError as error:
        detail = error.read(64 * 1024).decode("utf-8", errors="replace")
        raise VideoProviderError("COMFYUI_UPLOAD_FAILED", f"ComfyUI 參考圖上傳失敗（HTTP {error.code}）。", detail) from error
    except (urllib.error.URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VideoProviderError("COMFYUI_UPLOAD_FAILED", "無法將參考圖送至 ComfyUI。", str(error)) from error
    name = value.get("name") if isinstance(value, dict) else None
    subfolder = value.get("subfolder") if isinstance(value, dict) else None
    if not isinstance(name, str) or not name.strip():
        raise VideoProviderError("COMFYUI_UPLOAD_FAILED", "ComfyUI 沒有回傳已上傳參考圖名稱。")
    return f"{subfolder}/{name}".strip("/") if isinstance(subfolder, str) and subfolder.strip() else name


def _substitute(value: Any, replacements: dict[str, Any]) -> Any:
    if isinstance(value, str):
        if value in replacements:
            return replacements[value]
        rendered = value
        for token, replacement in replacements.items():
            rendered = rendered.replace(token, str(replacement))
        return rendered
    if isinstance(value, list):
        return [_substitute(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: _substitute(item, replacements) for key, item in value.items()}
    return value


def _extract_output(history: Any, prompt_id: str) -> dict[str, str] | None:
    if not isinstance(history, dict):
        return None
    record = history.get(prompt_id)
    if record is None and len(history) == 1:
        record = next(iter(history.values()))
    if not isinstance(record, dict):
        return None
    status = record.get("status")
    if isinstance(status, dict) and status.get("status_str") == "error":
        messages = status.get("messages")
        raise VideoProviderError("COMFYUI_EXECUTION_FAILED", "ComfyUI 影片工作流執行失敗。", json.dumps(messages, ensure_ascii=False))
    outputs = record.get("outputs")
    if not isinstance(outputs, dict):
        outputs = {}
    static_outputs: list[str] = []
    for output in outputs.values():
        if not isinstance(output, dict):
            continue
        for key in ("videos", "gifs", "animated", "images"):
            items = output.get(key)
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                filename = item.get("filename")
                if not isinstance(filename, str) or not filename.strip():
                    continue
                extension = Path(filename).suffix.lower()
                if extension not in VIDEO_EXTENSIONS:
                    static_outputs.append(filename)
                    continue
                return {
                    "filename": filename,
                    "subfolder": str(item.get("subfolder") or ""),
                    "type": str(item.get("type") or "output"),
                }
    status_completed = isinstance(status, dict) and status.get("completed") is True
    if status_completed:
        detail = f"僅找到靜態輸出：{', '.join(static_outputs[:8])}" if static_outputs else "工作流完成後沒有任何可下載的影片輸出。"
        raise VideoProviderError(
            "COMFYUI_VIDEO_OUTPUT_REQUIRED",
            "ComfyUI 工作流已完成，但沒有輸出真正影片檔；AI 影片模式不接受靜態圖片。",
            detail,
        )
    return None


def _download_output(endpoint: str, output: dict[str, str], destination: Path, timeout: float = 300.0) -> Path:
    query = urllib.parse.urlencode(output)
    request = urllib.request.Request(f"{endpoint}/view?{query}", headers={"Accept": "*/*"})
    temporary = destination.with_suffix(destination.suffix + ".part")
    temporary.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response, temporary.open("wb") as handle:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > 2 * 1024 * 1024 * 1024:
                    raise VideoProviderError("VIDEO_OUTPUT_TOO_LARGE", "單一影片輸出超過 2 GB 安全上限。")
                handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
    except VideoProviderError:
        temporary.unlink(missing_ok=True)
        raise
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        temporary.unlink(missing_ok=True)
        raise VideoProviderError("VIDEO_DOWNLOAD_FAILED", "無法下載 ComfyUI 影片輸出。", str(error)) from error
    if total < 1024:
        temporary.unlink(missing_ok=True)
        raise VideoProviderError("VIDEO_OUTPUT_EMPTY", "ComfyUI 回傳的影片輸出是空白檔案。")
    os.replace(temporary, destination)
    return destination


class ComfyUiVideoProvider:
    def __init__(
        self,
        endpoint: str,
        workflow_name: str,
        workflow: dict[str, Any],
        model_names: tuple[str, ...] = (),
        cancel_requested: Callable[[], bool] | None = None,
        poll_interval: float = 1.0,
        timeout_seconds: float = 7_200.0,
    ) -> None:
        self.endpoint = _safe_endpoint(endpoint)
        self.workflow_name = workflow_name.strip() or "ComfyUI 影片工作流"
        self.workflow = copy.deepcopy(workflow)
        self.class_types = _validate_workflow(self.workflow)
        encoded = json.dumps(workflow, ensure_ascii=False)
        self.requires_input_image = "{{EVOLABS_INPUT_IMAGE}}" in encoded
        self.model_names = model_names
        self.cancel_requested = cancel_requested or (lambda: False)
        self.poll_interval = max(0.25, poll_interval)
        self.timeout_seconds = max(30.0, timeout_seconds)
        self._probed = False

    @classmethod
    def from_project(cls, project: dict[str, Any], cancel_requested: Callable[[], bool] | None = None) -> "ComfyUiVideoProvider":
        raw = project.get("_videoProvider")
        if not isinstance(raw, dict) or raw.get("kind") != "comfyui" or raw.get("providerId") != "comfyui-local":
            raise VideoProviderError("VIDEO_PROVIDER_NOT_CONFIGURED", "AI 影片模式尚未設定可用的本機 ComfyUI 影片模型服務。")
        workflow = raw.get("workflow")
        if not isinstance(workflow, dict):
            raise VideoProviderError("VIDEO_WORKFLOW_INVALID", "影片模型服務缺少 ComfyUI API 工作流。")
        models = raw.get("detectedModels")
        model_names = tuple(str(item) for item in models if isinstance(item, str)) if isinstance(models, list) else ()
        return cls(
            endpoint=str(raw.get("endpoint") or ""),
            workflow_name=str(raw.get("workflowName") or "ComfyUI 影片工作流"),
            workflow=workflow,
            model_names=model_names,
            cancel_requested=cancel_requested,
        )

    def probe(self) -> None:
        if self._probed:
            return
        stats = _json_request(f"{self.endpoint}/system_stats", timeout=8.0, limit=2 * 1024 * 1024)
        if not isinstance(stats, dict):
            raise VideoProviderError("COMFYUI_STATUS_INVALID", "ComfyUI 系統狀態格式無法辨識。")
        object_info = _json_request(f"{self.endpoint}/object_info", timeout=12.0, limit=32 * 1024 * 1024)
        _validate_registered_nodes(self.class_types, object_info)
        self._probed = True

    def generate(self, request: VideoGenerationRequest, destination: Path) -> GeneratedVideo:
        self.probe()
        uploaded_image = ""
        if request.input_image is not None:
            uploaded_image = _multipart_upload(self.endpoint, request.input_image)
        elif self.requires_input_image:
            raise VideoProviderError(
                "VIDEO_REFERENCE_REQUIRED",
                "目前 ComfyUI 工作流需要 EVOLABS_INPUT_IMAGE，但這個鏡頭沒有可用的角色或首幀參考圖。",
            )
        replacements: dict[str, Any] = {
            "{{EVOLABS_PROMPT}}": request.prompt,
            "{{EVOLABS_NEGATIVE_PROMPT}}": request.negative_prompt,
            "{{EVOLABS_SEED}}": int(request.seed),
            "{{EVOLABS_WIDTH}}": int(request.width),
            "{{EVOLABS_HEIGHT}}": int(request.height),
            "{{EVOLABS_FRAMES}}": int(request.frames),
            "{{EVOLABS_FPS}}": int(request.fps),
            "{{EVOLABS_OUTPUT_PREFIX}}": request.output_prefix,
            "{{EVOLABS_INPUT_IMAGE}}": uploaded_image,
        }
        workflow = _substitute(self.workflow, replacements)
        if "{{EVOLABS_" in json.dumps(workflow, ensure_ascii=False):
            raise VideoProviderError("VIDEO_WORKFLOW_BINDING", "影片工作流仍包含未解析的 Evolabs 變數。")
        client_id = f"evolabs-{uuid.uuid4()}"
        queued = _json_request(
            f"{self.endpoint}/prompt",
            {"prompt": workflow, "client_id": client_id},
            timeout=60.0,
        )
        prompt_id = queued.get("prompt_id") if isinstance(queued, dict) else None
        if not isinstance(prompt_id, str) or not prompt_id:
            raise VideoProviderError("COMFYUI_QUEUE_FAILED", "ComfyUI 沒有回傳影片工作識別碼。", json.dumps(queued, ensure_ascii=False))
        started = time.monotonic()
        output: dict[str, str] | None = None
        while time.monotonic() - started < self.timeout_seconds:
            if self.cancel_requested():
                try:
                    _json_request(f"{self.endpoint}/interrupt", {}, timeout=5.0)
                except VideoProviderError:
                    pass
                raise VideoProviderError("VIDEO_GENERATION_CANCELED", "影片生成已取消。")
            history = _json_request(f"{self.endpoint}/history/{urllib.parse.quote(prompt_id)}", timeout=30.0)
            output = _extract_output(history, prompt_id)
            if output is not None:
                break
            time.sleep(self.poll_interval)
        if output is None:
            raise VideoProviderError("VIDEO_GENERATION_TIMEOUT", "影片模型超過兩小時仍未完成。", prompt_id)

        source_suffix = Path(output["filename"]).suffix.lower() or ".bin"
        raw_destination = destination.with_suffix(source_suffix)
        _download_output(self.endpoint, output, raw_destination)
        return GeneratedVideo(
            path=raw_destination,
            provider_id="comfyui-local",
            workflow_name=self.workflow_name,
            model_names=self.model_names,
            seed=request.seed,
            prompt_id=prompt_id,
        )
