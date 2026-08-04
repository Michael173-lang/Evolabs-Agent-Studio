from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlparse

from evolabs_engine.installer import InstallError, load_manifest


SHA256 = re.compile(r"^[0-9a-f]{64}$")
ALLOWED_DOWNLOAD_HOSTS = {"github.com", "huggingface.co"}


def validate_release_manifest(path: Path) -> tuple[str, str, tuple[str, int, str] | None]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("status") != "release":
        raise ValueError(f"{path.name}: only status=release may be bundled")
    manifest = load_manifest(path)
    if raw.get("provider") != "sd-cli" or raw.get("activation", {}).get("provider") != "sd-cli":
        raise ValueError(f"{path.name}: provider must be sd-cli")

    licenses = {item.get("id"): item for item in raw.get("licenses", []) if isinstance(item, dict)}
    if not licenses:
        raise ValueError(f"{path.name}: reviewed license metadata is missing")
    destinations: set[str] = set()
    runtime_identity: tuple[str, int, str] | None = None
    for item in raw.get("files", []):
        file_id = item.get("id", "unknown")
        if item.get("url") != (item.get("source") or {}).get("url"):
            raise ValueError(f"{path.name}/{file_id}: url and source.url disagree")
        parsed = urlparse(str(item.get("url") or ""))
        if parsed.hostname not in ALLOWED_DOWNLOAD_HOSTS:
            raise ValueError(f"{path.name}/{file_id}: unreviewed download host {parsed.hostname!r}")
        if "sizeBytes" in item and item.get("size") != item.get("sizeBytes"):
            raise ValueError(f"{path.name}/{file_id}: size and sizeBytes disagree")
        if not SHA256.fullmatch(str(item.get("sha256") or "")):
            raise ValueError(f"{path.name}/{file_id}: invalid SHA-256")
        if item.get("licenseId") not in licenses:
            raise ValueError(f"{path.name}/{file_id}: unknown licenseId")
        destination = str(item.get("destination") or "")
        destinations.add(destination)
        if item.get("role") == "runtime-archive":
            if item.get("kind") != "zip" or destination != "runtime":
                raise ValueError(f"{path.name}/{file_id}: runtime must be a ZIP extracted inside the pack")
            runtime_identity = (str(item["sha256"]), int(item["size"]), str(item["url"]))

    activation = raw.get("activation", {})
    if activation.get("executableGlob") != "runtime/**/sd-cli.exe" or runtime_identity is None:
        raise ValueError(f"{path.name}: self-contained sd-cli runtime activation is missing")
    for key in ("modelPath", "vaePath", "clipVisionPath", "ipAdapterPath"):
        value = activation.get(key)
        if value and value not in destinations:
            raise ValueError(f"{path.name}: activation.{key} is not installed by this pack")
    model_path = activation.get("modelPath")
    if not model_path or not str(model_path).endswith(".safetensors"):
        raise ValueError(f"{path.name}: a safetensors modelPath is required")

    restricted = {
        item.get("licenseId")
        for item in raw.get("files", [])
        if item.get("role") == "stable-diffusion-1x-checkpoint"
    }
    for license_id in restricted:
        if licenses[license_id].get("acceptanceRequired") is not True:
            raise ValueError(f"{path.name}: checkpoint license {license_id!r} must require explicit acceptance")
    return manifest.id, manifest.version, runtime_identity


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest-root", type=Path, required=True)
    args = parser.parse_args()
    model_root = args.manifest_root / "models"
    paths = sorted(path for path in model_root.glob("*.json") if not path.name.endswith(".template.json"))
    if not paths:
        raise SystemExit("no release model manifests found")

    identities: set[tuple[str, str]] = set()
    shared_runtime: tuple[str, int, str] | None = None
    for path in paths:
        try:
            pack_id, version, runtime = validate_release_manifest(path)
        except (InstallError, OSError, ValueError, json.JSONDecodeError) as error:
            raise SystemExit(f"manifest validation failed: {error}") from error
        identity = (pack_id, version)
        if identity in identities:
            raise SystemExit(f"duplicate release model identity: {pack_id}/{version}")
        identities.add(identity)
        if shared_runtime is None:
            shared_runtime = runtime
        elif shared_runtime != runtime:
            raise SystemExit("anime and realistic packs do not pin the same shared sd-cli runtime artifact")
        print(f"engine-compatible manifest: {pack_id}/{version}")

    required = {"anime-core", "realistic-core"}
    present = {pack_id for pack_id, _ in identities}
    if not required.issubset(present):
        raise SystemExit(f"required model packs missing: {', '.join(sorted(required - present))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
