from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEMVER = re.compile(r"^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$")


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8-sig")


def write(path: str, content: str) -> None:
    target = ROOT / path
    # BAT/CMD must remain CRLF and BOM-free. A UTF-8 BOM is interpreted as
    # part of the first command by cmd.exe (for example, "ï»¿@echo off").
    newline = "\r\n" if target.suffix.lower() in {".bat", ".cmd"} else "\n"
    normalized = content.replace("\r\n", "\n").replace("\r", "\n").replace("\n", newline)
    target.write_bytes(normalized.encode("utf-8"))


def write_json(path: str, value: object) -> None:
    write(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def replace_once(path: str, pattern: str, replacement: str, *, flags: int = 0) -> None:
    source = read(path)
    changed, count = re.subn(pattern, replacement, source, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"Could not update the version field in {path}.")
    write(path, changed)


def main() -> int:
    parser = argparse.ArgumentParser(description="Update all Evolabs application version fields.")
    parser.add_argument("version")
    parser.add_argument("--notes", default="")
    args = parser.parse_args()

    version = args.version.strip().lstrip("v")
    if SEMVER.fullmatch(version) is None:
        raise SystemExit("Version must be complete SemVer, for example 0.6.1.")

    package = json.loads(read("package.json"))
    old_version = str(package.get("version", ""))
    if SEMVER.fullmatch(old_version) is None:
        raise RuntimeError("package.json does not contain a valid current version.")
    package["version"] = version
    write_json("package.json", package)

    lock = json.loads(read("package-lock.json"))
    lock["version"] = version
    lock.setdefault("packages", {}).setdefault("", {})["version"] = version
    write_json("package-lock.json", lock)

    tauri = json.loads(read("src-tauri/tauri.conf.json"))
    tauri["version"] = version
    write_json("src-tauri/tauri.conf.json", tauri)

    protocol = json.loads(read("contracts/protocol-version.json"))
    protocol["app_min_version"] = version
    protocol["engine_min_version"] = version
    write_json("contracts/protocol-version.json", protocol)

    replace_once(
        "src-tauri/Cargo.toml",
        r'(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)',
        rf"\g<1>{version}\g<2>",
        flags=re.MULTILINE,
    )
    replace_once(
        "src-tauri/Cargo.lock",
        r'(\[\[package\]\]\s*\nname = "evolabs"\s*\nversion = ")[^"]+("\s*)',
        rf"\g<1>{version}\g<2>",
    )
    replace_once(
        "engine/pyproject.toml",
        r'(^\[project\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)',
        rf"\g<1>{version}\g<2>",
        flags=re.MULTILINE,
    )
    replace_once(
        "engine/src/evolabs_engine/__init__.py",
        r'(?m)^__version__\s*=\s*"[^"]+"',
        f'__version__ = "{version}"',
    )

    build_bat = read("BUILD_WINDOWS.bat").replace(
        f"Evolabs v{old_version} Windows Source Builder",
        f"Evolabs v{version} Windows Source Builder",
    )
    if f"Evolabs v{version} Windows Source Builder" not in build_bat:
        raise RuntimeError("BUILD_WINDOWS.bat version title could not be updated.")
    write("BUILD_WINDOWS.bat", build_bat)

    app = read("src/App.tsx")
    app = app.replace(f"Agent Studio {old_version}", f"Agent Studio {version}")
    app = app.replace(f"Evolabs {old_version} · Agent Studio", f"Evolabs {version} · Agent Studio")
    app = app.replace(f"currentVersion: '{old_version}'", f"currentVersion: '{version}'")
    app = app.replace(f"currentVersion || '{old_version}'", f"currentVersion || '{version}'")
    if f"Evolabs {version} · Agent Studio" not in app:
        raise RuntimeError("App.tsx version footer could not be updated.")
    write("src/App.tsx", app)

    bridge = read("src/lib/bridge.ts")
    bridge = bridge.replace(f"runtimeVersion: '{old_version}-demo'", f"runtimeVersion: '{version}-demo'")
    bridge = bridge.replace(f"version: '{old_version}-demo'", f"version: '{version}-demo'")
    bridge = bridge.replace(f"currentVersion: '{old_version}-preview'", f"currentVersion: '{version}-preview'")
    if f"runtimeVersion: '{version}-demo'" not in bridge:
        raise RuntimeError("bridge.ts demo runtime version could not be updated.")
    write("src/lib/bridge.ts", bridge)

    for documentation_path in ("README.md", "AUTO_UPDATE_SETUP.md", "START_HERE.txt", "ARCHITECTURE.md"):
        documentation = read(documentation_path)
        documentation = documentation.replace(f"v{old_version}", f"v{version}")
        documentation = documentation.replace(old_version, version)
        write(documentation_path, documentation)

    notes_path = ROOT / f"RELEASE_NOTES_v{version}.md"
    if not notes_path.exists():
        notes = args.notes.strip() or "Agent workflow, stability and signed updater improvements."
        notes_path.write_text(
            f"# Evolabs v{version}\n\n"
            f"## 本次更新\n\n{notes}\n\n"
            "## 更新方式\n\n"
            "這個版本由 GitHub Actions 自動測試、建置並以 Tauri updater key 簽署。"
            "已安裝的使用者可在 **設定 → 自動更新 → 更新並重啟** 直接套用。\n",
            encoding="utf-8",
        )

    print(f"Updated Evolabs application version: {old_version} -> {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
