from __future__ import annotations

import base64
import binascii
import hashlib
import ipaddress
import json
import math
import os
import re
import socket
import struct
import subprocess
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping

from PIL import Image, UnidentifiedImageError

from .process_control import (
    GpuFileLock,
    GpuLockCanceled,
    GpuLockTimeout,
    ProcessCanceled,
    run_cancellable,
)
from .lipsync_provider import LipSyncProviderError, MuseTalk15Provider


CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
SUPPORTED_MODEL_SUFFIXES = {".safetensors", ".gguf"}
MINIMUM_MODEL_BYTES = 1024 * 1024
MAX_HTTP_JSON_BYTES = 64 * 1024 * 1024
CAPABILITY_STATUSES = {"ready", "missing", "invalid", "unavailable"}
PACK_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
MAX_PACK_FILES = 4096


class ImageProviderError(RuntimeError):
    def __init__(self, code: str, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


@dataclass(frozen=True)
class ImageGenerationRequest:
    prompt: str
    negative_prompt: str
    width: int
    height: int
    steps: int
    cfg_scale: float
    seed: int
    quality: str = "balanced"
    reference_image: Path | None = None
    consistency_strength: float = 0.72


@dataclass(frozen=True)
class GeneratedImage:
    path: Path
    provider_id: str
    model_name: str | None
    seed: int
    reference_conditioned: bool = False


@dataclass(frozen=True)
class ProviderCapability:
    provider_id: str
    name: str
    status: str
    message: str
    model_name: str | None = None
    version: str | None = None
    reference_conditioning: bool = False
    details: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.status not in CAPABILITY_STATUSES:
            raise ValueError(f"invalid provider status: {self.status}")

    @property
    def ready(self) -> bool:
        return self.status == "ready"

    def model_pack(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "id": str(self.details.get("packId") or self.provider_id),
            "name": str(self.details.get("packName") or self.name),
            "status": self.status,
            "message": self.message,
        }
        if self.version:
            value["version"] = self.version
        return value


class LocalImageProvider(ABC):
    provider_id: str
    display_name: str

    @abstractmethod
    def probe(self) -> ProviderCapability:
        """Inspect the real executable/API and model without generating an image."""

    @abstractmethod
    def generate(self, request: ImageGenerationRequest, destination: Path) -> GeneratedImage:
        """Generate and validate one image, committing it atomically to destination."""


def _option_present(help_text: str, option: str) -> bool:
    return re.search(rf"(?<![\w-]){re.escape(option)}(?![\w-])", help_text) is not None


def _model_container_valid(path: Path) -> tuple[bool, str | None]:
    try:
        with path.open("rb") as handle:
            if path.suffix.lower() == ".gguf":
                return handle.read(4) == b"GGUF", None
            header_size_raw = handle.read(8)
            if len(header_size_raw) != 8:
                return False, "safetensors header is truncated"
            header_size = struct.unpack("<Q", header_size_raw)[0]
            if header_size < 2 or header_size > min(path.stat().st_size - 8, 16 * 1024 * 1024):
                return False, f"invalid safetensors header size: {header_size}"
            header = json.loads(handle.read(header_size).decode("utf-8"))
            if not isinstance(header, dict) or not any(key != "__metadata__" for key in header):
                return False, "safetensors tensor index is empty"
            return True, None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, struct.error) as error:
        return False, str(error)


def _validated_image(source: Path, destination: Path, expected_size: tuple[int, int]) -> None:
    if not source.is_file() or source.stat().st_size < 64 or source.stat().st_size > 32 * 1024 * 1024:
        raise ImageProviderError("AI_IMAGE_EMPTY", "本機 AI 沒有產生有效圖片。", str(source))
    try:
        with Image.open(source) as opened:
            if opened.width < 32 or opened.height < 32 or opened.width * opened.height > 20_000_000:
                raise ImageProviderError(
                    "AI_IMAGE_INVALID", "本機 AI 產生的圖片尺寸不正確。", f"{opened.width}x{opened.height}"
                )
            opened.load()
            image = opened.convert("RGB")
            if image.size != expected_size:
                image = image.resize(expected_size, Image.Resampling.LANCZOS)
    except ImageProviderError:
        raise
    except (OSError, UnidentifiedImageError) as error:
        raise ImageProviderError("AI_IMAGE_INVALID", "本機 AI 回傳的圖片無法解碼。", str(error)) from error

    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.stem}-", suffix=".png.partial", dir=destination.parent
    )
    os.close(descriptor)
    normalized = Path(temporary_name)
    try:
        image.save(normalized, format="PNG", optimize=True)
        os.replace(normalized, destination)
    finally:
        normalized.unlink(missing_ok=True)


