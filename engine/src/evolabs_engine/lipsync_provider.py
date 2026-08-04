from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from .process_control import (
    GpuFileLock,
    GpuLockCanceled,
    GpuLockTimeout,
    ProcessCanceled,
    run_cancellable,
)


CAPABILITY_STATUSES = {"ready", "missing", "invalid", "unavailable"}
REQUIRED_HELP_OPTIONS = (
    "--inference_config",
    "--result_dir",
    "--unet_model_path",
    "--unet_config",
    "--whisper_dir",
    "--use_float16",
    "--batch_size",
    "--version",
    "--ffmpeg_path",
)
MINIMUM_VRAM_MB = 3800
MAX_SCENE_SECONDS_4GB = 30.0
SAFE_UPSTREAM_PATH = re.compile(r"^[A-Za-z0-9_./:\\\-~]+$")


class LipSyncProviderError(RuntimeError):
    def __init__(self, code: str, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


@dataclass(frozen=True)
class LipSyncRequest:
    source_video: Path
    audio: Path
    duration_seconds: float
    subject_count: int = 1
    fps: int = 25


@dataclass(frozen=True)
class LipSyncResult:
    path: Path
    provider_id: str
    version: str


@dataclass(frozen=True)
class LipSyncCapability:
    provider_id: str
    name: str
    status: str
    message: str
    version: str | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.status not in CAPABILITY_STATUSES:
            raise ValueError(f"invalid lip-sync provider status: {self.status}")

    @property
    def ready(self) -> bool:
        return self.status == "ready"


class LocalLipSyncProvider(ABC):
    provider_id: str
    display_name: str

    @abstractmethod
    def probe(self) -> LipSyncCapability:
        """Inspect the configured local runtime without loading model weights."""

    @abstractmethod
    def generate(self, request: LipSyncRequest, destination: Path) -> LipSyncResult:
        """Generate and validate one single-subject lip-synced scene."""


def _option_present(help_text: str, option: str) -> bool:
    return re.search(rf"(?<![\w-]){re.escape(option)}(?![\w-])", help_text) is not None


def _safe_existing_file(path: Path, label: str) -> None:
    if not path.is_file():
        raise LipSyncProviderError("LIPSYNC_INPUT_MISSING", f"{label}不存在。", str(path))
    if path.stat().st_size <= 0:
        raise LipSyncProviderError("LIPSYNC_INPUT_EMPTY", f"{label}是空檔案。", str(path))


def _validate_mp4(source: Path, destination: Path) -> None:
    if not source.is_file() or source.stat().st_size < 32:
        raise LipSyncProviderError("LIPSYNC_OUTPUT_MISSING", "唇同步執行器沒有產生影片。", str(source))
    try:
        with source.open("rb") as handle:
            header = handle.read(64)
    except OSError as error:
        raise LipSyncProviderError("LIPSYNC_OUTPUT_INVALID", "無法讀取唇同步輸出。", str(error)) from error
    if len(header) < 12 or header[4:8] != b"ftyp":
        raise LipSyncProviderError("LIPSYNC_OUTPUT_INVALID", "唇同步輸出不是有效的 MP4 容器。", str(source))

    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.stem}-", suffix=".mp4.partial", dir=destination.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


