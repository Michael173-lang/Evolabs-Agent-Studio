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
    pattern = r"\[\[package\]\]\s+" + rf'name = "{re.escape(package_name)}"\s+' + r'version = "(?P<version>[^"]+)"'
    match = re.search(pattern, cargo_lock)
    require(match is not None, f"Cargo.lock 找不到 package {package_name}")
    return match.group("version")


def validate_json_files() -> int:
    checked = 0
    ignored_parts = {"node_modules", "target", "dist", ".build", ".git", ".pytest_cache"}
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
        "Cargo.toml": match_version("src-tauri/Cargo.toml", r'^\[package\].*?^version\s*=\s*"(?P<version>[^"]+)"', "Cargo.toml"),
        "Cargo.lock": package_block_version(read_text("src-tauri/Cargo.lock"), "evolabs"),
        "engine pyproject": match_version("engine/pyproject.toml", r'^\[project\].*?^version\s*=\s*"(?P<version>[^"]+)"', "Engine pyproject"),
        "engine __version__": match_version("engine/src/evolabs_engine/__init__.py", r'^__version__\s*=\s*"(?P<version>[^"]+)"', "Engine __version__"),
        "protocol app minimum": protocol.get("app_min_version"),
        "protocol engine minimum": protocol.get("engine_min_version"),
    }
    mismatched = {label: found for label, found in versions.items() if found != version}
    require(not mismatched, f"版本不一致；預期 {version}：{mismatched}")

    require((ROOT / f"RELEASE_NOTES_v{version}.md").is_file(), f"缺少目前版本說明：RELEASE_NOTES_v{version}.md")
    require(f"Evolabs v{version} Windows Source Builder" in read_text("BUILD_WINDOWS.bat"), "BAT 標題版本不一致。")
    require(f"Agent Studio {version}" in read_text("src/studio/ui.tsx"), "工作室品牌版本不一致。")
    require(f"currentVersion: '{version}'" in read_text("src/StudioApp.tsx"), "應用程式目前版本不一致。")
    require(f"runtimeVersion: '{version}-preview'" in read_text("src/lib/bridge.ts"), "瀏覽器預覽版本不一致。")
    local_builder = read_text("scripts/build-windows.ps1")
    local_publisher = read_text("scripts/publish-built-release.ps1")
    require(bool(local_builder.strip()), "本機建置器內容不得為空。")
    require("latest.json" in local_publisher and "build-result.json" in local_publisher, "本機發布器缺少建置結果或更新資訊處理。")
    require('"release", "create"' in local_publisher and '"release", "upload"' in local_publisher, "本機發布器缺少建立或覆蓋 Release 的流程。")

    updater = tauri.get("plugins", {}).get("updater", {})
    require(tauri.get("bundle", {}).get("createUpdaterArtifacts") is True, "Tauri 必須產生簽章更新檔。")
    require(updater.get("windows", {}).get("installMode") == "passive", "Windows 更新器必須使用 passive 安裝模式。")
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

    lock_packages = package_lock.get("packages", {})
    for group in ("dependencies", "devDependencies"):
        dependencies = package.get(group, {})
        require(isinstance(dependencies, dict), f"package.json {group} 格式不正確。")
        for name, specifier in dependencies.items():
            require(isinstance(specifier, str) and SEMVER.fullmatch(specifier) is not None, f"{group} 的 {name} 必須固定精確版本：{specifier!r}")
            require(lock_packages.get(f"node_modules/{name}", {}).get("version") == specifier, f"{name} 的 lockfile 版本不一致。")
            require(lock_packages.get("", {}).get(group, {}).get(name) == specifier, f"package-lock root 對 {name} 的版本宣告不一致。")

    workflow = read_text(".github/workflows/windows-installer.yml")
    for expected in (
        "contents: write", "tauri-apps/tauri-action@v1", "TAURI_SIGNING_PRIVATE_KEY",
        "uploadUpdaterJson: true", "updaterJsonPreferNsis: true", "tagName: v__VERSION__",
        "cargo test --manifest-path src-tauri/Cargo.toml --lib", "python scripts/validate-source-release.py",
        "npm run check", "npm test", "./scripts/build-engine.ps1",
    ):
        require(expected in workflow, f"GitHub Actions 發佈流程缺少：{expected}")

    for relative in (
        "SETUP_AUTO_UPDATE.bat", "PUBLISH_UPDATE.bat", "scripts/setup-auto-update.ps1",
        "scripts/publish-update.ps1", "scripts/configure-updater.py", "scripts/sync-release-version.py",
        "AUTO_UPDATE_SETUP.md", "START_HERE.txt", ".gitattributes",
        "1_BUILD_AND_TEST.bat", "2_PUBLISH_RELEASE.bat", "scripts/publish-built-release.ps1",
    ):
        require((ROOT / relative).is_file(), f"缺少更新／發佈檔案：{relative}")

    for batch in ("SETUP_AUTO_UPDATE.bat", "PUBLISH_UPDATE.bat", "BUILD_WINDOWS.bat", "1_BUILD_AND_TEST.bat", "2_PUBLISH_RELEASE.bat"):
        raw = (ROOT / batch).read_bytes()
        require(not raw.startswith(b"\xef\xbb\xbf"), f"{batch} 不得含 UTF-8 BOM。")
        require(b"\r\n" in raw, f"{batch} 必須使用 Windows CRLF 行尾。")

    studio = read_text("src/StudioApp.tsx")
    pipeline = read_text("src/lib/agentPipeline.ts")
    strict_artifacts = read_text("src/lib/strictArtifacts.ts")
    agent_backend = read_text("src-tauri/src/agent_models.rs")
    video_backend = read_text("src-tauri/src/video_providers.rs")
    renderer = read_text("engine/src/evolabs_engine/renderer.py")
    python_video = read_text("engine/src/evolabs_engine/video_providers.py")
    video_preflight = read_text("src/lib/videoPreflight.ts")

    require(not (ROOT / "src/App.tsx").exists(), "舊版大型 App.tsx 不得重新進入主線。")
    require("createFallbackProduction" not in pipeline and "fallbackScriptAnalysis" not in pipeline, "Agent 管線仍包含假交付備援。")
    require("messages: []" in pipeline, "新專案不得預先偽造 Agent 對話。")
    agent_conversation = read_text("src/lib/agentConversation.ts")
    production_view = read_text("src/studio/ProductionView.tsx")
    require(
        "messages: workspace.messages.filter(isVisibleDialogueMessage)" in studio
        and "if (!isVisibleDialogueMessage(entry)) return false;" in production_view
        and "hasVerifiedAgentEvidence" in agent_conversation
        and "isVerifiedAssistantMessage" in agent_conversation
        and "AI 回覆缺少完整模型要求證據" in studio,
        "對話區必須以模型要求證據過濾使用者訊息與真實 AI 回覆。",
    )
    require("runAgentConversation" in studio and "production-meeting" in studio, "可交流的單一 Agent／製作會議缺失。")
    meeting_order = re.search(r"const productionMeetingOrder: AgentId\[\] = \[([\s\S]*?)\];", studio)
    require(meeting_order is not None, "製作會議缺少明確執行順序。")
    meeting_source = meeting_order.group(1)
    expected_agents = (
        "screenwriter", "art-director", "ip-designer", "character-designer",
        "scene-designer", "storyboard-artist", "sound-director", "director",
    )
    require(all(f"'{agent}'" in meeting_source for agent in expected_agents), "製作會議必須包含完整 AI 製片團隊。")
    require(meeting_source.rfind("'director'") > max(meeting_source.rfind(f"'{agent}'") for agent in expected_agents[:-1]), "總導演必須在其他成員完成後進行最後統整。")
    require("maximumCorrectionRounds" in studio and "returnToAgent" in strict_artifacts, "總導演退件與限次修正流程缺失。")
    require(
        "strictLocations(response.artifact, script)" in studio
        and "raw.length !== script.locationSeeds.length" in strict_artifacts,
        "場景交付物必須嚴格對應編劇核准的場景種子。",
    )
    require("run_agent_stage_v3" in agent_backend and "run_agent_conversation" in agent_backend, "真實 Agent 命令缺失。")
    require("missingInformation" in agent_backend and "acknowledgement" in agent_backend, "Agent 任務確認契約缺失。")
    require("不得顯示私密思考過程" in agent_backend, "Agent 提示缺少思考過程保護。")
    require("fallback" not in agent_backend.lower(), "Agent 後端不得使用規則式 fallback 冒充模型。")
    require("HTTP 400" in studio and "retryCount" in agent_backend and "max_completion_tokens" in agent_backend, "模型請求缺少 HTTP 400 相容性重試。")
    require("conversation-progress" in production_view and "onRetryMessage" in production_view and "setMessage('')" in production_view, "對話介面缺少進度、清空輸入框或訊息重試。")
    require((ROOT / "src-tauri/src/comfyui_manager.rs").is_file(), "缺少受管理的 AI 影片引擎。")
    require((ROOT / "src-tauri/src/storage_manager.rs").is_file() and (ROOT / "src/studio/StoragePanel.tsx").is_file(), "缺少儲存空間與模型解除安裝功能。")

    require("validated_provider_snapshot" in video_backend and "configure_comfyui_provider" in video_backend, "影片模型服務設定與驗證缺失。")
    require(
        "{{EVOLABS_OUTPUT_PREFIX}}" in video_backend
        and "{{EVOLABS_OUTPUT_PREFIX}}" in python_video
        and "output_prefix_binding" in video_backend,
        "影片工作流缺少逐鏡輸出名稱綁定與隔離。",
    )
    require("ComfyUiVideoProvider" in renderer and "visual_mode == \"ai-video\"" in renderer, "真正影片模型渲染路徑缺失。")
    require("awaiting-review" in renderer and "reviewState" in studio, "逐鏡人工核准流程缺失。")
    require("COMFYUI_VIDEO_OUTPUT_REQUIRED" in python_video, "靜態圖片冒充影片的阻擋規則缺失。")
    require("visual_mode == \"ai-images\"" not in renderer and "if False" not in renderer, "舊版圖片生成分支仍存在於活動渲染流程。")
    require("本模式不是 AI 影片模型生成" in renderer, "動態漫畫模式沒有清楚標示。")
    require((ROOT / "engine/tests/test_video_providers.py").is_file(), "缺少真正影片服務的整合測試。")
    require(
        "scene.characterIds.length > 1" in video_preflight
        and "referenceImagePath" in video_preflight
        and "outputPrefixBinding" in video_preflight,
        "影片生成前缺少多人鏡頭、角色參考圖或輸出隔離檢查。",
    )
    require(
        "onImportCharacterReference" in production_view
        and "onClearCharacterReference" in production_view
        and "importCharacterReference" in studio
        and "clearCharacterReference" in studio,
        "角色身份參考圖匯入、移除與鏡頭失效流程缺失。",
    )

    ui_sources = "\n".join(read_text(path) for path in (
        "src/studio/StartView.tsx", "src/studio/ModelsView.tsx", "src/studio/SettingsView.tsx", "src/studio/ProductionView.tsx",
    ))
    for forbidden in ("影片 Provider", "Agent Runtime", "前往模型與 Runtime", "真正影片生成 Provider"):
        require(forbidden not in ui_sources, f"正式介面仍含未統一用語：{forbidden}")
    css = read_text("src/studio.css")
    require("writing-mode: horizontal-tb" in css and "min-width: 0" in css, "介面缺少防止逐字直排／內容溢出的版面規則。")
    require("word-break: keep-all" in css and ".reference-manager" in css, "正式介面缺少短標籤防直排或角色參考圖版面。")
    require("@media (max-width: 980px)" in css and "@media (max-width: 720px)" in css, "介面缺少必要的響應式斷點。")

    runtime_manager = read_text("src-tauri/src/runtime_manager.rs")
    for expected in (
        "https://lmstudio.ai/install.ps1", '"daemon", "up", "--json"',
        '"server", "start", "--port", "1234"', "qwen/qwen3-4b-2507@q4_k_m", "evolabs://runtime-setup",
    ):
        require(expected in runtime_manager, f"一鍵 AI 執行環境缺少：{expected}")

    forbidden_payload_extensions = {".safetensors", ".ckpt", ".pt", ".pth", ".pkl", ".pickle", ".onnx"}
    bundled_payloads = [
        path.relative_to(ROOT) for path in ROOT.rglob("*")
        if path.is_file()
        and forbidden_payload_extensions.intersection({suffix.lower() for suffix in path.suffixes})
        and not {"node_modules", "target", ".build", ".git"}.intersection(path.parts)
    ]
    require(not bundled_payloads, f"來源包不可內嵌大型／高風險模型檔：{bundled_payloads}")

    json_count = validate_json_files()
    print(
        f"Evolabs {version} source validation passed: {len(versions)} version fields, "
        f"{sum(len(package[group]) for group in ('dependencies', 'devDependencies'))} pinned dependencies, "
        f"{json_count} JSON files."
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValidationError as error:
        print(f"Source validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
