from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont, UnidentifiedImageError

from .image_providers import (
    ImageGenerationRequest,
    LocalImageProvider,
    safe_generation_dimensions,
)
from .video_providers import (
    ComfyUiVideoProvider,
    GeneratedVideo,
    VideoGenerationRequest,
    VideoProviderError,
)
from .lipsync_provider import (
    LipSyncProviderError,
    LipSyncRequest,
    LocalLipSyncProvider,
    MuseTalk15Provider,
)


FINAL_STATES = {"completed", "failed", "canceled"}
CONTROL_ACTIONS = {"pause", "resume", "cancel"}
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
PREVIEW_RETENTION_JOBS = 12
PREVIEW_RETENTION_BYTES = 512 * 1024 * 1024
PREVIEW_ORPHAN_GRACE_SECONDS = 7 * 24 * 60 * 60
DEFAULT_VOICE_PROFILE = "中性・自然"
VOICE_PROFILES = ("青年・自然", "少女・清冷", DEFAULT_VOICE_PROFILE, "成熟・沉穩")


class RenderError(RuntimeError):
    def __init__(self, code: str, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


class RenderCanceled(Exception):
    pass


@dataclass(frozen=True)
class RuntimeInfo:
    ffmpeg: Path
    font: Path | None
    chinese_voice_available: bool


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _read_json(path: Path, maximum_bytes: int = 64 * 1024 * 1024) -> Any:
    size = path.stat().st_size
    if size > maximum_bytes:
        raise RenderError("INPUT_TOO_LARGE", "輸入資料超過 Evolabs 的安全限制。", f"{path}: {size} bytes")
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def _safe_scene_preview_name(scene_id: str, index: int) -> str:
    """Return a stable filename that never incorporates untrusted path text."""
    digest = hashlib.sha256(scene_id.encode("utf-8")).hexdigest()[:16]
    return f"scene-{index + 1:03d}-{digest}.png"


def _preview_directory_size(path: Path) -> int:
    total = 0
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                try:
                    if entry.is_file(follow_symlinks=False):
                        total += entry.stat(follow_symlinks=False).st_size
                except OSError:
                    continue
    except OSError:
        return 0
    return total


def _prune_preview_directories(
    jobs_directory: Path,
    current_job_id: str,
    *,
    max_jobs: int = PREVIEW_RETENTION_JOBS,
    max_bytes: int = PREVIEW_RETENTION_BYTES,
    now: float | None = None,
) -> None:
    """Bound retained terminal/orphan previews without touching live jobs."""
    if max_jobs < 0 or max_bytes < 0:
        raise ValueError("preview retention limits must not be negative")
    timestamp = time.time() if now is None else now
    candidates: list[tuple[float, int, Path]] = []
    try:
        job_directories = list(jobs_directory.iterdir())
    except OSError:
        return
    for job_directory in job_directories:
        if not job_directory.is_dir() or job_directory.name == current_job_id:
            continue
        preview_directory = job_directory / "previews"
        try:
            preview_mtime = preview_directory.stat().st_mtime
        except OSError:
            continue
        terminal = False
        try:
            status = _read_json(job_directory / "status.json", 1024 * 1024)
            terminal = isinstance(status, dict) and status.get("state") in FINAL_STATES
        except (OSError, json.JSONDecodeError, RenderError):
            pass
        # A missing/corrupt status may belong to a process that is still starting.
        # It is eligible only after a generous orphan grace period.
        if not terminal and timestamp - preview_mtime < PREVIEW_ORPHAN_GRACE_SECONDS:
            continue
        candidates.append((preview_mtime, _preview_directory_size(preview_directory), preview_directory))

    retained_jobs = 0
    retained_bytes = 0
    for _mtime, size, preview_directory in sorted(candidates, key=lambda value: value[0], reverse=True):
        if retained_jobs < max_jobs and retained_bytes + size <= max_bytes:
            retained_jobs += 1
            retained_bytes += size
            continue
        shutil.rmtree(preview_directory, ignore_errors=True)


def _persist_scene_preview(source: Path, destination: Path) -> None:
    """Atomically retain the exact rendered frame used for scene encoding."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        shutil.copyfile(source, temporary)
        with temporary.open("rb") as handle:
            if handle.read(8) != b"\x89PNG\r\n\x1a\n":
                raise RenderError("PREVIEW_INVALID", "逐鏡預覽不是有效的 PNG 圖片。")
        os.replace(temporary, destination)
    except RenderError:
        raise
    except OSError as error:
        raise RenderError("PREVIEW_WRITE_FAILED", "無法保存逐鏡預覽。", str(error)) from error
    finally:
        temporary.unlink(missing_ok=True)


def _run_process(arguments: list[str], timeout: float, code: str, message: str) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            arguments,
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
        raise RenderError(code, message, str(error)) from error
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or f"exit code {result.returncode}").strip()
        raise RenderError(code, message, detail[-8000:])
    return result


def find_ffmpeg() -> Path:
    configured = os.environ.get("EVOLABS_FFMPEG") or os.environ.get("IMAGEIO_FFMPEG_EXE")
    if configured:
        candidate = Path(configured).expanduser()
        if candidate.is_file():
            return candidate.resolve()
        raise RenderError("FFMPEG_MISSING", "指定的 FFmpeg 執行檔不存在。", str(candidate))

    try:
        import imageio_ffmpeg

        candidate = Path(imageio_ffmpeg.get_ffmpeg_exe())
        if candidate.is_file():
            return candidate.resolve()
    except Exception:
        pass

    system = shutil.which("ffmpeg")
    if system:
        return Path(system).resolve()
    raise RenderError("FFMPEG_MISSING", "找不到影片核心元件 FFmpeg。")


def _font_candidates() -> list[Path]:
    configured = os.environ.get("EVOLABS_FONT")
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured).expanduser())
    windir = Path(os.environ.get("WINDIR", r"C:\Windows"))
    candidates.extend(
        [
            windir / "Fonts" / "msjh.ttc",
            windir / "Fonts" / "msjhbd.ttc",
            windir / "Fonts" / "mingliu.ttc",
            Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
            Path("/usr/share/fonts/opentype/noto/NotoSansCJKtc-Regular.otf"),
            Path("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            Path("/Library/Fonts/Arial Unicode.ttf"),
        ]
    )
    return candidates


def find_font() -> Path | None:
    return next((path.resolve() for path in _font_candidates() if path.is_file()), None)


def _windows_chinese_voice_available() -> bool:
    if os.name != "nt" or not shutil.which("powershell.exe"):
        return False
    script = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
  if ($voice) { exit 0 }
  exit 3
}
finally { $synth.Dispose() }
""".strip()
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=8,
            check=False,
            creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def runtime_info(*, probe_voice: bool = True) -> RuntimeInfo:
    return RuntimeInfo(find_ffmpeg(), find_font(), probe_voice and _windows_chinese_voice_available())


def _load_font(font_path: Path | None, size: int) -> ImageFont.ImageFont:
    if font_path:
        try:
            return ImageFont.truetype(str(font_path), size=size)
        except OSError:
            pass
    try:
        return ImageFont.load_default(size=max(10, size // 2))
    except TypeError:
        return ImageFont.load_default()


def _text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> float:
    try:
        return float(draw.textlength(text, font=font))
    except Exception:
        return float(len(text) * 12)


def _wrap_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.ImageFont,
    maximum_width: int,
    maximum_lines: int,
) -> list[str]:
    normalized = " ".join(str(text or "").replace("\r", " ").replace("\n", " ").split())
    if not normalized:
        return []
    lines: list[str] = []
    current = ""
    for character in normalized:
        proposed = current + character
        if current and _text_width(draw, proposed, font) > maximum_width:
            lines.append(current.rstrip())
            current = character.lstrip()
            if len(lines) >= maximum_lines:
                break
        else:
            current = proposed
    if len(lines) < maximum_lines and current:
        lines.append(current.rstrip())
    consumed = "".join(lines)
    if len(consumed) < len(normalized) and lines:
        tail = lines[-1]
        while tail and _text_width(draw, tail + "…", font) > maximum_width:
            tail = tail[:-1]
        lines[-1] = tail.rstrip() + "…"
    return lines


def _draw_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int, int] | tuple[int, int, int],
) -> None:
    try:
        draw.text(xy, text, font=font, fill=fill)
    except (UnicodeEncodeError, OSError):
        draw.text(xy, text.encode("ascii", "replace").decode("ascii"), font=font, fill=fill)


def _hex_color(value: Any, fallback: tuple[int, int, int]) -> tuple[int, int, int]:
    if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        return tuple(int(value[index : index + 2], 16) for index in (1, 3, 5))  # type: ignore[return-value]
    return fallback


def _palette(seed_text: str, realistic: bool) -> tuple[tuple[int, int, int], tuple[int, int, int], tuple[int, int, int]]:
    digest = hashlib.blake2b(seed_text.encode("utf-8"), digest_size=8).digest()
    if realistic:
        base = (14 + digest[0] % 18, 15 + digest[1] % 18, 18 + digest[2] % 20)
        glow = (92 + digest[3] % 70, 74 + digest[4] % 60, 66 + digest[5] % 70)
    else:
        base = (12 + digest[0] % 18, 12 + digest[1] % 18, 18 + digest[2] % 24)
        glow = (68 + digest[3] % 100, 78 + digest[4] % 100, 112 + digest[5] % 110)
    accent = (180 + digest[6] % 65, 184 + digest[7] % 60, 205 + digest[0] % 45)
    return base, glow, accent