def _run_help(executable: Path, timeout: float = 8.0) -> tuple[str, str | None]:
    try:
        result = subprocess.run(
            [str(executable), "--help"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
            creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return "", str(error)
    text = f"{result.stdout}\n{result.stderr}".strip()
    if not text:
        return "", f"sd-cli --help exited with {result.returncode} and no output"
    return text, None


class StableDiffusionCppProvider(LocalImageProvider):
    """Direct stable-diffusion.cpp adapter; no Python ML runtime is required."""

    provider_id = "sd-cli"
    display_name = "Evolabs 本機圖片模型 (stable-diffusion.cpp)"

    def __init__(
        self,
        executable: Path | None,
        model: Path | None,
        *,
        vae: Path | None = None,
        clip_vision: Path | None = None,
        ip_adapter: Path | None = None,
        pack_id: str | None = None,
        pack_name: str | None = None,
        pack_version: str | None = None,
        image_capabilities: tuple[str, ...] = (),
        model_hash: str | None = None,
        generation_timeout: float = 45 * 60,
        cancel_requested: Callable[[], bool] | None = None,
        gpu_lock_path: Path | None = None,
    ) -> None:
        self.executable = executable
        self.model = model
        self.vae = vae
        self.clip_vision = clip_vision
        self.ip_adapter = ip_adapter
        self.pack_id = pack_id
        self.pack_name = pack_name
        self.pack_version = pack_version
        self.image_capabilities = image_capabilities
        self.model_hash = model_hash
        self.generation_timeout = generation_timeout
        self.cancel_requested = cancel_requested
        self.gpu_lock_path = gpu_lock_path
        self._help_text: str | None = None

    def _inspect(self) -> tuple[ProviderCapability, str]:
        pack_details = {key: value for key, value in {"packId": self.pack_id, "packName": self.pack_name}.items() if value}
        if self.image_capabilities:
            pack_details["imageCapabilities"] = list(self.image_capabilities)
        if self.model_hash:
            pack_details["modelHash"] = self.model_hash
        missing_status = "invalid" if self.pack_id else "missing"
        if self.executable is None or not self.executable.is_file():
            return (
                ProviderCapability(
                    self.provider_id,
                    self.display_name,
                    missing_status,
                    "已啟用模型包缺少 sd-cli 執行器。" if self.pack_id else "尚未安裝 sd-cli 執行器。",
                    version=self.pack_version,
                    details=pack_details,
                ),
                "",
            )
        if self.model is None or not self.model.is_file():
            return (
                ProviderCapability(
                    self.provider_id,
                    self.display_name,
                    missing_status,
                    "已啟用模型包缺少圖片模型。" if self.pack_id else "尚未安裝本機圖片模型。",
                    version=self.pack_version,
                    details=pack_details,
                ),
                "",
            )
        try:
            model_size = self.model.stat().st_size
        except OSError as error:
            return (
                ProviderCapability(
                    self.provider_id,
                    self.display_name,
                    "invalid",
                    "無法讀取本機圖片模型。",
                    version=self.pack_version,
                    details={**pack_details, "error": str(error)},
                ),
                "",
            )
        container_valid, container_error = _model_container_valid(self.model) if model_size >= MINIMUM_MODEL_BYTES else (False, "model is too small")
        if self.model.suffix.lower() not in SUPPORTED_MODEL_SUFFIXES or not container_valid:
            return (
                ProviderCapability(
                    self.provider_id,
                    self.display_name,
                    "invalid",
                    "圖片模型格式或大小不正確；Evolabs 不會把占位檔當成模型。",
                    model_name=self.model.name,
                    version=self.pack_version,
                    details={**pack_details, "bytes": model_size, "containerError": container_error},
                ),
                "",
            )
        if self.vae is not None:
            try:
                vae_size = self.vae.stat().st_size
            except OSError as error:
                return (
                    ProviderCapability(
                        self.provider_id,
                        self.display_name,
                        "invalid",
                        "模型包指定的 VAE 無法讀取。",
                        model_name=self.model.name,
                        version=self.pack_version,
                        details={**pack_details, "error": str(error)},
                    ),
                    "",
                )
            vae_valid, vae_error = (
                _model_container_valid(self.vae)
                if vae_size >= MINIMUM_MODEL_BYTES
                else (False, "VAE is too small")
            )
            if self.vae.suffix.lower() not in SUPPORTED_MODEL_SUFFIXES or not vae_valid:
                return (
                    ProviderCapability(
                        self.provider_id,
                        self.display_name,
                        "invalid",
                        "模型包指定的 VAE 格式或大小不正確。",
                        model_name=self.model.name,
                        version=self.pack_version,
                        details={**pack_details, "vaeBytes": vae_size, "vaeContainerError": vae_error},
                    ),
                    "",
                )

        help_text = self._help_text
        if help_text is None:
            help_text, help_error = _run_help(self.executable)
            if help_error:
                return (
                    ProviderCapability(
                        self.provider_id,
                        self.display_name,
                        "unavailable",
                        "sd-cli 無法啟動。",
                        model_name=self.model.name,
                        version=self.pack_version,
                        details={**pack_details, "error": help_error},
                    ),
                    "",
                )
            self._help_text = help_text

        required_groups = (
            ("-m", "--model"),
            ("-p", "--prompt"),
            ("-n", "--negative-prompt"),
            ("-o", "--output"),
            ("-W", "--width"),
            ("-H", "--height"),
            ("-s", "--seed"),
        )
        missing = ["/".join(group) for group in required_groups if not any(_option_present(help_text, flag) for flag in group)]
        for required in ("--steps", "--cfg-scale"):
            if not _option_present(help_text, required):
                missing.append(required)
        if self.vae is not None and not _option_present(help_text, "--vae"):
            missing.append("--vae")
        if missing:
            return (
                ProviderCapability(
                    self.provider_id,
                    self.display_name,
                    "invalid",
                    "sd-cli 版本不相容，缺少必要參數。",
                    model_name=self.model.name,
                    version=self.pack_version,
                    details={**pack_details, "missingOptions": missing},
                ),
                help_text,
            )

        reference_ready = bool(
            self.clip_vision
            and self.clip_vision.is_file()
            and self.ip_adapter
            and self.ip_adapter.is_file()
            and all(
                _option_present(help_text, flag)
                for flag in ("--clip_vision", "--ip-adapter", "--ip-adapter-image", "--ip-adapter-strength")
            )
        )
        optimizations = [
            flag
            for flag in ("--diffusion-fa", "--fa", "--vae-tiling", "--offload-to-cpu", "--max-vram")
            if _option_present(help_text, flag)
        ]
        return (
            ProviderCapability(
                self.provider_id,
                self.display_name,
                "ready",
                "sd-cli、模型容器與必要參數已通過基礎檢查；首次生成會驗證模型載入。",
                model_name=self.model.name,
                version=self.pack_version,
                reference_conditioning=reference_ready,
                details={
                    **pack_details,
                    "optimizationOptions": optimizations,
                    "modelBytes": model_size,
                    "executionMode": "per-scene-process",
                    "modelReuse": False,
                    "safetyReason": "4GB VRAM profile avoids an unverified persistent sd-server process",
                },
            ),
            help_text,
        )

    def probe(self) -> ProviderCapability:
        return self._inspect()[0]

    def _arguments(self, request: ImageGenerationRequest, temporary_output: Path, help_text: str) -> tuple[list[str], bool]:
        assert self.executable is not None and self.model is not None
        arguments = [
            str(self.executable),
            "-m", str(self.model),
            "-p", request.prompt[:6000],
            "-n", request.negative_prompt[:3000],
            "-W", str(request.width),
            "-H", str(request.height),
            "--steps", str(request.steps),
            "--cfg-scale", f"{request.cfg_scale:.2f}",
            "-s", str(request.seed),
            "-o", str(temporary_output),
        ]
        if self.vae is not None:
            arguments.extend(["--vae", str(self.vae)])
        if _option_present(help_text, "--sampling-method"):
            sampler = "euler_a" if request.quality == "speed" else "dpm++2m"
            arguments.extend(["--sampling-method", sampler])
        if _option_present(help_text, "--diffusion-fa"):
            arguments.append("--diffusion-fa")
        elif _option_present(help_text, "--fa"):
            arguments.append("--fa")
        for flag in ("--vae-tiling", "--offload-to-cpu"):
            if _option_present(help_text, flag):
                arguments.append(flag)
        if _option_present(help_text, "--max-vram"):
            arguments.extend(["--max-vram", "3.0"])

        reference_conditioned = bool(
            request.reference_image
            and request.reference_image.is_file()
            and self.clip_vision
            and self.clip_vision.is_file()
            and self.ip_adapter
            and self.ip_adapter.is_file()
            and all(
                _option_present(help_text, flag)
                for flag in ("--clip_vision", "--ip-adapter", "--ip-adapter-image", "--ip-adapter-strength")
            )
        )
        if reference_conditioned:
            arguments.extend(
                [
                    "--clip_vision", str(self.clip_vision),
                    "--ip-adapter", str(self.ip_adapter),
                    "--ip-adapter-image", str(request.reference_image),
                    "--ip-adapter-strength", f"{request.consistency_strength:.3f}",
                ]
            )
        return arguments, reference_conditioned

    def generate(self, request: ImageGenerationRequest, destination: Path) -> GeneratedImage:
        capability, help_text = self._inspect()
        if not capability.ready:
            raise ImageProviderError("AI_IMAGE_UNAVAILABLE", capability.message, json.dumps(capability.details, ensure_ascii=False))
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.parent / f".{destination.stem}-{os.getpid()}-{uuid.uuid4().hex}.source.png"
        arguments, reference_conditioned = self._arguments(request, temporary, help_text)
        gpu_lock = GpuFileLock(self.gpu_lock_path) if self.gpu_lock_path is not None else None
        try:
            if gpu_lock is not None:
                gpu_lock.acquire(timeout=self.generation_timeout, cancel_requested=self.cancel_requested)
            try:
                result = run_cancellable(
                    arguments,
                    timeout=self.generation_timeout,
                    cancel_requested=self.cancel_requested,
                )
            except ProcessCanceled as error:
                raise ImageProviderError("AI_IMAGE_CANCELED", "本機 AI 圖片生成已取消。") from error
            except subprocess.TimeoutExpired as error:
                raise ImageProviderError("AI_IMAGE_TIMEOUT", "本機 AI 圖片生成逾時。", str(error)) from error
            except OSError as error:
                raise ImageProviderError("AI_IMAGE_PROCESS_FAILED", "無法啟動本機 AI 圖片引擎。", str(error)) from error
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or f"exit code {result.returncode}").strip()[-8000:]
                lowered = detail.lower()
                code = "AI_IMAGE_OOM" if "out of memory" in lowered or "cuda error" in lowered and "memory" in lowered else "AI_IMAGE_FAILED"
                message = "RTX 顯存不足，這一鏡無法生成。" if code == "AI_IMAGE_OOM" else "本機 AI 圖片生成失敗。"
                raise ImageProviderError(code, message, detail)
            _validated_image(temporary, destination, (request.width, request.height))
        except GpuLockCanceled as error:
            raise ImageProviderError("AI_IMAGE_CANCELED", "等待 GPU 時已取消圖片生成。") from error
        except GpuLockTimeout as error:
            raise ImageProviderError("AI_GPU_BUSY", "GPU 正由另一個 Evolabs 工作使用。", str(error)) from error
        finally:
            if gpu_lock is not None:
                gpu_lock.release()
            temporary.unlink(missing_ok=True)
        return GeneratedImage(destination, self.provider_id, capability.model_name, request.seed, reference_conditioned)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


def _is_loopback_url(value: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return False
    if parsed.scheme != "http" or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return False
    host = parsed.hostname
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class Automatic1111Provider(LocalImageProvider):
    """Adapter for an already-running local AUTOMATIC1111 or Forge API."""

    provider_id = "automatic1111"
    display_name = "本機 Stable Diffusion WebUI / Forge"

    def __init__(self, base_url: str = "http://127.0.0.1:7860", *, timeout: float = 1.5, generation_timeout: float = 45 * 60) -> None:
        normalized = base_url.rstrip("/")
        if not _is_loopback_url(normalized):
            raise ImageProviderError("AI_PROVIDER_URL_INVALID", "圖片 API 必須是本機 loopback HTTP 位址。", base_url)
        self.base_url = normalized
        self.timeout = timeout
        self.generation_timeout = generation_timeout
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def _request_json(self, method: str, path: str, payload: dict[str, Any] | None, timeout: float, maximum: int) -> Any:
        data = None if payload is None else json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={"Accept": "application/json", "Content-Type": "application/json", "User-Agent": "Evolabs-Local-Engine"},
        )
        try:
            with self._opener.open(request, timeout=timeout) as response:
                body = response.read(maximum + 1)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, socket.timeout, OSError) as error:
            raise ImageProviderError("AI_PROVIDER_UNAVAILABLE", "無法連線到本機 Stable Diffusion API。", str(error)) from error
        if len(body) > maximum:
            raise ImageProviderError("AI_PROVIDER_RESPONSE_TOO_LARGE", "本機圖片 API 回應超過安全限制。")
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ImageProviderError("AI_PROVIDER_INVALID_RESPONSE", "本機圖片 API 回傳無效資料。", str(error)) from error

    def probe(self) -> ProviderCapability:
        try:
            models = self._request_json("GET", "/sdapi/v1/sd-models", None, self.timeout, 2 * 1024 * 1024)
            options = self._request_json("GET", "/sdapi/v1/options", None, self.timeout, 2 * 1024 * 1024)
        except ImageProviderError as error:
            return ProviderCapability(self.provider_id, self.display_name, "unavailable", error.message, details={"error": error.detail})
        if not isinstance(models, list):
            return ProviderCapability(self.provider_id, self.display_name, "invalid", "Stable Diffusion API 的模型清單格式不正確。")
        model_records = [item for item in models if isinstance(item, dict) and (item.get("model_name") or item.get("title"))]
        names = [str(item.get("model_name") or item.get("title")) for item in model_records]
        if not names:
            return ProviderCapability(self.provider_id, self.display_name, "missing", "WebUI 已連線，但沒有可用的圖片模型。")
        active_name = str(options.get("sd_model_checkpoint") or "") if isinstance(options, dict) else ""
        selected = next(
            (
                item
                for item in model_records
                if active_name and active_name in {str(item.get("title") or ""), str(item.get("model_name") or "")}
            ),
            None,
        )
        if selected is None:
            selected = model_records[0] if not active_name else {"model_name": active_name}
        selected_name = str(selected.get("model_name") or selected.get("title") or active_name)
        model_hash = selected.get("sha256")
        details: dict[str, Any] = {"modelCount": len(names), "endpoint": self.base_url}
        if isinstance(model_hash, str) and re.fullmatch(r"[0-9a-fA-F]{64}", model_hash.strip()):
            details["modelHash"] = model_hash.strip().lower()
        elif isinstance(selected.get("hash"), str):
            # WebUI's legacy short hash is useful for display but is not strong
            # enough to separate a persistent content cache safely.
            details["modelShortHash"] = str(selected["hash"])
        return ProviderCapability(
            self.provider_id,
            self.display_name,
            "ready",
            "已連線到本機 Stable Diffusion API。",
            model_name=selected_name,
            details=details,
        )

    def generate(self, request: ImageGenerationRequest, destination: Path) -> GeneratedImage:
        capability = self.probe()
        if not capability.ready:
            raise ImageProviderError("AI_IMAGE_UNAVAILABLE", capability.message)
        payload = {
            "prompt": request.prompt[:6000],
            "negative_prompt": request.negative_prompt[:3000],
            "width": request.width,
            "height": request.height,
            "steps": request.steps,
            "cfg_scale": request.cfg_scale,
            "seed": request.seed,
            "batch_size": 1,
            "n_iter": 1,
            "do_not_save_samples": True,
            "do_not_save_grid": True,
        }
        result = self._request_json("POST", "/sdapi/v1/txt2img", payload, self.generation_timeout, MAX_HTTP_JSON_BYTES)
        images = result.get("images") if isinstance(result, dict) else None
        if not isinstance(images, list) or not images or not isinstance(images[0], str):
            raise ImageProviderError("AI_PROVIDER_INVALID_RESPONSE", "本機圖片 API 沒有回傳圖片。")
        encoded = images[0].split(",", 1)[-1]
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as error:
            raise ImageProviderError("AI_PROVIDER_INVALID_RESPONSE", "本機圖片 API 回傳的圖片編碼無效。", str(error)) from error
        if len(raw) > 32 * 1024 * 1024:
            raise ImageProviderError("AI_PROVIDER_RESPONSE_TOO_LARGE", "本機圖片 API 回傳的圖片超過安全限制。")
        destination.parent.mkdir(parents=True, exist_ok=True)
        descriptor, source_name = tempfile.mkstemp(prefix=f".{destination.stem}-", suffix=".source", dir=destination.parent)
        source = Path(source_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            _validated_image(source, destination, (request.width, request.height))
        finally:
            source.unlink(missing_ok=True)
        return GeneratedImage(destination, self.provider_id, capability.model_name, request.seed, False)


ProviderFactory = Callable[[Path, Mapping[str, str], Mapping[str, Any]], LocalImageProvider]


def _path_from(value: str | None) -> Path | None:
    if not value:
        return None
    try:
        return Path(value).expanduser().resolve()
    except OSError as error:
        raise ImageProviderError("AI_PROVIDER_PATH_INVALID", "本機圖片引擎路徑無效。", str(error)) from error


@dataclass(frozen=True)
class _ActivePack:
    pack_id: str
    name: str
    version: str
    executable: Path
    model: Path
    vae: Path | None
    clip_vision: Path | None
    ip_adapter: Path | None
    capabilities: tuple[str, ...]
    model_hash: str | None


def _read_small_json(path: Path, maximum: int) -> Any:
    try:
        if not path.is_file() or path.stat().st_size > maximum:
            return None
    except OSError:
        return None
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            return json.load(handle)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def _resolved_pack_path(pack_root: Path, raw: Any, *, required: bool) -> Path | None:
    if raw is None and not required:
        return None
    if (
        not isinstance(raw, str)
        or not raw.strip()
        or "\\" in raw
        or ":" in raw
        or "\x00" in raw
    ):
        raise ImageProviderError("AI_PACK_INVALID", "模型包的啟用路徑不完整。")
    relative = PurePosixPath(raw)
    if relative.is_absolute() or any(
        part in {"", ".", ".."} or part.rstrip(" .") != part
        or re.fullmatch(r"(?i:(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?)", part) is not None
        for part in relative.parts
    ):
        raise ImageProviderError("AI_PACK_INVALID", "模型包含有不安全的啟用路徑。", raw)
    resolved = pack_root.joinpath(*relative.parts).resolve()
    try:
        resolved.relative_to(pack_root.resolve())
    except ValueError as error:
        raise ImageProviderError("AI_PACK_INVALID", "模型包啟用路徑超出模型包目錄。", raw) from error
    return resolved


@dataclass(frozen=True)
class _PackIntegrityCacheEntry:
    fingerprint: str
    signatures: tuple[tuple[str, int, int, int, int], ...]


_PACK_INTEGRITY_CACHE: dict[str, _PackIntegrityCacheEntry] = {}
_PACK_INTEGRITY_LOCK = threading.Lock()


def _pack_integrity_path(pack_root: Path, raw: Any, label: str) -> tuple[str, Path]:
    resolved = _resolved_pack_path(pack_root, raw, required=True)
    assert resolved is not None
    relative = PurePosixPath(str(raw))
    candidate = pack_root.joinpath(*relative.parts)
    cursor = candidate
    while cursor != pack_root:
        if cursor.is_symlink():
            raise ImageProviderError("AI_PACK_INTEGRITY", "模型包完整性驗證失敗，請重新安裝。", f"{label}: symlink")
        cursor = cursor.parent
    return relative.as_posix(), candidate


def _pack_file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise ImageProviderError(
            "AI_PACK_INTEGRITY",
            "模型包完整性驗證失敗，請重新安裝。",
            f"{path}: {error}",
        ) from error
    return digest.hexdigest()


def _pack_file_signature(pack_root: Path, relative: str, path: Path) -> tuple[str, int, int, int, int]:
    try:
        stat_result = path.stat()
    except OSError as error:
        raise ImageProviderError(
            "AI_PACK_INTEGRITY",
            "模型包完整性驗證失敗，請重新安裝。",
            f"{relative}: {error}",
        ) from error
    try:
        path.resolve().relative_to(pack_root.resolve())
    except (OSError, ValueError) as error:
        raise ImageProviderError(
            "AI_PACK_INTEGRITY",
            "模型包完整性驗證失敗，請重新安裝。",
            f"{relative}: path escaped the pack",
        ) from error
    return (
        relative,
        stat_result.st_size,
        stat_result.st_mtime_ns,
        stat_result.st_ctime_ns,
        getattr(stat_result, "st_ino", 0),
    )


def _verify_active_pack_integrity(pack_root: Path, pack: Mapping[str, Any]) -> None:
    """Verify every installed file before a pack can execute or report ready."""

    raw_files = pack.get("files")
    if not isinstance(raw_files, list) or not raw_files or len(raw_files) > MAX_PACK_FILES:
        raise ImageProviderError("AI_PACK_INTEGRITY", "模型包缺少完整的檔案驗證紀錄，請重新安裝。")

    expected: dict[str, tuple[Path, int, str]] = {}
    record_ids: set[str] = set()
    for record in raw_files:
        if not isinstance(record, dict):
            raise ImageProviderError("AI_PACK_INTEGRITY", "模型包檔案驗證紀錄無效，請重新安裝。")
        record_id = record.get("id")
        kind = record.get("kind")
        if not isinstance(record_id, str) or not record_id or record_id in record_ids or kind not in {"file", "zip"}:
            raise ImageProviderError("AI_PACK_INTEGRITY", "模型包檔案驗證紀錄無效，請重新安裝。")
        record_ids.add(record_id)
        destination_relative, destination = _pack_integrity_path(pack_root, record.get("destination"), record_id)

        if kind == "file":
            size = record.get("size")
            sha256 = record.get("sha256")
            if (
                not isinstance(size, int)
                or size < 0
                or not isinstance(sha256, str)
                or not PACK_SHA256_PATTERN.fullmatch(sha256)
                or destination_relative in expected
            ):
                raise ImageProviderError("AI_PACK_INTEGRITY", "模型包檔案驗證紀錄無效，請重新安裝。", record_id)
            expected[destination_relative] = (destination, size, sha256)
            continue

        if not destination.is_dir() or destination.is_symlink():
            raise ImageProviderError("AI_PACK_INTEGRITY", "模型包執行元件目錄遺失，請重新安裝。", record_id)
        entries = record.get("installedEntries")
        if not isinstance(entries, list) or not entries or len(entries) > MAX_PACK_FILES:
            raise ImageProviderError("AI_PACK_INTEGRITY", "模型包執行元件缺少完整性紀錄，請重新安裝。", record_id)
        installed_paths: set[str] = set()
        destination_resolved = destination.resolve()
        for entry in entries:
            if not isinstance(entry, dict):
                raise ImageProviderError("AI_PACK_INTEGRITY", "模型包執行元件紀錄無效，請重新安裝。", record_id)
            relative, target = _pack_integrity_path(pack_root, entry.get("path"), record_id)
            try:
                target.resolve().relative_to(destination_resolved)
            except (OSError, ValueError) as error:
                raise ImageProviderError(
                    "AI_PACK_INTEGRITY",
                    "模型包執行元件路徑超出安裝目錄，請重新安裝。",
                    relative,
                ) from error
            size = entry.get("size")
            sha256 = entry.get("sha256")
            if (
                not isinstance(size, int)
                or size < 0
                or not isinstance(sha256, str)
                or not PACK_SHA256_PATTERN.fullmatch(sha256)
                or relative in installed_paths
                or relative in expected
            ):
                raise ImageProviderError("AI_PACK_INTEGRITY", "模型包執行元件紀錄無效，請重新安裝。", relative)
            installed_paths.add(relative)
            expected[relative] = (target, size, sha256)

        actual_paths: set[str] = set()
        try:
            candidates = destination.rglob("*")
            for candidate in candidates:
                if candidate.is_symlink():
                    raise ImageProviderError(
                        "AI_PACK_INTEGRITY", "模型包執行元件不允許符號連結，請重新安裝。", str(candidate)
                    )
                if not candidate.is_file():
                    continue
                resolved = candidate.resolve()
                resolved.relative_to(destination_resolved)
                relative = candidate.relative_to(pack_root).as_posix()
                actual_paths.add(relative)
        except ImageProviderError:
            raise
        except (OSError, ValueError) as error:
            raise ImageProviderError(
                "AI_PACK_INTEGRITY", "無法列舉模型包執行元件，請重新安裝。", str(error)
            ) from error
        if actual_paths != installed_paths:
            raise ImageProviderError("AI_PACK_INTEGRITY", "模型包執行元件內容已改變，請重新安裝。", record_id)

    if len(expected) > MAX_PACK_FILES:
        raise ImageProviderError("AI_PACK_INTEGRITY", "模型包檔案數超過安全限制，請重新安裝。")
    ordered = sorted(expected.items())
    fingerprint = hashlib.sha256(
        json.dumps(pack, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    cache_key = str(pack_root.resolve())

    # A process must fully hash each pack once. Subsequent probes may reuse that
    # result only while every file's identity, size, and timestamps are unchanged.
    with _PACK_INTEGRITY_LOCK:
        signatures = tuple(_pack_file_signature(pack_root, relative, value[0]) for relative, value in ordered)
        cached = _PACK_INTEGRITY_CACHE.get(cache_key)
        if cached and cached.fingerprint == fingerprint and cached.signatures == signatures:
            return

        verified_signatures: list[tuple[str, int, int, int, int]] = []
        for relative, (path, expected_size, expected_sha256) in ordered:
            if not path.is_file() or path.is_symlink():
                raise ImageProviderError("AI_PACK_INTEGRITY", "模型包檔案遺失，請重新安裝。", relative)
            before = _pack_file_signature(pack_root, relative, path)
            if before[1] != expected_size or _pack_file_sha256(path) != expected_sha256:
                raise ImageProviderError("AI_PACK_INTEGRITY", "模型包檔案 SHA-256 驗證失敗，請重新安裝。", relative)
            after = _pack_file_signature(pack_root, relative, path)
            if before != after:
                raise ImageProviderError("AI_PACK_INTEGRITY", "模型包檔案在驗證期間發生變更，請重新安裝。", relative)
            verified_signatures.append(after)
        _PACK_INTEGRITY_CACHE[cache_key] = _PackIntegrityCacheEntry(fingerprint, tuple(verified_signatures))


def _find_active_sd_pack(data_root: Path, environment: Mapping[str, str]) -> _ActivePack | None:
    models_root = data_root / "models"
    requested_pack = str(environment.get("EVOLABS_MODEL_PACK_ID") or "").strip()
    if requested_pack and not re.fullmatch(r"[A-Za-z0-9._-]{1,96}", requested_pack):
        raise ImageProviderError("AI_PACK_INVALID", "指定的模型包 ID 不正確。", requested_pack)
    if requested_pack:
        candidates = [models_root / requested_pack]
    else:
        try:
            candidates = sorted((path for path in models_root.iterdir() if path.is_dir()), key=lambda path: path.name)
        except OSError:
            candidates = []
    for pack_parent in candidates:
        current = _read_small_json(pack_parent / "current.json", 64 * 1024)
        if not isinstance(current, dict):
            if requested_pack and (pack_parent / "current.json").exists():
                raise ImageProviderError("AI_PACK_INVALID", "模型包的 current.json 無效。", requested_pack)
            continue
        pack_id = current.get("id")
        version = current.get("version")
        if pack_id != pack_parent.name or not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,96}", version):
            if requested_pack:
                raise ImageProviderError("AI_PACK_INVALID", "模型包的目前版本指標無效。", requested_pack)
            continue
        pack_root = (pack_parent / version).resolve()
        try:
            pack_root.relative_to(pack_parent.resolve())
        except ValueError:
            continue
        pack = _read_small_json(pack_root / "pack.json", 1024 * 1024)
        if not isinstance(pack, dict):
            if requested_pack:
                raise ImageProviderError("AI_PACK_INVALID", "已啟用模型包缺少有效 pack.json。", str(pack_root))
            continue
        if pack.get("id") != pack_id or pack.get("version") != version:
            if requested_pack:
                raise ImageProviderError("AI_PACK_INVALID", "pack.json 與目前啟用的模型版本不一致。", requested_pack)
            continue
        try:
            _verify_active_pack_integrity(pack_root, pack)
        except ImageProviderError:
            if requested_pack:
                raise
            continue
        activation = pack.get("resolvedActivation")
        if not isinstance(activation, dict) or activation.get("provider") != "sd-cli":
            if requested_pack:
                raise ImageProviderError("AI_PACK_INVALID", "模型包沒有有效的 sd-cli 啟用設定。", requested_pack)
            continue
        try:
            executable = _resolved_pack_path(pack_root, activation.get("executable"), required=True)
            model = _resolved_pack_path(pack_root, activation.get("model"), required=True)
            vae = _resolved_pack_path(pack_root, activation.get("vae"), required=False)
            clip_vision = _resolved_pack_path(pack_root, activation.get("clipVision"), required=False)
            ip_adapter = _resolved_pack_path(pack_root, activation.get("ipAdapter"), required=False)
        except ImageProviderError:
            if requested_pack:
                raise
            continue
        assert executable is not None and model is not None
        raw_capabilities = pack.get("capabilities")
        capabilities = tuple(
            str(value)
            for value in raw_capabilities
            if isinstance(value, str) and len(value) <= 96
        ) if isinstance(raw_capabilities, list) else ()
        model_relative = str(activation.get("model") or "")
        raw_files = pack.get("files")
        model_hash = None
        if isinstance(raw_files, list):
            for record in raw_files:
                if not isinstance(record, dict) or record.get("destination") != model_relative:
                    continue
                candidate_hash = record.get("sha256")
                if isinstance(candidate_hash, str) and re.fullmatch(r"[0-9a-fA-F]{64}", candidate_hash):
                    model_hash = candidate_hash.lower()
                    break
        return _ActivePack(
            pack_id=pack_id,
            name=str(pack.get("name") or pack.get("displayName") or pack_id)[:160],
            version=version,
            executable=executable,
            model=model,
            vae=vae,
            clip_vision=clip_vision,
            ip_adapter=ip_adapter,
            capabilities=capabilities,
            model_hash=model_hash,
        )
    return None


def _sd_cli_factory(data_root: Path, environment: Mapping[str, str], settings: Mapping[str, Any]) -> LocalImageProvider:
    pack_environment = dict(environment)
    requested_pack = str(settings.get("packId") or "").strip()
    if not requested_pack:
        mode = str(settings.get("mode") or "").strip().lower()
        requested_pack = {"anime": "anime-core", "realistic": "realistic-core"}.get(mode, "")
    if requested_pack:
        pack_environment["EVOLABS_MODEL_PACK_ID"] = requested_pack
    active_pack = _find_active_sd_pack(data_root, pack_environment)
    executable_override = settings.get("executable") or environment.get("EVOLABS_SD_CLI")
    model_override = settings.get("modelPath") or environment.get("EVOLABS_SD_MODEL")
    auxiliary_override = any(
        settings.get(key) or environment.get(env_key)
        for key, env_key in (
            ("vaePath", "EVOLABS_SD_VAE"),
            ("clipVisionPath", "EVOLABS_SD_CLIP_VISION"),
            ("ipAdapterPath", "EVOLABS_SD_IP_ADAPTER"),
        )
    )
    development_override = bool(executable_override or model_override or auxiliary_override)
    executable = _path_from(str(executable_override or ""))
    if executable is None and active_pack:
        executable = active_pack.executable
    model = _path_from(str(model_override or ""))
    if model is None and active_pack:
        model = active_pack.model
    vae = _path_from(str(settings.get("vaePath") or environment.get("EVOLABS_SD_VAE") or ""))
    if vae is None and active_pack:
        vae = active_pack.vae
    clip_vision = _path_from(str(settings.get("clipVisionPath") or environment.get("EVOLABS_SD_CLIP_VISION") or ""))
    if clip_vision is None and active_pack:
        clip_vision = active_pack.clip_vision
    ip_adapter = _path_from(str(settings.get("ipAdapterPath") or environment.get("EVOLABS_SD_IP_ADAPTER") or ""))
    if ip_adapter is None and active_pack:
        ip_adapter = active_pack.ip_adapter
    override_capabilities_raw = settings.get("capabilities") or environment.get("EVOLABS_SD_CAPABILITIES") or ""
    if isinstance(override_capabilities_raw, str):
        override_capabilities = tuple(value.strip() for value in override_capabilities_raw.split(",") if value.strip())
    elif isinstance(override_capabilities_raw, (list, tuple)):
        override_capabilities = tuple(str(value) for value in override_capabilities_raw if isinstance(value, str))
    else:
        override_capabilities = ()
    override_hash = str(settings.get("modelSha256") or environment.get("EVOLABS_SD_MODEL_SHA256") or "").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", override_hash):
        override_hash = ""
    verified_pack = active_pack if active_pack and not development_override else None
    return StableDiffusionCppProvider(
        executable,
        model,
        vae=vae,
        clip_vision=clip_vision,
        ip_adapter=ip_adapter,
        pack_id=verified_pack.pack_id if verified_pack else None,
        pack_name=verified_pack.name if verified_pack else None,
        pack_version=verified_pack.version if verified_pack else None,
        image_capabilities=verified_pack.capabilities if verified_pack else override_capabilities,
        model_hash=verified_pack.model_hash if verified_pack else (override_hash or None),
        gpu_lock_path=data_root / "locks" / "gpu.lock",
    )


def _a1111_factory(data_root: Path, environment: Mapping[str, str], settings: Mapping[str, Any]) -> LocalImageProvider:
    del data_root
    base_url = str(settings.get("baseUrl") or environment.get("EVOLABS_A1111_URL") or "http://127.0.0.1:7860")
    return Automatic1111Provider(base_url)


class ImageProviderRegistry:
    """Small provider registry so future runtimes do not leak into the renderer."""

    def __init__(self) -> None:
        self._factories: dict[str, ProviderFactory] = {}

    def register(self, provider_id: str, factory: ProviderFactory) -> None:
        if provider_id in self._factories:
            raise ValueError(f"duplicate image provider: {provider_id}")
        self._factories[provider_id] = factory

    @property
    def provider_ids(self) -> tuple[str, ...]:
        return tuple(self._factories)

    def create(
        self,
        provider_id: str,
        data_root: Path,
        environment: Mapping[str, str],
        settings: Mapping[str, Any] | None = None,
    ) -> LocalImageProvider:
        try:
            factory = self._factories[provider_id]
        except KeyError as error:
            raise ImageProviderError("AI_PROVIDER_UNKNOWN", "不支援指定的本機圖片引擎。", provider_id) from error
        return factory(data_root, environment, settings or {})


DEFAULT_IMAGE_PROVIDERS = ImageProviderRegistry()
DEFAULT_IMAGE_PROVIDERS.register("sd-cli", _sd_cli_factory)
DEFAULT_IMAGE_PROVIDERS.register("automatic1111", _a1111_factory)


def _provider_settings(settings: Mapping[str, Any]) -> tuple[str, Mapping[str, Any]]:
    nested = settings.get("imageGeneration")
    nested_settings = nested if isinstance(nested, Mapping) else {}
    requested = str(settings.get("imageProvider") or nested_settings.get("provider") or "auto").strip().lower()
    aliases = {"a1111": "automatic1111", "forge": "automatic1111", "sd-webui": "automatic1111", "stable-diffusion.cpp": "sd-cli"}
    merged = dict(nested_settings)
    if "mode" not in merged and isinstance(settings.get("mode"), str):
        merged["mode"] = settings["mode"]
    if "packId" not in merged and isinstance(settings.get("imagePackId"), str):
        merged["packId"] = settings["imagePackId"]
    return aliases.get(requested, requested), merged


def select_image_provider(
    data_root: Path,
    settings: Mapping[str, Any],
    *,
    environment: Mapping[str, str] | None = None,
    registry: ImageProviderRegistry = DEFAULT_IMAGE_PROVIDERS,
) -> tuple[LocalImageProvider, ProviderCapability]:
    env = os.environ if environment is None else environment
    requested, nested_settings = _provider_settings(settings)
    order = list(registry.provider_ids) if requested == "auto" else [requested]
    inspected: list[ProviderCapability] = []
    for provider_id in order:
        try:
            provider = registry.create(provider_id, data_root, env, nested_settings)
            capability = provider.probe()
        except ImageProviderError as error:
            capability = ProviderCapability(provider_id, provider_id, "invalid", error.message, details={"error": error.detail})
            inspected.append(capability)
            continue
        inspected.append(capability)
        if capability.ready:
            return provider, capability
    detail = "; ".join(f"{item.provider_id}: {item.message}" for item in inspected)
    raise ImageProviderError("AI_IMAGE_UNAVAILABLE", "尚未偵測到可用的本機 AI 圖片引擎與模型。", detail)


def runtime_ai_capabilities(
    data_root: Path,
    *,
    chinese_voice_available: bool,
    comic_core_ready: bool = True,
    environment: Mapping[str, str] | None = None,
    registry: ImageProviderRegistry = DEFAULT_IMAGE_PROVIDERS,
) -> dict[str, Any]:
    env = os.environ if environment is None else environment
    preferred = str(env.get("EVOLABS_IMAGE_PROVIDER") or "auto").strip().lower()
    aliases = {"a1111": "automatic1111", "forge": "automatic1111", "stable-diffusion.cpp": "sd-cli"}
    preferred = aliases.get(preferred, preferred)

    pack_capabilities: dict[str, ProviderCapability] = {}
    model_packs: list[dict[str, Any]] = []
    pack_names = {"anime-core": "動漫圖片模型", "realistic-core": "寫實圖片模型"}
    pack_environment = {
        key: value
        for key, value in env.items()
        if key not in {"EVOLABS_SD_CLI", "EVOLABS_SD_MODEL", "EVOLABS_SD_CLIP_VISION", "EVOLABS_SD_IP_ADAPTER"}
    }
    for pack_id, pack_name in pack_names.items():
        try:
            provider = registry.create("sd-cli", data_root, pack_environment, {"packId": pack_id})
            capability = provider.probe()
        except ImageProviderError as error:
            capability = ProviderCapability(
                "sd-cli",
                pack_name,
                "invalid",
                error.message,
                details={"packId": pack_id, "packName": pack_name, "error": error.detail},
            )
        pack_capabilities[pack_id] = capability
        row: dict[str, Any] = {
            "id": pack_id,
            "name": str(capability.details.get("packName") or pack_name),
            "status": capability.status,
            "message": capability.message,
        }
        if capability.version:
            row["version"] = capability.version
        model_packs.append(row)

    external_capability: ProviderCapability | None = None
    if "automatic1111" in registry.provider_ids:
        try:
            external_capability = registry.create("automatic1111", data_root, env, {}).probe()
        except ImageProviderError as error:
            external_capability = ProviderCapability(
                "automatic1111", "本機 Stable Diffusion WebUI / Forge", "invalid", error.message, details={"error": error.detail}
            )

    dev_capability: ProviderCapability | None = None
    if env.get("EVOLABS_SD_CLI") or env.get("EVOLABS_SD_MODEL"):
        try:
            dev_capability = registry.create("sd-cli", data_root, env, {}).probe()
        except ImageProviderError as error:
            dev_capability = ProviderCapability("sd-cli", "sd-cli 開發覆寫", "invalid", error.message, details={"error": error.detail})

    ready_packs = [capability for capability in pack_capabilities.values() if capability.ready]
    external_ready = bool(external_capability and external_capability.ready)
    dev_ready = bool(dev_capability and dev_capability.ready)
    ai_ready = bool(ready_packs or external_ready or dev_ready)
    if preferred == "automatic1111" and external_ready:
        ai_provider = "automatic1111"
    elif ready_packs or dev_ready:
        ai_provider = "sd-cli"
    elif external_ready:
        ai_provider = "automatic1111"
    else:
        ai_provider = None

    def pack_declares(pack_id: str, *names: str) -> bool:
        capability = pack_capabilities[pack_id]
        declared = set(capability.details.get("imageCapabilities", []))
        return capability.ready and bool(declared.intersection(names))

    anime_image = external_ready or pack_declares("anime-core", "anime_image", "animeImage")
    realistic_image = external_ready or pack_declares("realistic-core", "realistic_image", "realisticImage")
    def pack_reference_ready(pack_id: str) -> bool:
        capability = pack_capabilities[pack_id]
        declared = set(capability.details.get("imageCapabilities", []))
        return bool(
            capability.ready
            and capability.reference_conditioning
            and declared.intersection({"character_consistency", "characterConsistency", "reference_conditioning"})
        )

    external_reference = bool(external_capability and external_capability.ready and external_capability.reference_conditioning)
    dev_reference = bool(dev_capability and dev_capability.ready and dev_capability.reference_conditioning)
    anime_reference = pack_reference_ready("anime-core") or external_reference or dev_reference
    realistic_reference = pack_reference_ready("realistic-core") or external_reference or dev_reference
    reference_ready = anime_reference or realistic_reference

    try:
        raw_vram = str(env.get("EVOLABS_VRAM_MB") or "").strip()
        vram_mb = int(raw_vram) if raw_vram else None
    except ValueError:
        vram_mb = None
    nvidia_flag = str(env.get("EVOLABS_NVIDIA_AVAILABLE") or "").strip().lower()
    cuda_available = nvidia_flag in {"1", "true", "yes"} or bool(vram_mb and vram_mb > 0)
    lip_sync_provider = MuseTalk15Provider.from_environment(
        env,
        cuda_available=cuda_available,
        vram_mb=vram_mb,
        gpu_lock_path=data_root / "locks" / "gpu.lock",
    )
    try:
        lip_sync_capability = lip_sync_provider.probe()
    except LipSyncProviderError as error:
        # A health probe must remain a structured capability result. It may
        # never make the functional video core appear dead because an optional
        # user-supplied MuseTalk checkout is broken.
        lip_sync_capability = None
        lip_sync_error = {"code": error.code, "message": error.message, "detail": error.detail}
    else:
        lip_sync_error = None

    result: dict[str, Any] = {
        "aiReady": ai_ready,
        "capabilities": {
            "comicCore": bool(comic_core_ready),
            "animeImage": anime_image,
            "realisticImage": realistic_image,
            "characterConsistency": reference_ready,
            "animeReference": anime_reference,
            "realisticReference": realistic_reference,
            "multiCharacterReference": False,
            "zhVoice": bool(chinese_voice_available),
            "lipSync": bool(lip_sync_capability and lip_sync_capability.ready),
            "imageToVideo": False,
        },
        "modelPacks": model_packs,
    }
    if ai_provider:
        result["aiProvider"] = ai_provider
    if lip_sync_capability is not None:
        result["lipSyncProvider"] = {
            "id": lip_sync_capability.provider_id,
            "name": lip_sync_capability.name,
            "status": lip_sync_capability.status,
            "message": lip_sync_capability.message,
            "version": lip_sync_capability.version,
            "details": lip_sync_capability.details,
        }
    elif lip_sync_error is not None:
        result["lipSyncProvider"] = {
            "id": "musetalk-1.5-local",
            "name": "MuseTalk 1.5（本機自備）",
            "status": "invalid",
            "message": lip_sync_error["message"],
            "error": lip_sync_error,
        }
    if external_capability:
        result["externalImageProvider"] = {
            "id": external_capability.provider_id,
            "status": external_capability.status,
            "message": external_capability.message,
            "modelName": external_capability.model_name,
        }
    return result


def safe_generation_dimensions(settings: Mapping[str, Any]) -> tuple[int, int]:
    format_name = str(settings.get("format") or "9:16")
    defaults = {"9:16": (448, 768), "16:9": (768, 448), "1:1": (512, 512)}
    width, height = defaults.get(format_name, defaults["9:16"])
    nested = settings.get("imageGeneration")
    if isinstance(nested, Mapping):
        try:
            width = int(nested.get("width", width))
            height = int(nested.get("height", height))
        except (TypeError, ValueError):
            width, height = defaults.get(format_name, defaults["9:16"])
    width = max(256, min(1024, int(round(width / 64)) * 64))
    height = max(256, min(1024, int(round(height / 64)) * 64))
    maximum_pixels = 512 * 768
    if width * height > maximum_pixels:
        scale = math.sqrt(maximum_pixels / (width * height))
        width = max(256, int(width * scale) // 64 * 64)
        height = max(256, int(height * scale) // 64 * 64)
    return width, height
