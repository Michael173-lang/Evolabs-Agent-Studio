from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Configure the Evolabs signed update channel.")
    parser.add_argument("--repository", required=True, help="Public GitHub repository in owner/repo form")
    parser.add_argument("--public-key-file", required=True, type=Path)
    args = parser.parse_args()

    repository = args.repository.strip()
    if REPOSITORY_RE.fullmatch(repository) is None:
        raise SystemExit("Repository must use the owner/repo format.")

    public_key_path = args.public_key_file.expanduser().resolve()
    public_key = public_key_path.read_text(encoding="utf-8-sig").strip()
    if not public_key or len(public_key) > 64 * 1024:
        raise SystemExit("The Tauri updater public key is empty or unexpectedly large.")

    endpoint = f"https://github.com/{repository}/releases/latest/download/latest.json"
    channel = {
        "enabled": True,
        "endpoint": endpoint,
        "pubkey": public_key,
    }
    write_json(ROOT / "src-tauri/resources/update-channel.json", channel)

    tauri_path = ROOT / "src-tauri/tauri.conf.json"
    tauri = json.loads(tauri_path.read_text(encoding="utf-8-sig"))
    plugins = tauri.setdefault("plugins", {})
    updater = plugins.setdefault("updater", {})
    updater["pubkey"] = public_key
    updater["endpoints"] = [endpoint]
    updater["windows"] = {"installMode": "passive"}
    tauri.setdefault("bundle", {})["createUpdaterArtifacts"] = True
    write_json(tauri_path, tauri)

    print(f"Configured signed updates from {endpoint}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