def _render_card(
    project: dict[str, Any],
    scene: dict[str, Any],
    scene_number: int,
    size: tuple[int, int],
    destination: Path,
    font_path: Path | None,
    captions: bool,
) -> None:
    width, height = size
    seed_text = f"{scene.get('id', '')}|{scene.get('visual', '')}|{project.get('title', '')}"
    realistic = project.get("settings", {}).get("mode") == "realistic"
    base, glow, accent = _palette(seed_text, realistic)
    image = Image.new("RGB", size, base)
    draw = ImageDraw.Draw(image, "RGBA")

    for y in range(height):
        ratio = y / max(1, height - 1)
        ease = math.sin(ratio * math.pi) ** 2
        color = tuple(int(base[channel] * (1 - ease * 0.32) + glow[channel] * ease * 0.32) for channel in range(3))
        draw.line((0, y, width, y), fill=(*color, 255))

    digest = hashlib.blake2b(seed_text.encode("utf-8"), digest_size=16).digest()
    for index in range(5):
        radius = int(width * (0.16 + (digest[index] / 255) * 0.32))
        center_x = int((digest[index + 5] / 255) * width)
        center_y = int((digest[index + 10] / 255) * height * 0.72)
        alpha = 14 + digest[index] % 26
        draw.ellipse(
            (center_x - radius, center_y - radius, center_x + radius, center_y + radius),
            fill=(*glow, alpha),
        )

    margin = max(24, int(width * 0.065))
    small = _load_font(font_path, max(16, int(width * 0.028)))
    meta = _load_font(font_path, max(18, int(width * 0.034)))
    title_font = _load_font(font_path, max(28, int(width * 0.062)))
    body = _load_font(font_path, max(20, int(width * 0.039)))
    dialogue_font = _load_font(font_path, max(23, int(width * 0.044)))

    _draw_text(draw, (margin, margin), "evolabs", small, (255, 255, 255, 215))
    shot_label = f"SCENE {scene_number:02d}  ·  {str(scene.get('shot') or '中景・固定鏡頭')[:30]}"
    _draw_text(draw, (margin, margin + int(width * 0.055)), shot_label, small, (*accent, 220))

    characters_by_id = {
        item.get("id"): item
        for item in project.get("characters", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    character_ids = [value for value in scene.get("characterIds", []) if value in characters_by_id]
    silhouette_count = max(1, min(3, len(character_ids) or 1))
    ground_y = int(height * 0.67)
    spread = width / (silhouette_count + 1)
    for index in range(silhouette_count):
        character = characters_by_id.get(character_ids[index], {}) if index < len(character_ids) else {}
        color = _hex_color(character.get("accent"), accent)
        center_x = int(spread * (index + 1))
        head_radius = max(20, int(width * 0.055))
        body_width = max(56, int(width * 0.14))
        body_height = max(120, int(height * 0.19))
        head_y = ground_y - body_height - head_radius
        draw.ellipse(
            (center_x - head_radius, head_y - head_radius, center_x + head_radius, head_y + head_radius),
            fill=(*color, 235),
        )
        draw.rounded_rectangle(
            (center_x - body_width // 2, head_y + head_radius, center_x + body_width // 2, ground_y),
            radius=body_width // 2,
            fill=(*color, 205),
        )
        name = str(character.get("name") or "角色")[:12]
        name_width = _text_width(draw, name, small)
        _draw_text(draw, (int(center_x - name_width / 2), ground_y + 12), name, small, (255, 255, 255, 190))

    title = str(scene.get("title") or f"第 {scene_number} 鏡")
    title_y = int(height * 0.17)
    for line_index, line in enumerate(_wrap_text(draw, title, title_font, width - margin * 2, 2)):
        _draw_text(draw, (margin, title_y + line_index * int(width * 0.078)), line, title_font, (255, 255, 255, 245))

    visual_y = title_y + int(width * 0.18)
    for line_index, line in enumerate(_wrap_text(draw, str(scene.get("visual") or ""), body, width - margin * 2, 3)):
        _draw_text(draw, (margin, visual_y + line_index * int(width * 0.056)), line, body, (231, 233, 239, 205))

    if captions:
        dialogue = str(scene.get("dialogue") or "").strip()
        panel_height = max(int(height * 0.16), int(width * 0.27))
        panel_top = height - panel_height - margin
        draw.rounded_rectangle(
            (margin, panel_top, width - margin, height - margin),
            radius=max(18, int(width * 0.035)),
            fill=(5, 6, 8, 205),
            outline=(255, 255, 255, 24),
            width=1,
        )
        if dialogue:
            lines = _wrap_text(draw, dialogue, dialogue_font, width - margin * 3, 3)
            line_height = max(30, int(width * 0.058))
            block_height = len(lines) * line_height
            start_y = panel_top + max(18, (panel_height - block_height) // 2)
            for line_index, line in enumerate(lines):
                _draw_text(draw, (margin + margin // 2, start_y + line_index * line_height), line, dialogue_font, (255, 255, 255, 245))
        else:
            _draw_text(draw, (margin + margin // 2, panel_top + panel_height // 2 - 12), "（無對白）", meta, (210, 213, 220, 170))

    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, format="PNG", optimize=True)


def _normalize_reference_image(raw: bytes, destination: Path) -> Path:
    if len(raw) > 10 * 1024 * 1024:
        raise RenderError("REFERENCE_IMAGE_TOO_LARGE", "角色參考圖超過 10 MB 安全限制。")
    try:
        with Image.open(io.BytesIO(raw)) as opened:
            if opened.width < 32 or opened.height < 32 or opened.width * opened.height > 20_000_000:
                raise RenderError(
                    "REFERENCE_IMAGE_INVALID",
                    "角色參考圖尺寸不正確。",
                    f"{opened.width}x{opened.height}",
                )
            opened.load()
            image = opened.convert("RGB")
    except RenderError:
        raise
    except (OSError, UnidentifiedImageError) as error:
        raise RenderError("REFERENCE_IMAGE_INVALID", "角色參考圖無法解碼。", str(error)) from error
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.stem}-{uuid.uuid4().hex}.partial.png")
    try:
        image.save(temporary, format="PNG", optimize=True)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def _materialize_reference(character: dict[str, Any], reference_directory: Path) -> Path | None:
    character_id = str(character.get("id") or "character")
    identifier_hash = hashlib.blake2b(character_id.encode("utf-8"), digest_size=6).hexdigest()
    readable_id = re.sub(r"[^A-Za-z0-9._-]", "-", character_id)[:64] or "character"
    safe_id = f"{readable_id}-{identifier_hash}"
    destination = reference_directory / f"{safe_id}.png"
    if destination.is_file():
        return destination
    data_url = character.get("referenceImageDataUrl")
    if isinstance(data_url, str) and data_url:
        match = re.fullmatch(r"data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\r\n]+)", data_url, re.IGNORECASE)
        if not match or len(match.group(2)) > 14 * 1024 * 1024:
            raise RenderError("REFERENCE_IMAGE_INVALID", "角色參考圖 Data URL 格式不正確。")
        try:
            raw = base64.b64decode(re.sub(r"\s+", "", match.group(2)), validate=True)
        except (ValueError, binascii.Error) as error:
            raise RenderError("REFERENCE_IMAGE_INVALID", "角色參考圖 Base64 編碼不正確。", str(error)) from error
        return _normalize_reference_image(raw, destination)
    raw_path = character.get("referenceImagePath")
    if isinstance(raw_path, str) and raw_path.strip():
        source = Path(raw_path).expanduser()
        if not source.is_file():
            raise RenderError("REFERENCE_IMAGE_MISSING", "找不到角色參考圖。", str(source))
        if source.stat().st_size > 10 * 1024 * 1024:
            raise RenderError("REFERENCE_IMAGE_TOO_LARGE", "角色參考圖超過 10 MB 安全限制。", str(source))
        try:
            raw = source.read_bytes()
        except OSError as error:
            raise RenderError("REFERENCE_IMAGE_INVALID", "無法讀取角色參考圖。", str(error)) from error
        return _normalize_reference_image(raw, destination)
    return None


def _scene_reference(
    project: dict[str, Any], scene: dict[str, Any], reference_directory: Path
) -> tuple[Path | None, float]:
    characters = {
        item.get("id"): item
        for item in project.get("characters", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    reference_characters: list[tuple[dict[str, Any], float]] = []
    for character_id in scene.get("characterIds", []):
        character = characters.get(character_id)
        if not character:
            continue
        has_path = isinstance(character.get("referenceImagePath"), str) and character.get("referenceImagePath", "").strip()
        has_data = isinstance(character.get("referenceImageDataUrl"), str) and character.get("referenceImageDataUrl", "").strip()
        if not has_path and not has_data:
            continue
        try:
            strength = float(character.get("consistencyStrength", 0.72))
        except (TypeError, ValueError):
            strength = 0.72
        reference_characters.append((character, max(0.1, min(1.5, strength))))
    # stable-diffusion.cpp accepts one IP-Adapter image per invocation. We only
    # condition a single-character shot instead of pretending multiple faces are locked.
    if len(reference_characters) != 1:
        return None, 0.72
    character, strength = reference_characters[0]
    return _materialize_reference(character, reference_directory), strength


_LOCAL_PROMPT_CUES = (
    ("夜晚", "night"), ("白天", "daylight"), ("黃昏", "sunset"), ("清晨", "dawn"),
    ("城市", "city"), ("街道", "street"), ("校園", "school campus"), ("教室", "classroom"),
    ("鐘樓", "clock tower"), ("醫院", "hospital"), ("辦公室", "office"), ("屋頂", "rooftop"),
    ("森林", "forest"), ("海邊", "seaside"), ("車站", "train station"), ("餐廳", "restaurant"),
    ("雨", "rain"), ("雪", "snow"), ("霓虹", "neon lights"), ("火", "fire"),
    ("黑色短髮", "short black hair"), ("黑色長髮", "long black hair"),
    ("制服", "uniform"), ("西裝", "suit"), ("洋裝", "dress"), ("年輕", "young adult"),
    ("微笑", "smiling"), ("悲傷", "sad"), ("憤怒", "angry"), ("緊張", "tense"),
    ("奔跑", "running"), ("走", "walking"), ("對話", "talking"),
    ("近景", "close-up"), ("中景", "medium shot"), ("廣角", "wide shot"),
    ("固定鏡頭", "static camera"), ("推進", "dolly in"), ("平移", "camera pan"),
)


def _local_english_prompt_cues(*values: str) -> str:
    source = " ".join(values)
    cues = list(dict.fromkeys(english for chinese, english in _LOCAL_PROMPT_CUES if chinese in source))
    return ", ".join(cues[:24])



def _production_bible(project: dict[str, Any]) -> dict[str, Any]:
    direct = project.get("productionBible")
    if isinstance(direct, dict):
        return direct
    workspace = project.get("agentWorkspace")
    if isinstance(workspace, dict):
        artifacts = workspace.get("artifacts")
        if isinstance(artifacts, dict):
            return artifacts
    return {}


def _character_reference_request(
    project: dict[str, Any], character: dict[str, Any], character_number: int
) -> ImageGenerationRequest:
    settings = project.get("settings") if isinstance(project.get("settings"), dict) else {}
    nested = settings.get("imageGeneration") if isinstance(settings.get("imageGeneration"), dict) else {}
    mode = settings.get("mode", "anime")
    bible = _production_bible(project)
    art = bible.get("artDirection") if isinstance(bible.get("artDirection"), dict) else {}
    style = str(
        art.get("globalPrompt")
        or art.get("visualBible")
        or (
            "cinematic anime character design, clean line art, production-ready character sheet"
            if mode == "anime"
            else "cinematic live-action casting reference, realistic skin and wardrobe, production-ready character sheet"
        )
    )[:1800]
    name = str(character.get("name") or f"character {character_number}")[:80]
    role = str(character.get("role") or "character")[:120]
    appearance = str(character.get("appearancePrompt") or character.get("appearance") or "")[:2200]
    identity = str(character.get("identityAnchor") or "")[:1400]
    wardrobe = str(character.get("wardrobe") or "")[:900]
    expression = str(character.get("expressionGuide") or "")[:700]
    prompt = ", ".join(
        part
        for part in [
            style,
            "one person only, isolated full-body character reference, front three-quarter view, neutral standing pose",
            "plain unobtrusive studio background, identity reference asset, consistent facial proportions",
            f"character name: {name}",
            f"role: {role}",
            appearance,
            identity,
            wardrobe,
            expression,
            "no text labels, no split panels, no duplicate person",
        ]
        if part
    )
    default_negative = (
        "multiple people, duplicate person, group photo, collage, split panel, cropped head, cropped feet, "
        "different face, different hairstyle, different wardrobe, age change, deformed anatomy, extra limbs, "
        "bad hands, text, watermark, logo, low quality, blurry"
    )
    negative = ", ".join(
        part
        for part in [
            str(art.get("globalNegativePrompt") or "")[:1200],
            str(character.get("negativePrompt") or "")[:1000],
            str(nested.get("negativePrompt") or "")[:1000],
            default_negative,
        ]
        if part
    )[:3200]
    quality = settings.get("quality") if settings.get("quality") in {"speed", "balanced", "cinema"} else "balanced"
    steps = {"speed": 8, "balanced": 12, "cinema": 20}[quality]
    try:
        steps = max(4, min(30, int(nested.get("steps", steps))))
    except (TypeError, ValueError):
        pass
    try:
        cfg_scale = max(1.0, min(15.0, float(nested.get("cfgScale", 6.0))))
    except (TypeError, ValueError):
        cfg_scale = 6.0
    raw_seed = character.get("seed")
    try:
        seed = int(raw_seed) if raw_seed is not None else -1
    except (TypeError, ValueError):
        seed = -1
    if seed < 0:
        material = f"{project.get('id')}|character|{character.get('id')}|{name}|{identity}|{character_number}"
        seed = int.from_bytes(hashlib.blake2b(material.encode("utf-8"), digest_size=4).digest(), "big") & 0x7FFFFFFF
    return ImageGenerationRequest(
        prompt=prompt,
        negative_prompt=negative,
        width=448,
        height=768,
        steps=steps,
        cfg_scale=cfg_scale,
        seed=seed,
        quality=quality,
        reference_image=None,
        consistency_strength=0.0,
    )


def _valid_reference_asset(path: Path, expected_size: tuple[int, int] | None = None) -> bool:
    try:
        if not path.is_file() or path.stat().st_size < 64 or path.stat().st_size > 32 * 1024 * 1024:
            return False
        with Image.open(path) as image:
            image.load()
            if image.width < 128 or image.height < 128 or image.width * image.height > 20_000_000:
                return False
            if expected_size is not None and image.size != expected_size:
                return False
        return True
    except (OSError, UnidentifiedImageError):
        return False


def _scene_ai_request(
    project: dict[str, Any],
    scene: dict[str, Any],
    scene_number: int,
    reference_directory: Path,
    *,
    allow_reference: bool = True,
) -> ImageGenerationRequest:
    settings = project.get("settings") if isinstance(project.get("settings"), dict) else {}
    nested = settings.get("imageGeneration") if isinstance(settings.get("imageGeneration"), dict) else {}
    bible = _production_bible(project)
    art = bible.get("artDirection") if isinstance(bible.get("artDirection"), dict) else {}
    ip_bible = bible.get("ipBible") if isinstance(bible.get("ipBible"), dict) else {}
    locations = bible.get("locations") if isinstance(bible.get("locations"), list) else []
    mode = settings.get("mode", "anime")
    default_style = (
        "high quality anime cinematic frame, clean line art, detailed background, consistent character design"
        if mode == "anime"
        else "cinematic realistic film still, natural skin texture, detailed lighting, photorealistic"
    )
    style = str(art.get("globalPrompt") or art.get("visualBible") or default_style).strip()[:2200]

    location_by_id = {
        item.get("id"): item
        for item in locations
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    location = location_by_id.get(scene.get("locationId"))
    location_prompt = ""
    location_negative = ""
    if isinstance(location, dict):
        location_prompt = "; ".join(
            dict.fromkeys(
                part
                for part in (
                    str(location.get("prompt") or "").strip(),
                    str(location.get("environmentAnchor") or "").strip(),
                    str(location.get("lighting") or "").strip(),
                    str(location.get("timeOfDay") or "").strip(),
                    str(location.get("weather") or "").strip(),
                    ", ".join(str(item).strip() for item in location.get("keyProps", []) if str(item).strip())
                    if isinstance(location.get("keyProps"), list)
                    else "",
                )
                if part
            )
        )[:1800]
        location_negative = str(location.get("negativePrompt") or "").strip()[:1200]

    characters = {
        item.get("id"): item
        for item in project.get("characters", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    appearances: list[str] = []
    character_negatives: list[str] = []
    for character_id in scene.get("characterIds", []):
        character = characters.get(character_id)
        if not character:
            continue
        name = str(character.get("name") or "character")[:80]
        identity_parts = [
            str(character.get("appearancePrompt") or "").strip(),
            str(character.get("identityAnchor") or "").strip(),
            str(character.get("appearance") or "").strip(),
            str(character.get("wardrobe") or "").strip(),
        ]
        appearance = "; ".join(dict.fromkeys(part for part in identity_parts if part))[:1800]
        appearances.append(f"{name}: {appearance}" if appearance else name)
        character_negative = str(character.get("negativePrompt") or "").strip()
        if character_negative:
            character_negatives.append(character_negative[:800])

    shot = str(scene.get("shot") or "medium shot")[:240]
    visual = str(
        scene.get("startFramePrompt")
        or scene.get("visual")
        or scene.get("title")
        or "cinematic scene"
    )[:3600]
    composition = str(scene.get("composition") or "").strip()[:1000]
    action = str(scene.get("action") or "").strip()[:1200]
    emotion = str(scene.get("emotion") or "").strip()[:700]
    motion = str(scene.get("motionPrompt") or "").strip()[:900]

    prompt_parts = [style, location_prompt, visual, f"camera composition: {shot}", composition, action, emotion]
    if appearances:
        prompt_parts.append("locked cast identity: " + "; ".join(appearances))
    continuity = "; ".join(
        part
        for part in (
            str(scene.get("continuityIn") or "").strip(),
            str(scene.get("continuityOut") or "").strip(),
        )
        if part
    )[:1000]
    if continuity:
        prompt_parts.append("continuity constraints: " + continuity)
    if motion:
        prompt_parts.append("intended shot motion: " + motion)

    continuity_rules = ip_bible.get("continuityRules") if isinstance(ip_bible.get("continuityRules"), list) else []
    prohibited_changes = ip_bible.get("prohibitedChanges") if isinstance(ip_bible.get("prohibitedChanges"), list) else []
    if continuity_rules:
        prompt_parts.append(
            "production continuity bible: "
            + "; ".join(str(item).strip() for item in continuity_rules[:8] if str(item).strip())[:1300]
        )
    if prohibited_changes:
        prompt_parts.append(
            "must not change: "
            + "; ".join(str(item).strip() for item in prohibited_changes[:8] if str(item).strip())[:1000]
        )

    local_cues = _local_english_prompt_cues(visual, shot, location_prompt, action, emotion, *appearances)
    if local_cues:
        prompt_parts.append("local semantic cues: " + local_cues)
    custom_prefix = str(nested.get("promptPrefix") or "").strip()[:1000]
    if custom_prefix:
        prompt_parts.insert(0, custom_prefix)
    prompt = ", ".join(part for part in prompt_parts if part)[:7800]

    default_negative = (
        "low quality, worst quality, blurry, deformed, bad anatomy, extra fingers, extra limbs, "
        "duplicate person, text, watermark, logo, identity drift, wardrobe change, location drift"
    )
    negative_parts = [
        str(nested.get("negativePrompt") or default_negative).strip(),
        str(art.get("globalNegativePrompt") or "").strip(),
        location_negative,
        *character_negatives,
        str(scene.get("negativePrompt") or "").strip(),
    ]
    negative = ", ".join(dict.fromkeys(part for part in negative_parts if part))[:5000]

    quality = settings.get("quality") if settings.get("quality") in {"speed", "balanced", "cinema"} else "balanced"
    steps = {"speed": 8, "balanced": 12, "cinema": 20}[quality]
    try:
        steps = max(4, min(30, int(nested.get("steps", steps))))
    except (TypeError, ValueError):
        pass
    try:
        cfg_scale = max(1.0, min(15.0, float(nested.get("cfgScale", 6.0))))
    except (TypeError, ValueError):
        cfg_scale = 6.0
    raw_seed = scene.get("seed", nested.get("seed"))
    try:
        seed = int(raw_seed) if raw_seed is not None else -1
    except (TypeError, ValueError):
        seed = -1
    if seed < 0:
        material = f"{project.get('id')}|{scene.get('id')}|{visual}|{scene_number}"
        seed = int.from_bytes(hashlib.blake2b(material.encode("utf-8"), digest_size=4).digest(), "big") & 0x7FFFFFFF
    reference, strength = _scene_reference(project, scene, reference_directory) if allow_reference else (None, 0.72)
    width, height = safe_generation_dimensions(settings)
    return ImageGenerationRequest(
        prompt=prompt,
        negative_prompt=negative,
        width=width,
        height=height,
        steps=steps,
        cfg_scale=cfg_scale,
        seed=seed,
        quality=quality,
        reference_image=reference,
        consistency_strength=strength,
    )


def _render_ai_card(
    source: Path,
    scene: dict[str, Any],
    scene_number: int,
    size: tuple[int, int],
    destination: Path,
    font_path: Path | None,
    captions: bool,
) -> None:
    try:
        with Image.open(source) as opened:
            opened.load()
            image = opened.convert("RGB")
    except (OSError, UnidentifiedImageError) as error:
        raise RenderError("AI_IMAGE_INVALID", "AI 分鏡圖片無法解碼。", str(error)) from error
    width, height = size
    source_ratio = image.width / image.height
    target_ratio = width / height
    if source_ratio > target_ratio:
        resized_height = height
        resized_width = math.ceil(height * source_ratio)
    else:
        resized_width = width
        resized_height = math.ceil(width / source_ratio)
    image = image.resize((resized_width, resized_height), Image.Resampling.LANCZOS)
    left = max(0, (resized_width - width) // 2)
    top = max(0, (resized_height - height) // 2)
    image = image.crop((left, top, left + width, top + height))
    draw = ImageDraw.Draw(image, "RGBA")
    margin = max(24, int(width * 0.055))
    small = _load_font(font_path, max(16, int(width * 0.027)))
    dialogue_font = _load_font(font_path, max(23, int(width * 0.044)))

    # Minimal overlays preserve the generated art while keeping subtitles legible.
    draw.rectangle((0, 0, width, int(height * 0.105)), fill=(0, 0, 0, 95))
    _draw_text(draw, (margin, margin), "evolabs", small, (255, 255, 255, 225))
    shot_label = f"SCENE {scene_number:02d}  ·  {str(scene.get('shot') or '中景')[:30]}"
    _draw_text(draw, (margin, margin + int(width * 0.048)), shot_label, small, (235, 237, 244, 205))
    if captions:
        dialogue = str(scene.get("dialogue") or "").strip()
        if dialogue:
            panel_height = max(int(height * 0.14), int(width * 0.25))
            panel_top = height - panel_height - margin
            draw.rounded_rectangle(
                (margin, panel_top, width - margin, height - margin),
                radius=max(18, int(width * 0.035)),
                fill=(5, 6, 8, 205),
                outline=(255, 255, 255, 28),
                width=1,
            )
            lines = _wrap_text(draw, dialogue, dialogue_font, width - margin * 3, 3)
            line_height = max(30, int(width * 0.058))
            start_y = panel_top + max(18, (panel_height - len(lines) * line_height) // 2)
            for line_index, line in enumerate(lines):
                _draw_text(
                    draw,
                    (margin + margin // 2, start_y + line_index * line_height),
                    line,
                    dialogue_font,
                    (255, 255, 255, 245),
                )
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, format="PNG", optimize=True)


def _normalize_voice_profile(value: Any) -> str:
    if not isinstance(value, str):
        return DEFAULT_VOICE_PROFILE
    profile = value.strip()
    return profile if profile in VOICE_PROFILES else DEFAULT_VOICE_PROFILE


def _scene_voice_profile(project: dict[str, Any], scene: dict[str, Any]) -> str:
    """Resolve the speaker without pretending one scene can mix several SAPI voices."""
    characters = [entry for entry in project.get("characters", []) if isinstance(entry, dict)]
    by_id = {
        str(entry.get("id")): entry
        for entry in characters
        if isinstance(entry.get("id"), str) and str(entry.get("id")).strip()
    }
    scene_characters = [
        by_id[character_id]
        for character_id in scene.get("characterIds", [])
        if isinstance(character_id, str) and character_id in by_id
    ]

    # Multi-character scenes still contain a single dialogue string.  When it
    # starts with a known "角色名：" prefix, only use that role if the project
    # also lists the role in this scene.  A contradictory off-scene label is
    # treated as ambiguous instead of silently assigning the wrong voice.
    dialogue = str(scene.get("dialogue", "")).lstrip()
    matching_characters = [
        character
        for character in characters
        if (name := str(character.get("name", "")).strip())
        and re.match(rf"^{re.escape(name)}\s*[：:]", dialogue)
    ]
    if matching_characters:
        matching_scene_characters = [character for character in matching_characters if character in scene_characters]
        if len(matching_scene_characters) == 1:
            return _normalize_voice_profile(matching_scene_characters[0].get("voice"))
        return DEFAULT_VOICE_PROFILE
    if len(scene_characters) == 1:
        return _normalize_voice_profile(scene_characters[0].get("voice"))
    return DEFAULT_VOICE_PROFILE


def _spoken_dialogue(project: dict[str, Any], scene: dict[str, Any]) -> str:
    """Remove a recognized speaker label from speech while keeping captions intact."""
    dialogue = str(scene.get("dialogue", "")).lstrip()
    labels = [
        str(character.get("name", "")).strip()
        for character in project.get("characters", [])
        if isinstance(character, dict) and str(character.get("name", "")).strip()
    ]
    labels.extend(("旁白", "畫外音", "內心"))
    for label in labels:
        match = re.match(rf"^{re.escape(label)}\s*[：:]\s*", dialogue)
        if match:
            return dialogue[match.end():].strip()
    return dialogue


def _try_windows_tts(
    text: str,
    destination: Path,
    working_directory: Path,
    voice_profile: str = DEFAULT_VOICE_PROFILE,
) -> bool:
    if os.name != "nt" or not text.strip() or not shutil.which("powershell.exe"):
        return False
    input_path = working_directory / "tts-input.txt"
    input_path.write_text(text, encoding="utf-8")
    script = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh*' })
  if ($voices.Count -eq 0) { throw 'No enabled Chinese SAPI voice is installed.' }
  $profile = [string]$env:EVOLABS_TTS_PROFILE
  $voice = $voices | Where-Object { $_.VoiceInfo.Name -eq $profile } | Select-Object -First 1
  $rate = 0
  if (-not $voice) {
    switch ($profile) {
      '青年・自然' {
        $voice = $voices | Where-Object { $_.VoiceInfo.Gender.ToString() -eq 'Male' } | Select-Object -First 1
        $rate = 1
      }
      '少女・清冷' {
        $voice = $voices | Where-Object { $_.VoiceInfo.Gender.ToString() -eq 'Female' } | Select-Object -First 1
        $rate = 1
      }
      '成熟・沉穩' {
        $voice = $voices | Where-Object { $_.VoiceInfo.Gender.ToString() -eq 'Male' } | Select-Object -First 1
        $rate = -2
      }
    }
  }
  if (-not $voice) { $voice = $voices | Select-Object -First 1 }
  $synth.SelectVoice($voice.VoiceInfo.Name)
  $synth.Rate = $rate
  $synth.Volume = 100
  $synth.SetOutputToWaveFile($env:EVOLABS_TTS_OUTPUT)
  $text = [System.IO.File]::ReadAllText($env:EVOLABS_TTS_INPUT, [System.Text.Encoding]::UTF8)
  $synth.Speak($text)
}
finally { $synth.Dispose() }
""".strip()
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    environment = os.environ.copy()
    environment["EVOLABS_TTS_INPUT"] = str(input_path)
    environment["EVOLABS_TTS_OUTPUT"] = str(destination)
    environment["EVOLABS_TTS_PROFILE"] = _normalize_voice_profile(voice_profile)
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            timeout=90,
            check=False,
            creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    if result.returncode != 0 or not destination.is_file() or destination.stat().st_size < 128:
        destination.unlink(missing_ok=True)
        return False
    try:
        with wave.open(str(destination), "rb") as handle:
            return handle.getnframes() > 0 and handle.getframerate() > 0
    except (OSError, wave.Error):
        destination.unlink(missing_ok=True)
        return False


def _wave_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as handle:
            return handle.getnframes() / max(1, handle.getframerate())
    except (OSError, wave.Error):
        return 0.0


def _motion_filter(shot: str, width: int, height: int, duration: float, fps: int) -> str:
    normalized = str(shot or "")[:100]
    if "推進" in normalized:
        return (
            f"scale={width}:{height},"
            f"zoompan=z='min(zoom+0.00065,1.055)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
            f"d=1:s={width}x{height}:fps={fps}"
        )

    scale_factor = 1.08 if "平移" in normalized or "近景" in normalized else 1.04
    scaled_width = math.ceil(width * scale_factor / 2) * 2
    scaled_height = math.ceil(height * scale_factor / 2) * 2
    if "平移" in normalized:
        frames = max(1, int(duration * fps) - 1)
        return (
            f"scale={scaled_width}:{scaled_height},"
            f"crop={width}:{height}:x='(in_w-out_w)*n/{frames}':y='(in_h-out_h)/2',fps={fps}"
        )
    if "晃動" in normalized:
        return (
            f"scale={scaled_width}:{scaled_height},"
            f"crop={width}:{height}:"
            "x='(in_w-out_w)/2+((in_w-out_w)/2)*0.65*sin(n*0.71)':"
            "y='(in_h-out_h)/2+((in_h-out_h)/2)*0.55*cos(n*0.53)',"
            f"fps={fps}"
        )
    if "近景" in normalized or "特寫" in normalized:
        return (
            f"scale={scaled_width}:{scaled_height},"
            f"crop={width}:{height}:x='(in_w-out_w)/2':y='(in_h-out_h)/2',fps={fps}"
        )
    return f"scale={width}:{height},fps={fps}"


def _encode_scene(
    ffmpeg: Path,
    card: Path,
    voice: Path | None,
    destination: Path,
    duration: float,
    size: tuple[int, int],
    quality: str,
    shot: str,
    fps: int = 24,
) -> None:
    width, height = size
    fade = min(0.28, max(0.12, duration / 5))
    fade_out = max(fade, duration - fade)
    temporary = destination.with_name(f".{destination.stem}.partial.mp4")
    temporary.unlink(missing_ok=True)
    arguments = [
        str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
        "-loop", "1", "-framerate", str(fps), "-i", str(card),
    ]
    if voice:
        arguments.extend(["-i", str(voice)])
    else:
        arguments.extend(["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"])
    video_filter = (
        f"[0:v]{_motion_filter(shot, width, height, duration, fps)},"
        f"fade=t=in:st=0:d={fade:.3f},fade=t=out:st={fade_out:.3f}:d={fade:.3f},format=yuv420p[v]"
    )
    audio_filter = (
        f"[1:a]aresample=48000,apad=pad_dur={duration:.3f},atrim=duration={duration:.3f},"
        f"afade=t=in:st=0:d={fade:.3f},afade=t=out:st={fade_out:.3f}:d={fade:.3f}[a]"
    )
    encoder_preset, crf = {
        "speed": ("ultrafast", "25"),
        "cinema": ("medium", "18"),
    }.get(quality, ("veryfast", "21"))
    arguments.extend(
        [
            "-filter_complex", f"{video_filter};{audio_filter}",
            "-map", "[v]", "-map", "[a]", "-t", f"{duration:.3f}",
            "-c:v", "libx264", "-preset", encoder_preset, "-crf", crf,
            "-pix_fmt", "yuv420p", "-r", str(fps), "-g", str(fps * 2),
            "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
            "-movflags", "+faststart", "-f", "mp4", str(temporary),
        ]
    )
    _run_process(arguments, max(120, duration * 20), "FFMPEG_SCENE_FAILED", "無法合成其中一個鏡頭。")
    if not temporary.is_file() or temporary.stat().st_size < 1024:
        raise RenderError("FFMPEG_SCENE_EMPTY", "鏡頭合成沒有產生有效影片。", str(destination))
    os.replace(temporary, destination)



def _render_video_overlay(
    scene: dict[str, Any],
    size: tuple[int, int],
    font_path: Path | None,
    captions: bool,
    destination: Path,
) -> Path | None:
    if not captions or not str(scene.get("dialogue") or "").strip():
        return None
    width, height = size
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(image, "RGBA")
    margin = max(24, int(width * 0.055))
    dialogue_font = _load_font(font_path, max(23, int(width * 0.044)))
    dialogue = str(scene.get("dialogue") or "").strip()
    panel_height = max(int(height * 0.14), int(width * 0.25))
    panel_top = height - panel_height - margin
    draw.rounded_rectangle(
        (margin, panel_top, width - margin, height - margin),
        radius=max(18, int(width * 0.035)),
        fill=(5, 6, 8, 205),
        outline=(255, 255, 255, 38),
        width=1,
    )
    lines = _wrap_text(draw, dialogue, dialogue_font, width - margin * 3, 3)
    line_height = max(30, int(width * 0.058))
    start_y = panel_top + max(18, (panel_height - len(lines) * line_height) // 2)
    for line_index, line in enumerate(lines):
        _draw_text(
            draw,
            (margin + margin // 2, start_y + line_index * line_height),
            line,
            dialogue_font,
            (255, 255, 255, 245),
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, format="PNG", optimize=True)
    return destination


def _encode_video_scene(
    ffmpeg: Path,
    source_video: Path,
    overlay: Path | None,
    voice: Path | None,
    destination: Path,
    duration: float,
    size: tuple[int, int],
    quality: str,
    fps: int,
) -> None:
    width, height = size
    fade = min(0.24, max(0.10, duration / 7))
    fade_out = max(fade, duration - fade)
    temporary = destination.with_name(f".{destination.stem}.partial.mp4")
    temporary.unlink(missing_ok=True)
    arguments = [str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y", "-i", str(source_video)]
    overlay_index: int | None = None
    if overlay is not None:
        overlay_index = 1
        arguments.extend(["-loop", "1", "-i", str(overlay)])
    audio_index = 2 if overlay_index is not None else 1
    if voice is not None:
        arguments.extend(["-i", str(voice)])
    else:
        arguments.extend(["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"])

    base_filter = (
        f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},fps={fps},"
        f"tpad=stop_mode=clone:stop_duration={duration:.3f},"
        f"trim=duration={duration:.3f},setpts=PTS-STARTPTS[base]"
    )
    if overlay_index is not None:
        video_filter = (
            f"{base_filter};[base][{overlay_index}:v]overlay=0:0:format=auto,"
            f"fade=t=in:st=0:d={fade:.3f},fade=t=out:st={fade_out:.3f}:d={fade:.3f},format=yuv420p[v]"
        )
    else:
        video_filter = (
            f"{base_filter};[base]fade=t=in:st=0:d={fade:.3f},"
            f"fade=t=out:st={fade_out:.3f}:d={fade:.3f},format=yuv420p[v]"
        )
    audio_filter = (
        f"[{audio_index}:a]aresample=48000,apad=pad_dur={duration:.3f},atrim=duration={duration:.3f},"
        f"afade=t=in:st=0:d={fade:.3f},afade=t=out:st={fade_out:.3f}:d={fade:.3f}[a]"
    )
    encoder_preset, crf = {
        "speed": ("ultrafast", "25"),
        "cinema": ("medium", "18"),
    }.get(quality, ("veryfast", "21"))
    arguments.extend([
        "-filter_complex", f"{video_filter};{audio_filter}",
        "-map", "[v]", "-map", "[a]", "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-preset", encoder_preset, "-crf", crf,
        "-pix_fmt", "yuv420p", "-r", str(fps), "-g", str(fps * 2),
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", "-f", "mp4", str(temporary),
    ])
    _run_process(arguments, max(300, duration * 40), "FFMPEG_VIDEO_SCENE_FAILED", "無法整理影片模型輸出的鏡頭。")
    if not temporary.is_file() or temporary.stat().st_size < 2048:
        raise RenderError("FFMPEG_VIDEO_SCENE_EMPTY", "影片模型鏡頭沒有產生有效的 MP4。", str(destination))
    _validate_video(ffmpeg, temporary)
    os.replace(temporary, destination)


def _probe_video_duration(ffmpeg: Path, path: Path) -> float:
    try:
        result = subprocess.run(
            [str(ffmpeg), "-hide_banner", "-i", str(path), "-f", "null", "-"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
            check=False,
            creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RenderError("VIDEO_DURATION_PROBE_FAILED", "無法檢查影片鏡頭長度。", str(error)) from error
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr or "")
    if not match:
        raise RenderError("VIDEO_DURATION_PROBE_FAILED", "影片鏡頭缺少可辨識的長度資訊。")
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def _video_quality_checks(ffmpeg: Path, path: Path, expected_duration: float) -> tuple[list[dict[str, Any]], bool]:
    checks: list[dict[str, Any]] = []
    _validate_video(ffmpeg, path)
    checks.append({"id": "decode", "label": "影片可完整解碼", "state": "passed", "detail": "FFmpeg 已完整解碼影片與音訊串流。"})
    measured = _probe_video_duration(ffmpeg, path)
    tolerance = max(0.75, expected_duration * 0.22)
    duration_ok = abs(measured - expected_duration) <= tolerance
    checks.append({
        "id": "duration",
        "label": "影片長度符合分鏡",
        "state": "passed" if duration_ok else "failed",
        "detail": f"預期 {expected_duration:.2f} 秒；實際 {measured:.2f} 秒。",
    })

    black = _run_process(
        [str(ffmpeg), "-hide_banner", "-loglevel", "info", "-i", str(path), "-vf", "blackdetect=d=0.35:pix_th=0.10", "-an", "-f", "null", "-"],
        300,
        "VIDEO_BLACK_CHECK_FAILED",
        "無法檢查影片黑畫面。",
    )
    black_durations = [float(value) for value in re.findall(r"black_duration:([0-9.]+)", black.stderr or "")]
    excessive_black = sum(black_durations) > max(0.8, expected_duration * 0.35)
    checks.append({
        "id": "black-frame",
        "label": "黑畫面檢查",
        "state": "failed" if excessive_black else "passed",
        "detail": "偵測到過長黑畫面。" if excessive_black else "未偵測到會阻斷成片的長黑畫面。",
    })

    frozen = _run_process(
        [str(ffmpeg), "-hide_banner", "-loglevel", "info", "-i", str(path), "-vf", "freezedetect=n=-50dB:d=1.0", "-an", "-f", "null", "-"],
        300,
        "VIDEO_FREEZE_CHECK_FAILED",
        "無法檢查影片凍結畫面。",
    )
    freeze_durations = [float(value) for value in re.findall(r"lavfi\.freezedetect\.freeze_duration: ([0-9.]+)", frozen.stderr or "")]
    excessive_freeze = max(freeze_durations, default=0.0) > max(1.5, expected_duration * 0.5)
    checks.append({
        "id": "frozen-frame",
        "label": "動態連續性檢查",
        "state": "failed" if excessive_freeze else "passed",
        "detail": "鏡頭大部分時間沒有可辨識動態。" if excessive_freeze else "未偵測到會阻斷成片的長時間凍結。",
    })
    checks.append({
        "id": "semantic-safety",
        "label": "人物與內容語意安全",
        "state": "unavailable",
        "detail": "本機尚未配置可靠的視覺語意檢查模型；因此此鏡頭必須由使用者人工核准。",
    })
    checks.append({
        "id": "human-review",
        "label": "人工鏡頭核准",
        "state": "pending",
        "detail": "只有使用者核准後，這個鏡頭才會進入最終成片。",
    })
    return checks, duration_ok and not excessive_black and not excessive_freeze


def _review_file(job_directory: Path, scene_id: str) -> Path:
    digest = hashlib.sha256(scene_id.encode("utf-8")).hexdigest()
    return job_directory / "reviews" / f"{digest}.json"

def _concat_scenes(ffmpeg: Path, clips: list[Path], destination: Path, working_directory: Path) -> None:
    if not clips:
        raise RenderError("NO_SCENES", "沒有可合併的鏡頭。")
    list_path = working_directory / "concat.txt"
    relative_lines = []
    for clip in clips:
        relative = clip.relative_to(working_directory).as_posix()
        if "'" in relative or "\n" in relative or "\r" in relative:
            raise RenderError("UNSAFE_PATH", "鏡頭路徑包含不支援的字元。", relative)
        relative_lines.append(f"file '{relative}'")
    list_path.write_text("\n".join(relative_lines) + "\n", encoding="utf-8")
    partial = destination.with_name(f".{destination.stem}.partial.mp4")
    partial.unlink(missing_ok=True)
    try:
        _run_process(
            [
                str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
                "-f", "concat", "-safe", "0", "-i", str(list_path),
                "-c", "copy", "-movflags", "+faststart", "-f", "mp4", str(partial),
            ],
            300,
            "FFMPEG_EXPORT_FAILED",
            "無法合併最終影片。",
        )
        if not partial.is_file() or partial.stat().st_size < 2048:
            raise RenderError("FFMPEG_EXPORT_EMPTY", "最終輸出是空白或不完整的影片。")
        _validate_video(ffmpeg, partial)
        os.replace(partial, destination)
    finally:
        partial.unlink(missing_ok=True)


def _validate_video(ffmpeg: Path, path: Path) -> None:
    if not path.is_file() or path.stat().st_size < 2048:
        raise RenderError("OUTPUT_INVALID", "影片輸出不存在或檔案不完整。", str(path))
    with path.open("rb") as handle:
        header = handle.read(12)
    if len(header) < 12 or header[4:8] != b"ftyp":
        raise RenderError("OUTPUT_INVALID", "輸出檔案不是有效的 MP4。", str(path))
    _run_process(
        [
            str(ffmpeg), "-hide_banner", "-loglevel", "error", "-i", str(path),
            "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-",
        ],
        300,
        "OUTPUT_DECODE_FAILED",
        "影片驗證失敗，因此不會標示為完成。",
    )


def _safe_output_name(title: Any, job_id: str) -> str:
    normalized = re.sub(r"[<>:\"/\\|?*\x00-\x1f]", "-", str(title or "Evolabs 短劇")).strip(" .-")
    normalized = re.sub(r"\s+", " ", normalized)[:48] or "Evolabs 短劇"
    return f"{normalized}-{job_id[-8:]}.mp4"


def _completion_message(dialogue_scenes: int, voiced_scenes: int, captions: bool) -> str:
    if dialogue_scenes == 0:
        return "影片已完成並通過本機驗證；這個專案沒有需要配音的對白。"
    if voiced_scenes == dialogue_scenes:
        return "影片已完成並通過本機驗證；中文系統語音已加入。"
    if voiced_scenes > 0:
        fallback = "其餘對白已保留字幕與安靜音軌。" if captions else "其餘對白使用安靜音軌；字幕已關閉。"
        return f"影片已完成；部分對白已加入系統語音，{fallback}"
    fallback = "因此使用字幕與安靜音軌。" if captions else "因此使用安靜音軌；字幕已關閉。"
    return f"影片已完成；未偵測到可用中文系統語音，{fallback}"


def _safe_scene_id(value: Any) -> bool:
    return (
        isinstance(value, str)
        and bool(value.strip())
        and len(value) <= 256
        and not any(ord(character) < 32 or ord(character) == 127 for character in value)
    )


def _validate_project(
    project: Any,
    sample_limit: int | None,
    scene_id: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if sample_limit is not None and scene_id is not None:
        raise RenderError("INVALID_RENDER_SCOPE", "單鏡生成不能同時使用試看片段限制。")
    if scene_id is not None and not _safe_scene_id(scene_id):
        raise RenderError("INVALID_SCENE_ID", "指定的分鏡識別碼不安全或格式不正確。")
    if not isinstance(project, dict):
        raise RenderError("INVALID_PROJECT", "專案資料不是有效物件。")
    project_id = project.get("id")
    if not isinstance(project_id, str) or not project_id.strip() or len(project_id) > 256:
        raise RenderError("INVALID_PROJECT", "專案缺少有效識別碼。")
    settings = project.get("settings", {})
    if not isinstance(settings, dict):
        raise RenderError("INVALID_PROJECT", "專案設定格式不正確。")
    if settings.get("mode", "anime") not in {"anime", "realistic"}:
        raise RenderError("INVALID_PROJECT", "專案圖片風格不受支援。")
    raw_visual_mode = settings.get("visualMode", "motion-comic")
    if raw_visual_mode not in {"ai-video", "motion-comic", "cards", "ai-images"}:
        raise RenderError("INVALID_PROJECT", "專案畫面生成模式不受支援。")
    if raw_visual_mode == "ai-video":
        provider = project.get("_videoProvider")
        if not isinstance(provider, dict) or provider.get("kind") != "comfyui":
            raise RenderError("VIDEO_PROVIDER_NOT_CONFIGURED", "AI 影片模式必須連接可用的本機 ComfyUI 影片模型服務。")
    raw_scenes = project.get("scenes")
    if not isinstance(raw_scenes, list) or not raw_scenes:
        raise RenderError("NO_SCENES", "至少需要一個分鏡才能生成影片。")
    if len(raw_scenes) > 240:
        raise RenderError("TOO_MANY_SCENES", "單一工作最多支援 240 個分鏡。")
    characters = project.get("characters", [])
    if not isinstance(characters, list) or len(characters) > 24:
        raise RenderError("TOO_MANY_CHARACTERS", "單一專案最多支援 24 個角色。")
    character_ids: set[str] = set()
    for character_index, character in enumerate(characters):
        if not isinstance(character, dict):
            raise RenderError("INVALID_CHARACTER", f"第 {character_index + 1} 個角色格式不正確。")
        character_id = character.get("id")
        if (
            not isinstance(character_id, str)
            or not character_id.strip()
            or len(character_id) > 256
            or character_id in character_ids
        ):
            raise RenderError("INVALID_CHARACTER", f"第 {character_index + 1} 個角色缺少唯一識別碼。")
        character_ids.add(character_id)
        for field, maximum in (("name", 128), ("role", 256), ("appearance", 4000), ("voice", 128)):
            value = character.get(field, "")
            if not isinstance(value, str) or len(value) > maximum:
                raise RenderError("INVALID_CHARACTER", f"角色「{character_id}」的 {field} 欄位格式不正確。")
        reference_path = character.get("referenceImagePath")
        if reference_path is not None and (not isinstance(reference_path, str) or len(reference_path) > 4096):
            raise RenderError("INVALID_REFERENCE", f"角色「{character_id}」的參考圖路徑不正確。")
        reference_data = character.get("referenceImageDataUrl")
        if reference_data is not None:
            if (
                not isinstance(reference_data, str)
                or not reference_data.startswith("data:image/")
                or len(reference_data) > 14 * 1024 * 1024
            ):
                raise RenderError("INVALID_REFERENCE", f"角色「{character_id}」的參考圖資料不正確或過大。")
    validated_scenes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_scenes):
        if not isinstance(raw, dict):
            raise RenderError("INVALID_SCENE", f"第 {index + 1} 鏡格式不正確。")
        raw_scene_id = raw.get("id")
        if not _safe_scene_id(raw_scene_id) or raw_scene_id in seen:
            raise RenderError("INVALID_SCENE", f"第 {index + 1} 鏡缺少唯一識別碼。")
        seen.add(raw_scene_id)
        try:
            duration = float(raw.get("duration", 5))
        except (TypeError, ValueError) as error:
            raise RenderError("INVALID_DURATION", f"第 {index + 1} 鏡秒數不正確。") from error
        if not math.isfinite(duration):
            raise RenderError("INVALID_DURATION", f"第 {index + 1} 鏡秒數不正確。")
        scene = dict(raw)
        # Keep the stable, one-based position from the complete project. A
        # single-scene retry must not silently change prompt seeds or framing
        # merely because the selected scene becomes item zero in the job.
        scene["_evolabsSceneNumber"] = index + 1
        scene["duration"] = max(1.0, min(30.0, duration))
        for field in (
            "title", "visual", "dialogue", "shot", "composition", "action", "emotion",
            "startFramePrompt", "endFramePrompt", "motionPrompt", "videoPrompt", "negativePrompt",
            "transition", "continuityIn", "continuityOut", "reviewFeedback",
        ):
            raw_value = scene.get(field, "")
            if raw_value is not None and not isinstance(raw_value, str):
                raise RenderError("INVALID_SCENE", f"第 {index + 1} 鏡的 {field} 欄位格式不正確。")
            value = raw_value or ""
            if len(value) > 8000:
                raise RenderError("TEXT_TOO_LARGE", f"第 {index + 1} 鏡文字超過安全限制。")
            scene[field] = value
        raw_character_ids = scene.get("characterIds", [])
        if not isinstance(raw_character_ids, list) or len(raw_character_ids) > 24:
            raise RenderError("INVALID_SCENE_CHARACTERS", f"第 {index + 1} 鏡的角色清單格式不正確。")
        normalized_character_ids: list[str] = []
        for character_id in raw_character_ids:
            if (
                not isinstance(character_id, str)
                or character_id not in character_ids
                or character_id in normalized_character_ids
            ):
                raise RenderError("INVALID_SCENE_CHARACTERS", f"第 {index + 1} 鏡引用了不存在或重複的角色。")
            normalized_character_ids.append(character_id)
        scene["characterIds"] = normalized_character_ids
        validated_scenes.append(scene)
    if scene_id is not None:
        selected = [scene for scene in validated_scenes if scene["id"] == scene_id]
        if not selected:
            raise RenderError("SCENE_NOT_FOUND", "指定的分鏡不存在於目前專案。", scene_id)
        return project, selected
    if sample_limit is not None:
        limit = max(1, min(3, int(sample_limit)))
        return project, validated_scenes[:limit]
    return project, validated_scenes


class RenderJob:
    def __init__(
        self,
        data_root: Path,
        job_id: str,
        project: dict[str, Any],
        sample_limit: int | None = None,
        image_provider: LocalImageProvider | None = None,
        scene_id: str | None = None,
        lip_sync_provider: LocalLipSyncProvider | None = None,
    ) -> None:
        if not re.fullmatch(r"job_[0-9a-fA-F-]{36}", job_id):
            raise RenderError("INVALID_JOB_ID", "工作識別碼格式不正確。")
        self.project, self.scenes = _validate_project(project, sample_limit, scene_id)
        self.data_root = data_root.resolve()
        self.job_id = job_id
        self.scope = "scene" if scene_id is not None else ("sample" if sample_limit is not None else "full")
        self.job_directory = self.data_root / "jobs" / job_id
        self.previews_directory = self.job_directory / "previews"
        self.work_directory = self.job_directory / "work"
        self.shots_directory = self.work_directory / "shots"
        project_key = hashlib.blake2b(str(self.project.get("id") or "project").encode("utf-8"), digest_size=8).hexdigest()
        self.character_assets_directory = self.data_root / "assets" / "characters" / project_key
        self.output_directory = self.data_root / "outputs"
        self.status_path = self.job_directory / "status.json"
        self.control_path = self.job_directory / "control.json"
        self.started = time.monotonic()
        self.info = runtime_info()
        settings = self.project.get("settings") if isinstance(self.project.get("settings"), dict) else {}
        raw_visual_mode = settings.get("visualMode", "motion-comic")
        self.visual_mode = "ai-video" if raw_visual_mode == "ai-video" else "motion-comic"
        # Kept only for backward-compatible constructor calls. The active renderer never
        # invokes still-image providers for AI video generation.
        _ = image_provider
        self.video_provider: ComfyUiVideoProvider | None = None
        self.video_provider_error: VideoProviderError | None = None
        if self.visual_mode == "ai-video":
            try:
                self.video_provider = ComfyUiVideoProvider.from_project(
                    self.project, cancel_requested=lambda: self._control_action() == "cancel"
                )
            except VideoProviderError as error:
                self.video_provider_error = error
        self.lip_sync_requested = settings.get("lipSync") is True
        self.lip_sync_provider = lip_sync_provider
        self.lip_sync_capability = None
        self.lip_sync_error: LipSyncProviderError | None = None
        if self.lip_sync_requested:
            if self.visual_mode == "ai-video":
                self.lip_sync_error = LipSyncProviderError(
                    "LIPSYNC_NOT_IMPLEMENTED_FOR_VIDEO",
                    "AI 影片模式目前尚未支援經驗證的本機口型同步。請先關閉口型同步。",
                )
            elif self.visual_mode != "motion-comic":
                self.lip_sync_error = LipSyncProviderError(
                    "LIPSYNC_MODE_INVALID",
                    "目前生成模式不支援口型同步。",
                )
            else:
                if self.lip_sync_provider is None:
                    provider_environment = dict(os.environ)
                    provider_environment.setdefault("EVOLABS_FFMPEG", str(self.info.ffmpeg))
                    try:
                        raw_vram = str(provider_environment.get("EVOLABS_VRAM_MB") or "").strip()
                        vram_mb = int(raw_vram) if raw_vram else None
                    except ValueError:
                        vram_mb = None
                    nvidia_flag = str(provider_environment.get("EVOLABS_NVIDIA_AVAILABLE") or "").strip().lower()
                    cuda_available = nvidia_flag in {"1", "true", "yes"} or bool(vram_mb and vram_mb > 0)
                    self.lip_sync_provider = MuseTalk15Provider.from_environment(
                        provider_environment,
                        cuda_available=cuda_available,
                        vram_mb=vram_mb,
                        cancel_requested=lambda: self._control_action() == "cancel",
                        gpu_lock_path=self.data_root / "locks" / "gpu.lock",
                    )
                try:
                    self.lip_sync_capability = self.lip_sync_provider.probe()
                    if not self.lip_sync_capability.ready:
                        self.lip_sync_error = LipSyncProviderError(
                            "LIPSYNC_NOT_READY",
                            self.lip_sync_capability.message,
                            json.dumps(self.lip_sync_capability.details, ensure_ascii=False),
                        )
                except LipSyncProviderError as error:
                    self.lip_sync_error = error
        format_name = settings.get("format", "9:16")
        self.quality = settings.get("quality") if settings.get("quality") in {"speed", "balanced", "cinema"} else "balanced"
        self.captions = settings.get("captions") is not False
        self.size = {"9:16": (720, 1280), "16:9": (1280, 720), "1:1": (1080, 1080)}.get(format_name, (720, 1280))
        self.status: dict[str, Any] = {
            "schemaVersion": 1,
            "jobId": job_id,
            "projectId": self.project["id"],
            "scope": self.scope,
            "visualMode": self.visual_mode,
            "aiProvider": "comfyui-local" if self.visual_mode == "ai-video" and self.video_provider else None,
            "lipSyncProvider": self.lip_sync_capability.provider_id if self.lip_sync_capability and self.lip_sync_capability.ready else None,
            "state": "queued",
            "stage": "idle",
            "overallProgress": 0.0,
            "sceneProgress": 0.0,
            "elapsedSeconds": 0,
            "activeSceneId": None,
            "characterAssets": [
                {
                    "characterId": character.get("id"),
                    "name": character.get("name") or "角色",
                    "state": "queued",
                    "progress": 0.0,
                    "previewPath": character.get("referenceImagePath") if isinstance(character.get("referenceImagePath"), str) else None,
                    "generated": False,
                }
                for character in self.project.get("characters", [])
                if isinstance(character, dict)
            ],
            "scenes": [
                {
                    "sceneId": scene["id"],
                    "sceneNumber": scene["_evolabsSceneNumber"],
                    "state": "queued",
                    "progress": 0.0,
                    "previewPath": None,
                    "visualSource": None,
                    "generationAttempt": 0,
                    "reviewState": None,
                    "reviewFeedback": None,
                    "qualityChecks": [],
                    "providerId": None,
                    "modelName": None,
                }
                for scene in self.scenes
            ],
            "outputPath": None,
            "outputBytes": None,
            "message": "已建立本機影片工作。",
            "error": None,
            "enginePid": os.getpid(),
            "engineStartToken": uuid.uuid4().hex,
            "engineStartedAtUnixMs": int(time.time() * 1000),
        }

    def _write(self) -> None:
        self.status["elapsedSeconds"] = max(0, int(time.monotonic() - self.started))
        self.status["updatedAtUnixMs"] = int(time.time() * 1000)
        _atomic_write_json(self.status_path, self.status)

    def _progress(self, index: int, scene_progress: float, stage: str, message: str) -> None:
        scene_progress = max(0.0, min(100.0, scene_progress))
        self.status["state"] = "running"
        self.status["stage"] = stage
        self.status["activeSceneId"] = self.scenes[index]["id"]
        self.status["sceneProgress"] = scene_progress
        self.status["overallProgress"] = min(92.0, 10.0 + ((index + scene_progress / 100) / len(self.scenes)) * 82.0)
        self.status["message"] = message
        snapshot = self.status["scenes"][index]
        snapshot["state"] = "working"
        snapshot["progress"] = scene_progress
        self._write()

    def _control_action(self) -> str | None:
        if not self.control_path.is_file():
            return None
        try:
            control = _read_json(self.control_path, 64 * 1024)
        except (OSError, json.JSONDecodeError, RenderError):
            return None
        if not isinstance(control, dict) or control.get("jobId") not in (None, self.job_id):
            return None
        action = control.get("action")
        return action if action in CONTROL_ACTIONS else None

    def checkpoint(self) -> None:
        action = self._control_action()
        if action == "cancel":
            self.status["state"] = "canceling"
            self.status["message"] = "正在安全停止工作…"
            self._write()
            raise RenderCanceled()
        if action != "pause":
            return
        self.status["state"] = "pausing"
        self.status["message"] = "正在目前的安全邊界暫停…"
        self._write()
        self.status["state"] = "paused"
        self.status["message"] = "工作已安全暫停。"
        self._write()
        last_heartbeat = time.monotonic()
        while True:
            time.sleep(0.25)
            action = self._control_action()
            if action == "cancel":
                self.status["state"] = "canceling"
                self.status["message"] = "正在安全停止工作…"
                self._write()
                raise RenderCanceled()
            if action == "resume":
                self.status["state"] = "running"
                self.status["message"] = "工作已繼續。"
                self._write()
                return
            if time.monotonic() - last_heartbeat >= 2.0:
                self._write()
                last_heartbeat = time.monotonic()

    def _scene_reference_image(self, scene: dict[str, Any]) -> Path | None:
        by_id = {
            str(character.get("id")): character
            for character in self.project.get("characters", [])
            if isinstance(character, dict) and isinstance(character.get("id"), str)
        }
        references: list[dict[str, Any]] = []
        for character_id in scene.get("characterIds", []):
            character = by_id.get(str(character_id))
            if not isinstance(character, dict):
                continue
            has_path = isinstance(character.get("referenceImagePath"), str) and bool(character.get("referenceImagePath", "").strip())
            has_data = isinstance(character.get("referenceImageDataUrl"), str) and bool(character.get("referenceImageDataUrl", "").strip())
            if has_path or has_data:
                references.append(character)
        # A single reference image is safe and unambiguous. Multiple characters require
        # an explicitly prepared group reference; choosing one person would misrepresent
        # identity consistency.
        if len(references) != 1:
            return None
        return _materialize_reference(references[0], self.work_directory / "references")

    def _scene_video_prompt(self, scene: dict[str, Any], feedback: str = "") -> tuple[str, str]:
        characters = {
            str(character.get("id")): character
            for character in self.project.get("characters", [])
            if isinstance(character, dict) and isinstance(character.get("id"), str)
        }
        character_rules: list[str] = []
        negative_rules: list[str] = []
        for character_id in scene.get("characterIds", []):
            character = characters.get(str(character_id))
            if not isinstance(character, dict):
                continue
            name = str(character.get("name") or "角色")
            age = str(character.get("age") or "劇本指定年齡")
            wardrobe = str(character.get("wardrobe") or "完整且符合場景的服裝")
            appearance = str(character.get("identityAnchor") or character.get("appearance") or "固定外觀")
            character_rules.append(f"{name}：{age}，{wardrobe}，{appearance}")
            if character.get("negativePrompt"):
                negative_rules.append(str(character.get("negativePrompt")))
        prompt = str(scene.get("videoPrompt") or "").strip()
        if not prompt:
            prompt = ", ".join(
                item
                for item in (
                    str(scene.get("visual") or ""),
                    str(scene.get("action") or ""),
                    str(scene.get("emotion") or ""),
                    str(scene.get("motionPrompt") or scene.get("shot") or ""),
                    str(scene.get("composition") or ""),
                )
                if item.strip()
            )
        prompt = (
            f"{prompt}. Character continuity: {'; '.join(character_rules) or 'no visible people'}. "
            "Every visible person has one normal head, exactly two eyes, anatomically normal arms and legs, "
            "complete non-transparent clothing appropriate to the scene, stable age and identity. "
            "Real temporal motion, coherent physical action, continuous camera movement, no still-image pan or slideshow."
        )
        if feedback.strip():
            prompt += f" User review correction for this retry: {feedback.strip()}"
        negative = ", ".join(
            item
            for item in (
                str(scene.get("negativePrompt") or ""),
                *negative_rules,
                "nudity, exposed genitals, exposed breasts, transparent clothing, missing clothes, underwear-only, "
                "multiple eyes, extra eyes, extra face, duplicate head, extra limbs, missing limbs, deformed hands, "
                "wrong age, elderly appearance when not specified, child-adult age drift, identity drift, wardrobe drift, "
                "body horror, fused people, duplicated people, random text, watermark, frozen slideshow, static Ken Burns image",
            )
            if item.strip()
        )
        return prompt[:20_000], negative[:12_000]

    def _await_scene_review(self, index: int, scene: dict[str, Any], attempt: int) -> tuple[bool, str]:
        scene_id = str(scene["id"])
        path = _review_file(self.job_directory, scene_id)
        path.unlink(missing_ok=True)
        snapshot = self.status["scenes"][index]
        snapshot["state"] = "review"
        snapshot["progress"] = 92.0
        snapshot["reviewState"] = "pending"
        snapshot["generationAttempt"] = attempt
        self.status["state"] = "awaiting-review"
        self.status["stage"] = "review"
        self.status["activeSceneId"] = scene_id
        self.status["sceneProgress"] = 92.0
        self.status["overallProgress"] = min(92.0, 10.0 + ((index + 0.92) / len(self.scenes)) * 82.0)
        self.status["message"] = "影片模型鏡頭已完成。請檢查人物、年齡、服裝、人體與動作後核准或退回。"
        self._write()
        last_heartbeat = time.monotonic()
        while True:
            self.checkpoint()
            if path.is_file():
                try:
                    review = _read_json(path, 64 * 1024)
                except (OSError, json.JSONDecodeError, RenderError):
                    path.unlink(missing_ok=True)
                    continue
                if (
                    isinstance(review, dict)
                    and review.get("jobId") == self.job_id
                    and review.get("sceneId") == scene_id
                    and isinstance(review.get("approved"), bool)
                ):
                    path.unlink(missing_ok=True)
                    approved = bool(review["approved"])
                    feedback = str(review.get("feedback") or "").strip()[:4000]
                    snapshot["reviewState"] = "approved" if approved else "rejected"
                    snapshot["reviewFeedback"] = feedback
                    for check in snapshot.get("qualityChecks", []):
                        if isinstance(check, dict) and check.get("id") == "human-review":
                            check["state"] = "passed" if approved else "failed"
                            check["detail"] = "使用者已核准此鏡頭。" if approved else f"使用者退回：{feedback}"
                    self.status["state"] = "running"
                    self.status["stage"] = "review"
                    self.status["message"] = "鏡頭已核准。" if approved else "鏡頭已退回，準備依意見重新生成。"
                    self._write()
                    return approved, feedback
            if time.monotonic() - last_heartbeat >= 2.0:
                self._write()
                last_heartbeat = time.monotonic()
            time.sleep(0.25)

    def _run_ai_video(self) -> dict[str, Any]:
        if self.video_provider_error is not None:
            raise RenderError(
                self.video_provider_error.code,
                self.video_provider_error.message,
                self.video_provider_error.detail,
            )
        if self.video_provider is None:
            raise RenderError("VIDEO_PROVIDER_NOT_CONFIGURED", "AI 影片模式已選取，但影片模型服務尚未完成設定。")
        if self.lip_sync_requested:
            raise RenderError(
                "LIPSYNC_NOT_IMPLEMENTED_FOR_VIDEO",
                "AI 影片模式目前尚未支援經驗證的本機口型同步。請關閉口型同步後再生成。",
            )
        self.video_provider.probe()
        settings = self.project.get("settings") if isinstance(self.project.get("settings"), dict) else {}
        max_attempts = max(1, min(5, int(settings.get("maxShotRetries", 3))))
        clips: list[Path] = []
        voiced_scenes = 0
        dialogue_scenes = 0
        for index, scene in enumerate(self.scenes):
            scene_number = int(scene["_evolabsSceneNumber"])
            scene_root = self.work_directory / f"scene-{scene_number:03d}"
            scene_root.mkdir(parents=True, exist_ok=True)
            voice = scene_root / "voice.wav"
            speech_text = _spoken_dialogue(self.project, scene)
            if speech_text:
                dialogue_scenes += 1
            voice_profile = _scene_voice_profile(self.project, scene)
            has_voice = self.info.chinese_voice_available and _try_windows_tts(speech_text, voice, scene_root, voice_profile)
            if has_voice:
                voiced_scenes += 1
            voice_path = voice if has_voice else None
            duration = float(scene["duration"])
            if voice_path:
                duration = min(30.0, max(duration, _wave_duration(voice_path) + 0.35))
            feedback = str(scene.get("reviewFeedback") or "")
            approved_clip: Path | None = None
            for attempt in range(1, max_attempts + 1):
                self.checkpoint()
                self._progress(index, 8.0, "motion", f"第 {scene_number} 鏡：影片模型生成中（第 {attempt}/{max_attempts} 次）")
                prompt, negative = self._scene_video_prompt(scene, feedback)
                final_width, final_height = self.size
                if final_width >= final_height:
                    generation_width, generation_height = (512, 288)
                elif final_width < final_height:
                    generation_width, generation_height = (288, 512)
                else:
                    generation_width, generation_height = (384, 384)
                fps = 16
                frames = max(17, min(129, int(round(duration * fps)) + 1))
                seed = int(scene.get("seed") or (int(hashlib.blake2b(f"{self.project['id']}:{scene['id']}:{attempt}".encode(), digest_size=8).hexdigest(), 16) % 2_147_483_647))
                raw_target = scene_root / f"raw-attempt-{attempt}.mp4"
                request = VideoGenerationRequest(
                    prompt=prompt,
                    negative_prompt=negative,
                    seed=seed,
                    width=generation_width,
                    height=generation_height,
                    frames=frames,
                    fps=fps,
                    output_prefix=f"evolabs/{self.job_id}/scene-{scene_number:03d}-attempt-{attempt}",
                    input_image=self._scene_reference_image(scene),
                )
                try:
                    generated: GeneratedVideo = self.video_provider.generate(request, raw_target)
                except VideoProviderError as error:
                    if error.code == "VIDEO_GENERATION_CANCELED":
                        raise RenderCanceled() from error
                    raise RenderError(error.code, error.message, error.detail) from error
                self._progress(index, 68.0, "compose", f"第 {scene_number} 鏡：整理影片、配音與字幕")
                overlay = _render_video_overlay(scene, self.size, self.info.font, self.captions, scene_root / "overlay.png")
                normalized = self.shots_directory / f"scene-{scene_number:03d}-attempt-{attempt}.mp4"
                _encode_video_scene(
                    self.info.ffmpeg,
                    generated.path,
                    overlay,
                    voice_path,
                    normalized,
                    duration,
                    self.size,
                    self.quality,
                    fps=24,
                )
                checks, deterministic_ok = _video_quality_checks(self.info.ffmpeg, normalized, duration)
                preview = self.previews_directory / f"scene-{scene_number:03d}-attempt-{attempt}.mp4"
                shutil.copyfile(normalized, preview)
                snapshot = self.status["scenes"][index]
                snapshot.update({
                    "visualSource": "video",
                    "previewPath": str(preview.resolve()),
                    "providerId": generated.provider_id,
                    "modelName": ", ".join(generated.model_names) or generated.workflow_name,
                    "promptId": generated.prompt_id,
                    "seed": generated.seed,
                    "generationAttempt": attempt,
                    "qualityChecks": checks,
                    "reviewState": "pending",
                })
                self._write()
                if not deterministic_ok:
                    feedback = "自動品質檢查失敗：" + "；".join(
                        str(check.get("detail") or "")
                        for check in checks
                        if isinstance(check, dict) and check.get("state") == "failed"
                    )
                    snapshot["reviewState"] = "rejected"
                    snapshot["reviewFeedback"] = feedback
                    if attempt >= max_attempts:
                        raise RenderError("VIDEO_QUALITY_FAILED", "影片鏡頭多次未通過基本品質檢查。", feedback)
                    continue
                approved, feedback = self._await_scene_review(index, scene, attempt)
                if approved:
                    approved_clip = normalized
                    break
                if attempt >= max_attempts:
                    raise RenderError("VIDEO_REVIEW_REJECTED", "影片鏡頭已達重試上限，仍未獲核准。", feedback)
            if approved_clip is None:
                raise RenderError("VIDEO_SCENE_NOT_APPROVED", "影片鏡頭尚未獲核准，不能進入最終成片。")
            snapshot = self.status["scenes"][index]
            snapshot["state"] = "done"
            snapshot["progress"] = 100.0
            snapshot["reviewState"] = "approved"
            clips.append(approved_clip)
            self._write()

        self.checkpoint()
        self.status["state"] = "running"
        self.status["stage"] = "compose"
        self.status["activeSceneId"] = None
        self.status["sceneProgress"] = 100.0
        self.status["overallProgress"] = 95.0
        self.status["message"] = "所有影片模型鏡頭已核准，正在合併並驗證最終 MP4。"
        self._write()
        output = self.output_directory / _safe_output_name(self.project.get("title"), self.job_id)
        _concat_scenes(self.info.ffmpeg, clips, output, self.work_directory)
        self.status["state"] = "completed"
        self.status["stage"] = "complete"
        self.status["overallProgress"] = 100.0
        self.status["sceneProgress"] = 100.0
        self.status["activeSceneId"] = None
        self.status["outputPath"] = str(output.resolve())
        self.status["outputBytes"] = output.stat().st_size
        self.status["message"] = (
            f"{len(clips)} 個鏡頭已由真正的 ComfyUI 影片工作流生成並逐鏡人工核准。"
            + _completion_message(dialogue_scenes, voiced_scenes, self.captions)
        )
        self._write()
        return self.status

    def _run_motion_comic(self) -> dict[str, Any]:
        if self.lip_sync_requested and self.lip_sync_error:
            raise RenderError(
                self.lip_sync_error.code,
                self.lip_sync_error.message,
                self.lip_sync_error.detail,
            )
        clips: list[Path] = []
        voiced_scenes = 0
        dialogue_scenes = 0
        lip_synced_scenes = 0
        lip_sync_skipped_scenes = 0
        for index, scene in enumerate(self.scenes):
            self.checkpoint()
            scene_number = int(scene["_evolabsSceneNumber"])
            scene_root = self.work_directory / f"scene-{scene_number:03d}"
            scene_root.mkdir(parents=True, exist_ok=True)
            card = scene_root / "card.png"
            voice = scene_root / "voice.wav"
            clip = self.shots_directory / f"scene-{scene_number:03d}.mp4"

            self._progress(index, 8, "visual", f"第 {scene_number} / {len(self.scenes)} 鏡：製作動態漫畫分鏡卡")
            _render_card(self.project, scene, scene_number, self.size, card, self.info.font, self.captions)
            snapshot = self.status["scenes"][index]
            snapshot["visualSource"] = "motion-comic"
            preview = self.previews_directory / _safe_scene_preview_name(scene["id"], scene_number - 1)
            _persist_scene_preview(card, preview)
            snapshot["previewPath"] = str(preview.resolve())
            self._write()

            self._progress(index, 32, "voice", f"第 {scene_number} / {len(self.scenes)} 鏡：加入語音與字幕")
            speech_text = _spoken_dialogue(self.project, scene)
            if speech_text:
                dialogue_scenes += 1
            voice_profile = _scene_voice_profile(self.project, scene)
            snapshot["voiceProfile"] = voice_profile
            has_voice = self.info.chinese_voice_available and _try_windows_tts(
                speech_text, voice, scene_root, voice_profile
            )
            if has_voice:
                voiced_scenes += 1
            voice_path = voice if has_voice else None
            duration = float(scene["duration"])
            if voice_path:
                duration = min(30.0, max(duration, _wave_duration(voice_path) + 0.35))
            self.checkpoint()

            self._progress(index, 58, "motion", f"第 {scene_number} / {len(self.scenes)} 鏡：合成動態漫畫鏡頭")
            _encode_scene(
                self.info.ffmpeg,
                card,
                voice_path,
                clip,
                duration,
                self.size,
                self.quality,
                scene.get("shot", "中景・固定鏡頭"),
                fps=25 if self.lip_sync_requested else 24,
            )
            final_clip = clip
            if self.lip_sync_requested:
                if voice_path and len(scene.get("characterIds", [])) == 1:
                    self._progress(index, 82, "motion", f"第 {scene_number} / {len(self.scenes)} 鏡：製作單人對嘴")
                    lip_synced_clip = self.shots_directory / f"scene-{scene_number:03d}-lipsync.mp4"
                    try:
                        assert self.lip_sync_provider is not None
                        result = self.lip_sync_provider.generate(
                            LipSyncRequest(
                                source_video=clip,
                                audio=voice_path,
                                duration_seconds=duration,
                                subject_count=1,
                                fps=25,
                            ),
                            lip_synced_clip,
                        )
                    except LipSyncProviderError as error:
                        if error.code == "LIPSYNC_CANCELED":
                            raise RenderCanceled() from error
                        raise RenderError(error.code, error.message, error.detail) from error
                    final_clip = result.path
                    lip_synced_scenes += 1
                    snapshot["lipSynced"] = True
                else:
                    lip_sync_skipped_scenes += 1
                    snapshot["lipSynced"] = False
                    snapshot["lipSyncSkippedReason"] = (
                        "voice_unavailable" if not voice_path else "single_subject_only"
                    )
            self._progress(index, 100, "compose", f"第 {scene_number} / {len(self.scenes)} 鏡已完成")
            snapshot["state"] = "done"
            snapshot["progress"] = 100.0
            clips.append(final_clip)
            self._write()

        self.checkpoint()
        self.status["state"] = "running"
        self.status["stage"] = "compose"
        self.status["activeSceneId"] = None
        self.status["sceneProgress"] = 100.0
        self.status["overallProgress"] = 95.0
        self.status["message"] = "正在合併並驗證動態漫畫 MP4。"
        self._write()
        output = self.output_directory / _safe_output_name(self.project.get("title"), self.job_id)
        _concat_scenes(self.info.ffmpeg, clips, output, self.work_directory)

        self.status["state"] = "completed"
        self.status["stage"] = "complete"
        self.status["overallProgress"] = 100.0
        self.status["sceneProgress"] = 100.0
        self.status["activeSceneId"] = None
        self.status["outputPath"] = str(output.resolve())
        self.status["outputBytes"] = output.stat().st_size
        completion = "動態漫畫模式已使用分鏡卡、鏡頭運動、語音與字幕完成；本模式不是 AI 影片模型生成。"
        completion += _completion_message(dialogue_scenes, voiced_scenes, self.captions)
        if self.lip_sync_requested:
            completion = (
                f"{lip_synced_scenes} 鏡已完成本機單人對嘴"
                + (f"，{lip_sync_skipped_scenes} 鏡因沒有可用語音或不是單人鏡頭而略過" if lip_sync_skipped_scenes else "")
                + f"。{completion}"
            )
        self.status["message"] = completion
        self._write()
        return self.status

    def run(self) -> dict[str, Any]:
        self.job_directory.mkdir(parents=True, exist_ok=True)
        _prune_preview_directories(self.data_root / "jobs", self.job_id)
        self.previews_directory.mkdir(parents=True, exist_ok=True)
        self.shots_directory.mkdir(parents=True, exist_ok=True)
        self.output_directory.mkdir(parents=True, exist_ok=True)
        self._write()
        try:
            if self.visual_mode == "ai-video":
                return self._run_ai_video()
            return self._run_motion_comic()
        except RenderCanceled:
            for snapshot in self.status["scenes"]:
                if snapshot["state"] in {"working", "review"}:
                    snapshot["state"] = "queued"
            self.status["state"] = "canceled"
            self.status["activeSceneId"] = None
            self.status["message"] = "工作已取消；已完成的暫存不會被當成最終輸出。"
            self._write()
        except RenderError as error:
            active_id = self.status.get("activeSceneId")
            for snapshot in self.status["scenes"]:
                if snapshot["sceneId"] == active_id:
                    snapshot["state"] = "failed"
            self.status["state"] = "failed"
            self.status["activeSceneId"] = active_id
            self.status["message"] = error.message
            self.status["error"] = {"code": error.code, "message": error.message, "detail": error.detail}
            self._write()
        except Exception as error:
            active_id = self.status.get("activeSceneId")
            for snapshot in self.status["scenes"]:
                if snapshot["sceneId"] == active_id:
                    snapshot["state"] = "failed"
            self.status["state"] = "failed"
            self.status["message"] = "本機影片引擎發生未預期錯誤。"
            self.status["error"] = {
                "code": "ENGINE_UNEXPECTED",
                "message": "本機影片引擎發生未預期錯誤。",
                "detail": repr(error),
            }
            self._write()
        finally:
            # Final output, status, compact previews, project snapshot and logs remain.
            # Bulky model sources, WAVs and intermediate clips are removed.
            shutil.rmtree(self.work_directory, ignore_errors=True)
        return self.status


def render_project_file(
    data_root: Path,
    job_id: str,
    project_path: Path,
    sample_limit: int | None = None,
    scene_id: str | None = None,
) -> dict[str, Any]:
    project = _read_json(project_path)
    job = RenderJob(data_root, job_id, project, sample_limit, scene_id=scene_id)
    return job.run()
