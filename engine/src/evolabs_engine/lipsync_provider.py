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
# Windows CI and some local profiles use DOS 8.3 components such as
# RUNNER~1. Tilde is not a shell metacharacter and is safe for the fixed,
# internally generated MuseTalk work paths.
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


class LipSyncProvider(ABC):
    provider_id = "base"
    display_name = "Base lip-sync provider"

    @abstractmethod
    def probe(self) -> LipSyncCapability:
        raise NotImplementedError

    @abstractmethod
    def generate(self, request: LipSyncRequest, destination: Path) -> LipSyncResult:
        raise NotImplementedError


def _safe_existing_file(path: Path, label: str) -> None:
    if not path.exists() or not path.is_file():
        raise LipSyncProviderError("LIPSYNC_INPUT_MISSING", f"{label}不存在。", str(path))
    if path.is_symlink():
        raise LipSyncProviderError("LIPSYNC_INPUT_UNSAFE", f"{label}不可使用符號連結。", str(path))


def _contains_mp4_ftyp(path: Path) -> bool:
    try:
        data = path.read_bytes()[:64]
    except OSError:
        return False
    return len(data) >= 8 and data[4:8] == b"ftyp"


class MuseTalk15Provider(LipSyncProvider):
    provider_id = "musetalk-1.5"
    display_name = "MuseTalk 1.5"

    _required_files = (
        "scripts/inference.py",
        "models/musetalkV15/unet.pth",
        "models/musetalkV15/musetalk.json",
        "models/whisper/pytorch_model.bin",
        "models/whisper/config.json",
        "models/vae/diffusion_pytorch_model.bin",
        "models/vae/config.json",
    )

    def __init__(
        self,
        python_executable: Path | None,
        repository_root: Path | None,
        ffmpeg_executable: Path | None,
        *,
        cuda_available: bool,
        vram_mb: int,
        generation_timeout: float = 180.0,
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

    def _base_details(self) -> dict[str, Any]:
        return {
            "managedInstall": bool(self.repository_root),
            "cuda": self.cuda_available,
            "vramMb": self.vram_mb,
            "minimumVramMb": MINIMUM_VRAM_MB,
            "singleSubjectOnly": True,
            "precision": "fp16",
            "batchSize": 1,
            "fps": 25,
            "maxSceneSeconds": MAX_SCENE_SECONDS_4GB,
        }

    def probe(self) -> LipSyncCapability:
        details = self._base_details()
        if not self.cuda_available:
            capability = LipSyncCapability(
                self.provider_id,
                self.display_name,
                "unavailable",
                "MuseTalk 需要 NVIDIA CUDA 顯示卡。",
                version="1.5",
                details=details,
            )
            self._capability = capability
            return capability
        if self.vram_mb < MINIMUM_VRAM_MB:
            capability = LipSyncCapability(
                self.provider_id,
                self.display_name,
                "unavailable",
                f"MuseTalk 需要至少 {MINIMUM_VRAM_MB} MB 可用顯存。",
                version="1.5",
                details=details,
            )
            self._capability = capability
            return capability
        if not self.python_executable or not self.repository_root or not self.ffmpeg_executable:
            capability = LipSyncCapability(
                self.provider_id,
                self.display_name,
                "missing",
                "MuseTalk 執行環境尚未安裝。",
                version="1.5",
                details=details,
            )
            self._capability = capability
            return capability

        missing = [relative for relative in self._required_files if not (self.repository_root / relative).is_file()]
        if not self.python_executable.is_file():
            missing.append(str(self.python_executable))
        if not self.ffmpeg_executable.is_file():
            missing.append(str(self.ffmpeg_executable))
        if missing:
            capability = LipSyncCapability(
                self.provider_id,
                self.display_name,
                "missing",
                "MuseTalk 執行環境不完整。",
                version="1.5",
                details={**details, "missing": missing},
            )
            self._capability = capability
            return capability

        try:
            result = run_cancellable(
                [str(self.python_executable), "-m", "scripts.inference", "--help"],
                cwd=self.repository_root,
                timeout=30,
                cancel_requested=self.cancel_requested,
                capture_output=True,
                text=True,
                env={**os.environ, "PYTHONUTF8": "1"},
            )
        except ProcessCanceled:
            capability = LipSyncCapability(
                self.provider_id,
                self.display_name,
                "invalid",
                "MuseTalk 健康檢查已取消。",
                version="1.5",
                details=details,
            )
            self._capability = capability
            return capability
        except (OSError, subprocess.SubprocessError) as exc:
            capability = LipSyncCapability(
                self.provider_id,
                self.display_name,
                "invalid",
                "MuseTalk 無法啟動。",
                version="1.5",
                details={**details, "error": str(exc)},
            )
            self._capability = capability
            return capability

        help_text = f"{result.stdout or ''}\n{result.stderr or ''}"
        absent = [option for option in REQUIRED_HELP_OPTIONS if option not in help_text]
        if result.returncode != 0 or absent:
            capability = LipSyncCapability(
                self.provider_id,
                self.display_name,
                "invalid",
                "MuseTalk CLI 與 Evolabs 所需版本不相容。",
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
        # Re-probe at the execution boundary. A previous green health check must
        # not make a removed checkpoint or broken Python environment look ready.
        # The health probe intentionally converts a canceled subprocess into an
        # ``invalid`` capability so callers can display a complete health row.
        # At a render boundary, however, that same condition is a user cancel and
        # must never be misreported as a broken MuseTalk installation.
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
            # Upstream MuseTalk 1.5 invokes ffmpeg through shell strings. Copy
            # user inputs to fixed names and refuse unsafe work paths rather
            # than forwarding user-controlled shell metacharacters.
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
                "--use_float16",
                "--batch_size",
                "1",
                "--version",
                "v15",
            ]

            lock_path = self.gpu_lock_path or (destination.parent / "gpu.lock")
            try:
                with GpuFileLock(lock_path, timeout=min(30.0, self.generation_timeout), cancel_requested=self.cancel_requested):
                    result = run_cancellable(
                        arguments,
                        cwd=self.repository_root,
                        timeout=self.generation_timeout,
                        cancel_requested=self.cancel_requested,
                        capture_output=True,
                        text=True,
                        env={**os.environ, "PYTHONUTF8": "1"},
                    )
            except (ProcessCanceled, GpuLockCanceled):
                raise LipSyncProviderError("LIPSYNC_CANCELED", "唇同步已取消。") from None
            except GpuLockTimeout as exc:
                raise LipSyncProviderError("LIPSYNC_GPU_BUSY", "GPU 正在處理其他工作，MuseTalk 等候逾時。", str(exc)) from exc
            except subprocess.TimeoutExpired as exc:
                raise LipSyncProviderError("LIPSYNC_TIMEOUT", "MuseTalk 執行逾時。", str(exc)) from exc
            except OSError as exc:
                raise LipSyncProviderError("LIPSYNC_PROCESS_FAILED", "MuseTalk 無法啟動。", str(exc)) from exc

            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "").strip()[-4000:]
                raise LipSyncProviderError("LIPSYNC_PROCESS_FAILED", "MuseTalk 執行失敗。", detail)

            produced = result_root / "v15" / "scene-output.mp4"
            if not produced.is_file() or not _contains_mp4_ftyp(produced):
                raise LipSyncProviderError("LIPSYNC_OUTPUT_MISSING", "MuseTalk 未產生有效的 MP4。", str(produced))

            staged = destination.with_suffix(destination.suffix + ".part")
            shutil.copyfile(produced, staged)
            os.replace(staged, destination)

        return LipSyncResult(destination, self.provider_id, "1.5")
