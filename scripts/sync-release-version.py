from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r"^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$")


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8-sig")


def write(path: str, content: str) -> None:
    target = ROOT / path
    newline = "\r\n" if target.suffix.lower() in {".bat", ".cmd"} else "\n"
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    if newline == "\r\n":
        normalized = normalized.replace("\n", "\r\n")
    target.write_bytes(normalized.encode("utf-8"))


def write_json(path: str, value: object) -> None:
    write(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def replace_required(path: str, pattern: str, replacement: str, *, flags: int = 0) -> None:
    source = read(path)
    updated, count = re.subn(pattern, replacement, source, flags=flags)
    if count == 0:
        raise RuntimeError(f"Could not synchronize release version in {path}.")
    write(path, updated)


def main() -> int:
    package = json.loads(read("package.json"))
    version = (sys.argv[1] if len(sys.argv) > 1 else package.get("version", "")).strip().lstrip("v")
    if SEMVER.fullmatch(version) is None:
        raise SystemExit("Release version must be complete SemVer.")

    package["version"] = version
    write_json("package.json", package)

    package_lock = json.loads(read("package-lock.json"))
    package_lock["version"] = version
    package_lock.setdefault("packages", {}).setdefault("", {})["version"] = version
    write_json("package-lock.json", package_lock)

    tauri = json.loads(read("src-tauri/tauri.conf.json"))
    tauri["version"] = version
    write_json("src-tauri/tauri.conf.json", tauri)

    protocol = json.loads(read("contracts/protocol-version.json"))
    protocol["app_min_version"] = version
    protocol["engine_min_version"] = version
    write_json("contracts/protocol-version.json", protocol)

    replace_required(
        "src-tauri/Cargo.toml",
        r'(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)',
        rf"\g<1>{version}\g<2>",
        flags=re.MULTILINE,
    )
    replace_required(
        "src-tauri/Cargo.lock",
        r'(\[\[package\]\]\s*\nname = "evolabs"\s*\nversion = ")[^"]+("\s*)',
        rf"\g<1>{version}\g<2>",
    )
    replace_required(
        "engine/pyproject.toml",
        r'(^\[project\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)',
        rf"\g<1>{version}\g<2>",
        flags=re.MULTILINE,
    )
    replace_required(
        "engine/src/evolabs_engine/__init__.py",
        r'(?m)^__version__\s*=\s*"[^"]+"',
        f'__version__ = "{version}"',
    )
    replace_required(
        "BUILD_WINDOWS.bat",
        r"Evolabs v[^\s]+ Windows Source Builder",
        f"Evolabs v{version} Windows Source Builder",
    )

    app = read("src/App.tsx")
    app = re.sub(r"Agent Studio \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", f"Agent Studio {version}", app)
    app = re.sub(r"Evolabs \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? · Agent Studio", f"Evolabs {version} · Agent Studio", app)
    app = re.sub(r"currentVersion: '\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?'", f"currentVersion: '{version}'", app)
    app = re.sub(r"currentVersion \|\| '\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?'", f"currentVersion || '{version}'", app)
    if f"Evolabs {version} · Agent Studio" not in app:
        raise RuntimeError("Legacy App version marker could not be synchronized.")
    write("src/App.tsx", app)

    bridge = read("src/lib/bridge.ts")
    bridge = re.sub(r"runtimeVersion: '\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-demo'", f"runtimeVersion: '{version}-demo'", bridge)
    bridge = re.sub(r"version: '\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-demo'", f"version: '{version}-demo'", bridge)
    bridge = re.sub(r"currentVersion: '\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-preview'", f"currentVersion: '{version}-preview'", bridge)
    if f"runtimeVersion: '{version}-demo'" not in bridge:
        raise RuntimeError("Demo Runtime version marker could not be synchronized.")
    write("src/lib/bridge.ts", bridge)

    start_here = read("START_HERE.txt")
    start_here = re.sub(
        r"Evolabs Agent Studio v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?",
        f"Evolabs Agent Studio v{version}",
        start_here,
    )
    write("START_HERE.txt", start_here)

    notes = ROOT / f"RELEASE_NOTES_v{version}.md"
    if not notes.is_file():
        notes.write_text(
            f"# Evolabs v{version}\n\n"
            "## 本次更新\n\n"
            "- 重製可靠、低干擾的工作室介面。\n"
            "- 新增可驗證的編劇交付流程與多模型選擇。\n"
            "- 強化 Runtime、模型、生成與錯誤狀態回饋。\n",
            encoding="utf-8",
        )

    print(f"Synchronized Evolabs release workspace to {version}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
