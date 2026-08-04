from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from . import __version__


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def node_cache_key(
    node_type: str,
    schema_version: int,
    parameters: dict[str, Any],
    upstream_hashes: Iterable[str] = (),
    model_hashes: Iterable[str] = (),
    engine_version: str = __version__,
    seed: int | None = None,
) -> str:
    """Stable content key; unrelated project edits do not invalidate this node."""
    payload = {
        "node_type": node_type,
        "schema_version": schema_version,
        "parameters": parameters,
        "upstream_hashes": list(upstream_hashes),
        "model_hashes": sorted(model_hashes),
        "engine_version": engine_version,
        "seed": seed,
    }
    return hashlib.blake2b(canonical_json(payload), digest_size=32).hexdigest()


@dataclass(frozen=True)
class Artifact:
    digest: str
    path: Path
    byte_size: int
    kind: str


class ArtifactStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def path_for(self, digest: str, extension: str) -> Path:
        suffix = extension.lstrip(".") or "bin"
        return self.root / digest[:2] / digest[2:4] / f"{digest}.{suffix}"

    def put_bytes(self, data: bytes, extension: str, kind: str) -> Artifact:
        digest = hashlib.blake2b(data, digest_size=32).hexdigest()
        final_path = self.path_for(digest, extension)
        if final_path.exists():
            return Artifact(digest, final_path, final_path.stat().st_size, kind)

        final_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{digest[:12]}-", suffix=".partial", dir=final_path.parent
        )
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, final_path)
        finally:
            temporary_path.unlink(missing_ok=True)
        return Artifact(digest, final_path, len(data), kind)
