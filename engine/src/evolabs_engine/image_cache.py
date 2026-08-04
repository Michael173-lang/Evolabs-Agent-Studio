from __future__ import annotations

import hashlib
import os
import re
import shutil
import tempfile
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from .cache import canonical_json
from .image_providers import ImageGenerationRequest, ProviderCapability


MAX_CACHED_IMAGE_BYTES = 32 * 1024 * 1024


def _sha256(path: Path, maximum: int) -> str:
    if not path.is_file() or path.stat().st_size > maximum:
        raise ValueError("reference image is missing or too large")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ai_image_cache_key(
    request: ImageGenerationRequest,
    capability: ProviderCapability,
) -> str | None:
    """Return a provenance-complete key, or None when model identity is unknown."""
    model_hash = capability.details.get("modelHash")
    if not isinstance(model_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", model_hash.strip()):
        return None
    if not isinstance(capability.version, str) or not capability.version.strip():
        return None
    model_hash = model_hash.lower()
    reference_hash = None
    if request.reference_image is not None:
        reference_hash = _sha256(request.reference_image, 10 * 1024 * 1024)
    payload = {
        "schemaVersion": 1,
        "provider": capability.provider_id,
        "model": capability.model_name,
        "modelVersion": capability.version,
        "modelHash": model_hash,
        "prompt": request.prompt,
        "negativePrompt": request.negative_prompt,
        "width": request.width,
        "height": request.height,
        "steps": request.steps,
        "cfgScale": request.cfg_scale,
        "seed": request.seed,
        "quality": request.quality,
        "referenceImageHash": reference_hash,
        "referenceStrength": request.consistency_strength if reference_hash else None,
    }
    return hashlib.blake2b(canonical_json(payload), digest_size=32).hexdigest()


def _valid_png(path: Path, expected_size: tuple[int, int]) -> bool:
    try:
        if not path.is_file() or path.stat().st_size < 64 or path.stat().st_size > MAX_CACHED_IMAGE_BYTES:
            return False
        with Image.open(path) as image:
            if image.size != expected_size or image.width * image.height > 20_000_000:
                return False
            image.load()
            return image.format == "PNG"
    except (OSError, UnidentifiedImageError):
        return False


def _atomic_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.stem}-", suffix=".partial", dir=destination.parent
    )
    temporary = Path(temporary_name)
    try:
        with source.open("rb") as reader, os.fdopen(descriptor, "wb") as writer:
            shutil.copyfileobj(reader, writer, length=1024 * 1024)
            writer.flush()
            os.fsync(writer.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary.unlink(missing_ok=True)


class AiImageCache:
    def __init__(self, data_root: Path) -> None:
        self.root = data_root / "cache" / "ai-images"

    def path_for(self, key: str) -> Path:
        return self.root / key[:2] / key[2:4] / f"{key}.png"

    def restore(self, key: str | None, destination: Path, expected_size: tuple[int, int]) -> bool:
        if key is None:
            return False
        cached = self.path_for(key)
        if not _valid_png(cached, expected_size):
            if cached.exists():
                cached.unlink(missing_ok=True)
            return False
        _atomic_copy(cached, destination)
        return _valid_png(destination, expected_size)

    def commit(self, key: str | None, source: Path, expected_size: tuple[int, int]) -> bool:
        if key is None or not _valid_png(source, expected_size):
            return False
        cached = self.path_for(key)
        if _valid_png(cached, expected_size):
            return True
        _atomic_copy(source, cached)
        if not _valid_png(cached, expected_size):
            cached.unlink(missing_ok=True)
            return False
        return True