class MuseTalk15Provider(LocalLipSyncProvider):
    """Bring-your-own MuseTalk 1.5 adapter for a verified local checkout.

    Evolabs deliberately does not download this runtime: MuseTalk depends on a
    collection of third-party checkpoints with separate licenses and upstream
    does not publish one atomic, versioned Windows bundle with a complete hash
    manifest.  A provider is therefore ready only after the caller points it at
    a fully installed local checkout and the official CLI can describe every
    option Evolabs relies on.
    """

    provider_id = "musetalk-1.5-local"
    display_name = "MuseTalk 1.5（本機自備）"

    _required_files = (
        "scripts/inference.py",
        "models/musetalkV15/unet.pth",
        "models/musetalkV15/musetalk.json",
        "models/whisper/config.json",
        "models/whisper/pytorch_model.bin",
        "models/whisper/preprocessor_config.json",
        "models/sd-vae/config.json",
        "models/sd-vae/diffusion_pytorch_model.bin",
        "models/dwpose/dw-ll_ucoco_384.pth",
        "models/face-parse-bisent/79999_iter.pth",
        "models/face-parse-bisent/resnet18-5c106cde.pth",
    )

    def __init__(
        self,
        python_executable: Path | None,
        repository_root: Path | None,
        ffmpeg_executable: Path | None,
        *,
        cuda_available: bool,
        vram_mb: int | None,
        generation_timeout: float = 45 * 60,
        cancel_requested: Callable[[], bool] | None = None,
        gpu_lock_path: Path | None = None,
    ) -> None:
        self.python_executable = python_executable
        self.repository_root = repository_root
        self.ffmpeg_executable = ffmpeg_executable
        self.cuda_available = cuda_available
        self.vram_mb = vram_mb
        self.generation_timeout = generation_timeout
        self.cancel_requested = cancel_requested
        self.gpu_lock_path = gpu_lock_path
        self._capability: LipSyncCapability | None = None

    @classmethod
    def from_environment(
        cls,
        environment: Mapping[str, str],
        *,
        cuda_available: bool,
        vram_mb: int | None,
        cancel_requested: Callable[[], bool] | None = None,
        gpu_lock_path: Path | None = None,
    ) -> "MuseTalk15Provider":
        def configured_path(name: str) -> Path | None:
            value = str(environment.get(name) or "").strip()
            return Path(value).expanduser() if value else None

        return cls(
            configured_path("EVOLABS_MUSETALK_PYTHON"),
            configured_path("EVOLABS_MUSETALK_ROOT"),
            configured_path("EVOLABS_FFMPEG"),
            cuda_available=cuda_available,
            vram_mb=vram_mb,
            cancel_requested=cancel_requested,
            gpu_lock_path=gpu_lock_path,
        )

    def _hardware_gate(self) -> LipSyncCapability | None:
        details = {"minimumVramMb": MINIMUM_VRAM_MB, "detectedVramMb": self.vram_mb}
        if not self.cuda_available:
            return LipSyncCapability(
                self.provider_id,
                self.display_name,
                "unavailable",
                "MuseTalk 在 Evolabs 中只允許使用 NVIDIA CUDA；CPU 模式已停用。",
                version="1.5",
                details=details,
            )
        if self.vram_mb is None or self.vram_mb < MINIMUM_VRAM_MB:
            return LipSyncCapability(
                self.provider_id,
                self.display_name,
                "unavailable",
                "MuseTalk 1.5 至少需要約 4GB 可用顯存；目前硬體未通過安全閘門。",
                version="1.5",
                details=details,
            )
        return None

    def probe(self) -> LipSyncCapability:
        gated = self._hardware_gate()
        if gated is not None:
            self._capability = gated
            return gated

        details: dict[str, Any] = {
            "minimumVramMb": MINIMUM_VRAM_MB,
            "detectedVramMb": self.vram_mb,
            "singleSubjectOnly": True,
            "maxSceneSecondsAt4Gb": MAX_SCENE_SECONDS_4GB,
            "managedInstall": False,
        }
        if self.python_executable is None or self.repository_root is None or self.ffmpeg_executable is None:
            capability = LipSyncCapability(
                self.provider_id,
                self.display_name,
                "missing",
                "尚未設定本機 MuseTalk 1.5、Python 與 FFmpeg 路徑。",
                version="1.5",
                details=details,
            )
            self._capability = capability
            return capability

        missing = []
        if not self.python_executable.is_file():
            missing.append(str(self.python_executable))
        if not self.ffmpeg_executable.is_file():
            missing.append(str(self.ffmpeg_executable))
        if not self.repository_root.is_dir():
            missing.append(str(self.repository_root))
        else:
            missing.extend(str(self.repository_root / item) for item in self._required_files if not (self.repository_root / item).is_file())
        if missing:
            details["missing"] = missing
            capability = LipSyncCapability(
                self.provider_id,
                self.display_name,
                "missing",
                "本機 MuseTalk 1.5 安裝不完整。",
                version="1.5",
                details=details,
            )
            self._capability = capability
            return capability

        try:
            result = run_cancellable(
                [str(self.python_executable), "-m", "scripts.inference", "--help"],
                timeout=30,
                cancel_requested=self.cancel_requested,
                cwd=self.repository_root,
            )
        except (OSError, subprocess.TimeoutExpired, ProcessCanceled) as error:
            capability = LipSyncCapability(
                self.provider_id,
                self.display_name,
                "invalid",
                "MuseTalk CLI 健康檢查失敗。",
                version="1.5",
                details={**details, "error": str(error)},
            )
            self._capability = capability
            return capability

        help_text = f"{result.stdout}\n{result.stderr}"
        absent = [option for option in REQUIRED_HELP_OPTIONS if not _option_present(help_text, option)]
        if result.returncode != 0 or absent:
            capability = LipSyncCapability(
                self.provider_id,
                self.display_name,
                "invalid",
                "MuseTalk CLI 版本不相容或 Python 相依套件未就緒。",
                version="1.5",
                details={**details, "exitCode": result.returncode, "missingOptions": absent},
            )
            self._capability = capability
            return capability

        capability = LipSyncCapability(
            self.provider_id,
            self.display_name,
            "ready",
            "本機 MuseTalk 1.5 已就緒（單人、FP16、最小批次）。",
            version="1.5",
            details=details,
        )
        self._capability = capability
        return capability

    def generate(self, request: LipSyncRequest, destination: Path) -> LipSyncResult:
        if self.cancel_requested is not None and self.cancel_requested():
            raise LipSyncProviderError("LIPSYNC_CANCELED", "唇同步已取消。")
        capability = self.probe()
        if self.cancel_requested is not None and self.cancel_requested():
            raise LipSyncProviderError("LIPSYNC_CANCELED", "唇同步已取消。")
        if not capability.ready:
            raise LipSyncProviderError("LIPSYNC_NOT_READY", capability.message, json.dumps(capability.details, ensure_ascii=False))
        if request.subject_count != 1:
            raise LipSyncProviderError("LIPSYNC_SINGLE_SUBJECT_ONLY", "MuseTalk 模式一次只能處理一名可見說話者。")
        if not 0 < request.duration_seconds <= MAX_SCENE_SECONDS_4GB:
            raise LipSyncProviderError(
                "LIPSYNC_DURATION_UNSAFE",
                f"4GB 顯存模式的單鏡長度必須介於 0 與 {MAX_SCENE_SECONDS_4GB:g} 秒。",
            )
        if request.fps != 25:
            raise LipSyncProviderError("LIPSYNC_FPS_UNSUPPORTED", "MuseTalk 1.5 安全模式只接受 25 FPS 輸入。")
        _safe_existing_file(request.source_video, "來源影片")
        _safe_existing_file(request.audio, "語音檔")

        assert self.python_executable is not None
        assert self.repository_root is not None
        assert self.ffmpeg_executable is not None

        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="evolabs-musetalk-", dir=destination.parent) as temporary_name:
            work = Path(temporary_name)
            if not SAFE_UPSTREAM_PATH.fullmatch(str(work)):
                raise LipSyncProviderError(
                    "LIPSYNC_UNSAFE_WORK_PATH",
                    "MuseTalk 暫存路徑含有上游 CLI 無法安全處理的字元。",
                    str(work),
                )
            source = work / "source.mp4"
            audio = work / "audio.wav"
            shutil.copyfile(request.source_video, source)
            shutil.copyfile(request.audio, audio)
            config = work / "scene.yaml"
            result_root = work / "result"
            config.write_text(
                "task_0:\n"
                f"  video_path: {json.dumps(str(source))}\n"
                f"  audio_path: {json.dumps(str(audio))}\n"
                '  result_name: "scene-output.mp4"\n',
                encoding="utf-8",
            )

            arguments = [
                str(self.python_executable),
                "-m",
                "scripts.inference",
                "--inference_config",
                str(config),
                "--result_dir",
                str(result_root),
                "--unet_model_path",
                str(self.repository_root / "models/musetalkV15/unet.pth"),
                "--unet_config",
                str(self.repository_root / "models/musetalkV15/musetalk.json"),
                "--whisper_dir",
                str(self.repository_root / "models/whisper"),
                "--ffmpeg_path",
                str(self.ffmpeg_executable.parent),
                "--version",
                "v15",
                "--fps",
                "25",
                "--batch_size",
                "1",
                "--use_float16",
            ]

            lock: GpuFileLock | None = None
            try:
                if self.gpu_lock_path is not None:
                    lock = GpuFileLock(self.gpu_lock_path)
                    lock.acquire(timeout=self.generation_timeout, cancel_requested=self.cancel_requested)
                result = run_cancellable(
                    arguments,
                    timeout=self.generation_timeout,
                    cancel_requested=self.cancel_requested,
                    cwd=self.repository_root,
                )
            except ProcessCanceled as error:
                raise LipSyncProviderError("LIPSYNC_CANCELED", "唇同步已取消。", str(error)) from error
            except GpuLockCanceled as error:
                raise LipSyncProviderError("LIPSYNC_CANCELED", "等待 GPU 時已取消唇同步。", str(error)) from error
            except GpuLockTimeout as error:
                raise LipSyncProviderError("LIPSYNC_GPU_BUSY", "等待 GPU 超時。", str(error)) from error
            except subprocess.TimeoutExpired as error:
                raise LipSyncProviderError("LIPSYNC_TIMEOUT", "MuseTalk 唇同步執行逾時。", str(error)) from error
            except OSError as error:
                raise LipSyncProviderError("LIPSYNC_PROCESS_FAILED", "無法啟動 MuseTalk。", str(error)) from error
            finally:
                if lock is not None:
                    lock.release()

            if result.returncode != 0:
                detail = f"exit={result.returncode}\n{result.stderr[-4000:]}"
                raise LipSyncProviderError("LIPSYNC_PROCESS_FAILED", "MuseTalk 唇同步執行失敗。", detail)
            _validate_mp4(result_root / "v15" / "scene-output.mp4", destination)
        return LipSyncResult(destination, self.provider_id, "1.5")
