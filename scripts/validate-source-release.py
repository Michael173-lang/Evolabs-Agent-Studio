from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")


class ValidationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def read_text(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8-sig")


def read_json(relative: str) -> Any:
    with (ROOT / relative).open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def match_version(relative: str, pattern: str, label: str) -> str:
    match = re.search(pattern, read_text(relative), re.MULTILINE | re.DOTALL)
    require(match is not None, f"{label} 缺少可辨識的版本欄位：{relative}")
    return match.group("version")


def package_block_version(cargo_lock: str, package_name: str) -> str:
    pattern = (
        r"\[\[package\]\]\s+"
        + rf'name = "{re.escape(package_name)}"\s+'
        + r'version = "(?P<version>[^"]+)"'
    )
    match = re.search(pattern, cargo_lock)
    require(match is not None, f"Cargo.lock 找不到 package {package_name}")
    return match.group("version")


def validate_json_files() -> int:
    checked = 0
    ignored_parts = {"node_modules", "target", "dist", ".build", ".git"}
    for path in ROOT.rglob("*.json"):
        if ignored_parts.intersection(path.parts):
            continue
        try:
            with path.open("r", encoding="utf-8-sig") as handle:
                json.load(handle)
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValidationError(f"JSON 無法解析：{path.relative_to(ROOT)}：{error}") from error
        checked += 1
    return checked


def main() -> int:
    package = read_json("package.json")
    package_lock = read_json("package-lock.json")
    tauri = read_json("src-tauri/tauri.conf.json")
    protocol = read_json("contracts/protocol-version.json")
    update_channel = read_json("src-tauri/resources/update-channel.json")
    version = package.get("version")
    require(isinstance(version, str) and SEMVER.fullmatch(version) is not None, "package.json 版本不是完整 SemVer。")

    versions = {
        "package.json": version,
        "package-lock.json": package_lock.get("version"),
        "package-lock root": package_lock.get("packages", {}).get("", {}).get("version"),
        "tauri.conf.json": tauri.get("version"),
        "Cargo.toml": match_version(
            "src-tauri/Cargo.toml",
            r'^\[package\].*?^version\s*=\s*"(?P<version>[^"]+)"',
            "Cargo.toml",
        ),
        "Cargo.lock": package_block_version(read_text("src-tauri/Cargo.lock"), "evolabs"),
        "engine pyproject": match_version(
            "engine/pyproject.toml",
            r'^\[project\].*?^version\s*=\s*"(?P<version>[^"]+)"',
            "Engine pyproject",
        ),
        "engine __version__": match_version(
            "engine/src/evolabs_engine/__init__.py",
            r'^__version__\s*=\s*"(?P<version>[^"]+)"',
            "Engine __version__",
        ),
        "protocol app minimum": protocol.get("app_min_version"),
        "protocol engine minimum": protocol.get("engine_min_version"),
    }
    mismatched = {label: found for label, found in versions.items() if found != version}
    require(not mismatched, f"版本不一致；預期 {version}：{mismatched}")

    release_notes = ROOT / f"RELEASE_NOTES_v{version}.md"
    require(release_notes.is_file(), f"缺少目前版本說明：{release_notes.name}")
    require(f"Evolabs v{version} Windows Source Builder" in read_text("BUILD_WINDOWS.bat"), "BAT 標題版本不一致。")
    require(f"Evolabs {version}" in read_text("src/App.tsx"), "App 頁尾版本不一致。")
    require(f"runtimeVersion: '{version}-demo'" in read_text("src/lib/bridge.ts"), "瀏覽器 Demo Runtime 版本不一致。")

    updater = tauri.get("plugins", {}).get("updater", {})
    require(tauri.get("bundle", {}).get("createUpdaterArtifacts") is True, "Tauri 必須產生簽章更新 artifacts。")
    require(
        updater.get("windows", {}).get("installMode") == "passive",
        "Windows 更新器必須使用 passive 安裝模式。",
    )
    require(isinstance(update_channel, dict), "update-channel.json 格式不正確。")
    require(set(("enabled", "endpoint", "pubkey")).issubset(update_channel), "更新通道設定缺少必要欄位。")
    require(not any(token in json.dumps(update_channel) for token in ("PRIVATE KEY", "TAURI_SIGNING_PRIVATE_KEY")), "更新通道不得包含私鑰。")
    if update_channel.get("enabled"):
        endpoint = update_channel.get("endpoint")
        pubkey = update_channel.get("pubkey")
        require(isinstance(endpoint, str) and endpoint.startswith("https://"), "啟用的更新端點必須使用 HTTPS。")
        require(isinstance(pubkey, str) and bool(pubkey.strip()), "啟用的更新通道缺少公開金鑰。")
        require(updater.get("endpoints") == [endpoint], "Tauri updater endpoint 與資源設定不一致。")
        require(updater.get("pubkey") == pubkey, "Tauri updater 公開金鑰與資源設定不一致。")

    # Direct dependencies are intentionally exact. npm ci already follows the
    # lockfile; this also prevents a later npm install from silently moving a
    # core compiler, Tauri, React, or test runner to another release.
    lock_packages = package_lock.get("packages", {})
    for group in ("dependencies", "devDependencies"):
        dependencies = package.get(group, {})
        require(isinstance(dependencies, dict), f"package.json {group} 格式不正確。")
        for name, specifier in dependencies.items():
            require(
                isinstance(specifier, str) and SEMVER.fullmatch(specifier) is not None,
                f"{group} 的 {name} 必須固定精確版本，不得使用 latest／範圍：{specifier!r}",
            )
            locked = lock_packages.get(f"node_modules/{name}", {}).get("version")
            require(locked == specifier, f"{name} 的 package.json={specifier} 與 lockfile={locked} 不一致。")
            root_specifier = lock_packages.get("", {}).get(group, {}).get(name)
            require(root_specifier == specifier, f"package-lock root 對 {name} 的版本宣告不一致。")

    bootstrap = read_text("scripts/bootstrap-windows.ps1")
    toolchain = read_text("scripts/windows-toolchain.ps1")
    require('latest-v24.x' in bootstrap and 'SHASUMS256.txt' in bootstrap, "Node.js 24 官方校驗流程缺失。")
    require('node-v24\\.[0-9]+\\.[0-9]+-win-x64\\.zip' in bootstrap, "Node.js 24 Windows x64 ZIP 格式檢查缺失。")
    require('.build\\toolchain' in toolchain and 'node-v24*-win-x64\\node.exe' in toolchain, "專案本機 Node.js 偵測缺失。")
    require('-Version "24.0.0"' not in bootstrap, "建置器仍綁死 Node.js 24.0.0。")
    require('static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc' in bootstrap, "Rust 官方 MSVC bootstrapper 備援缺失。")
    require('rustup-init.exe.sha256' in bootstrap, "Rust bootstrapper SHA-256 驗證缺失。")
    require('& $winget.Source "source" "update"' not in bootstrap, "WinGet source 不應在每個套件安裝前反覆更新。")

    workflow = read_text(".github/workflows/windows-installer.yml")
    for expected in (
        "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe",
        "src-tauri/target/release/bundle/nsis/*.exe",
        "permissions:",
        "contents: write",
        "tauri-apps/tauri-action@v1",
        "TAURI_SIGNING_PRIVATE_KEY",
        "uploadUpdaterJson: true",
        "updaterJsonPreferNsis: true",
        "tagName: v__VERSION__",
    ):
        require(expected in workflow, f"GitHub Actions 發佈流程缺少：{expected}")
    require("TAURI_SIGNING_PRIVATE_KEY:" not in workflow.replace(
        "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}", ""
    ), "GitHub Actions 不得硬編碼 updater 私鑰。")

    required_release_files = (
        "SETUP_AUTO_UPDATE.bat",
        "PUBLISH_UPDATE.bat",
        "scripts/setup-auto-update.ps1",
        "scripts/publish-update.ps1",
        "scripts/configure-updater.py",
        "scripts/set-version.py",
        "AUTO_UPDATE_SETUP.md",
        "START_HERE.txt",
        ".gitattributes",
    )
    for relative in required_release_files:
        require((ROOT / relative).is_file(), f"缺少更新／發佈檔案：{relative}")
    setup_update_script = read_text("scripts/setup-auto-update.ps1")
    require("signer generate --ci -w $PrivateKeyPath -f" in setup_update_script, "Updater key 必須以 Tauri CLI 非互動模式產生。")
    require("-p """ not in setup_update_script, "Windows PowerShell 5.1 可能丟棄空字串參數，不得以 -p 空字串產生 key。")

    for batch in ("SETUP_AUTO_UPDATE.bat", "PUBLISH_UPDATE.bat", "BUILD_WINDOWS.bat"):
        raw = (ROOT / batch).read_bytes()
        require(not raw.startswith(b"\xef\xbb\xbf"), f"{batch} 不得含 UTF-8 BOM，否則 cmd.exe 會誤讀第一行。")
        require(b"\r\n" in raw, f"{batch} 必須使用 Windows CRLF 行尾。")

    gitignore = read_text(".gitignore")
    require("release-downloads/" in gitignore, "首次下載的 Setup.exe 目錄必須被 git 忽略，避免後續發佈把安裝器提交進來源碼。")

    attributes = read_text(".gitattributes")
    require("*.bat text eol=crlf" in attributes and "*.ps1 text eol=crlf" in attributes, ".gitattributes 必須固定 Windows 腳本行尾。")
    start_here = read_text("START_HERE.txt")
    require("SETUP_AUTO_UPDATE.bat" in start_here and "更新並重啟" in start_here, "START_HERE 必須提供一次設定與程式內更新指引。")
    require(f"Evolabs Agent Studio v{version}" in start_here, "START_HERE 版本標題與目前版本不一致。")

    app_source = read_text("src/App.tsx")
    agent_pipeline = read_text("src/lib/agentPipeline.ts")
    rust_commands = read_text("src-tauri/src/commands.rs")
    for agent_id in (
        "screenwriter", "art-director", "ip-designer", "character-designer",
        "scene-designer", "storyboard-artist", "sound-director",
    ):
        require(agent_id in agent_pipeline and agent_id in rust_commands, f"多 Agent 管線缺少 {agent_id}。")
    require("你只負責劇本" in app_source and "交給 Evolabs 團隊" in app_source, "單一劇本入口 UI 缺失。")
    require("run_agent_stage" in rust_commands, "本機分階段 Agent 命令缺失。")
    require("_prepare_character_assets" in read_text("engine/src/evolabs_engine/renderer.py"), "角色身份資產預生成流程缺失。")

    runtime_manager = read_text("src-tauri/src/runtime_manager.rs")
    for expected in (
        "https://lmstudio.ai/install.ps1",
        '"daemon", "up", "--json"',
        '"get", DEFAULT_MODEL_QUERY, "--gguf"',
        '"load", &model_key',
        '"server", "start", "--port", "1234"',
        "qwen/qwen3-4b-2507@q4_k_m",
        "evolabs://runtime-setup",
    ):
        require(expected in runtime_manager, f"一鍵 Agent Runtime 缺少：{expected}")
    require("RuntimeSetupOverlay" in app_source and "不用安裝 LM Studio" in app_source, "首次啟動自動前置 UI 缺失。")
    require("visualReady={aiImagesReady(project, hardware)}" in app_source, "首次啟動流程未包含 AI 視覺模型準備。")

    # Model-pack versions intentionally remain independent of the App version.
    # They are content contracts and must not be relabelled when payload bytes
    # have not changed.
    for pack in ("anime-core", "realistic-core"):
        manifest = read_json(f"distribution/manifests/models/{pack}.json")
        require(manifest.get("id") == pack, f"模型清單 ID 不一致：{pack}")
        require(manifest.get("version") == "0.4.0", f"未改內容的 {pack} 不得重新標版本。")

    forbidden_payload_extensions = {".safetensors", ".ckpt", ".pt", ".pth", ".pkl", ".pickle", ".onnx"}
    bundled_payloads = [
        path.relative_to(ROOT)
        for path in ROOT.rglob("*")
        if path.is_file()
        and forbidden_payload_extensions.intersection({suffix.lower() for suffix in path.suffixes})
        and not {"node_modules", "target", ".build", ".git"}.intersection(path.parts)
    ]
    require(not bundled_payloads, f"來源包不可內嵌大型／高風險模型 payload：{bundled_payloads}")

    json_count = validate_json_files()
    print(f"Evolabs {version} source validation passed: {len(versions)} version fields, "
          f"{sum(len(package[group]) for group in ('dependencies', 'devDependencies'))} pinned dependencies, "
          f"{json_count} JSON files.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValidationError as error:
        print(f"Source validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
