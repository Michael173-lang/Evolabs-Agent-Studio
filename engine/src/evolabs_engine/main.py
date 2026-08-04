from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import __version__
from .image_providers import runtime_ai_capabilities
from .installer import InstallError, install_model_pack
from .protocol import EngineProtocol
from .renderer import RenderError, render_project_file, runtime_info


def default_data_root() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "Evolabs" / "engine"


def main() -> int:
    parser = argparse.ArgumentParser(description="Evolabs local engine")
    parser.add_argument("--data-root", type=Path, default=default_data_root())
    parser.add_argument("--health-check", action="store_true")
    parser.add_argument("--render-project", type=Path)
    parser.add_argument("--job-id")
    render_scope = parser.add_mutually_exclusive_group()
    render_scope.add_argument("--sample-limit", type=int)
    render_scope.add_argument("--scene-id")
    parser.add_argument("--install-model-pack", type=Path)
    parser.add_argument("--install-id")
    arguments = parser.parse_args()
    if arguments.install_model_pack is not None:
        if not arguments.install_id:
            parser.error("--install-id is required with --install-model-pack")
        try:
            status = install_model_pack(
                arguments.data_root,
                arguments.install_id,
                arguments.install_model_pack,
            )
        except (InstallError, OSError, ValueError, json.JSONDecodeError) as error:
            print(f"model install startup failed: {error}", file=sys.stderr, flush=True)
            return 1
        return 0 if status.get("state") in {"completed", "canceled"} else 1
    if arguments.render_project is not None:
        if not arguments.job_id:
            parser.error("--job-id is required with --render-project")
        try:
            status = render_project_file(
                arguments.data_root,
                arguments.job_id,
                arguments.render_project,
                arguments.sample_limit,
                arguments.scene_id,
            )
        except (OSError, ValueError, json.JSONDecodeError, RenderError) as error:
            print(f"render startup failed: {error}", file=sys.stderr, flush=True)
            return 1
        return 0 if status.get("state") in {"completed", "canceled"} else 1

    if arguments.health_check:
        result: dict[str, object] = {
            "engineVersion": __version__,
            "protocolVersion": 1,
            "pid": os.getpid(),
            "functionalCoreReady": False,
        }
        try:
            # The UI gates zhVoice on this exact result, so health performs the
            # actual SAPI culture probe instead of assuming PowerShell implies a voice.
            info = runtime_info(probe_voice=True)
            capability_environment = dict(os.environ)
            capability_environment.setdefault("EVOLABS_FFMPEG", str(info.ffmpeg))
            result.update(
                {
                    "functionalCoreReady": True,
                    "ffmpegReady": True,
                    "systemVoiceProbeDeferred": False,
                }
            )
            result.update(
                runtime_ai_capabilities(
                    arguments.data_root,
                    chinese_voice_available=info.chinese_voice_available,
                    comic_core_ready=True,
                    environment=capability_environment,
                )
            )
        except RenderError as error:
            result["rendererError"] = {"code": error.code, "message": error.message, "detail": error.detail}
            result.update(
                runtime_ai_capabilities(
                    arguments.data_root,
                    chinese_voice_available=False,
                    comic_core_ready=False,
                    environment=os.environ,
                )
            )
        print(json.dumps({"id": "health", "ok": True, "result": result}, ensure_ascii=False))
        return 0

    engine = EngineProtocol(arguments.data_root)
    try:
        for raw_line in sys.stdin:
            try:
                request = json.loads(raw_line)
                response = engine.handle(request)
            except json.JSONDecodeError as error:
                response = {"id": None, "ok": False, "error": {"code": "INVALID_JSON", "message": str(error)}}
            print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)
    finally:
        engine.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
