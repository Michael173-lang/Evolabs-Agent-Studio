from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from . import __version__
from .database import EngineDatabase
from .image_providers import runtime_ai_capabilities
from .planner import build_comic_dag
from .renderer import RenderError, runtime_info


class ProtocolError(Exception):
    pass


class EngineProtocol:
    def __init__(self, data_root: Path) -> None:
        self.data_root = data_root
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.database = EngineDatabase(data_root / "evolabs.sqlite3")

    def close(self) -> None:
        self.database.close()

    def handle(self, request: Any) -> dict[str, Any]:
        request_id = request.get("id") if isinstance(request, dict) else None
        try:
            if not isinstance(request, dict):
                raise ProtocolError("request must be a JSON object")
            method = request.get("method")
            params = request.get("params") or {}
            if not isinstance(params, dict):
                raise ProtocolError("params must be a JSON object")
            if method == "hello":
                result = {"engineVersion": __version__, "protocolVersion": 1, "pid": os.getpid()}
            elif method == "capabilities":
                try:
                    info = runtime_info(probe_voice=True)
                    capability_environment = dict(os.environ)
                    if getattr(info, "ffmpeg", None):
                        capability_environment.setdefault("EVOLABS_FFMPEG", str(info.ffmpeg))
                    result = runtime_ai_capabilities(
                        self.data_root,
                        chinese_voice_available=info.chinese_voice_available,
                        comic_core_ready=True,
                        environment=capability_environment,
                    )
                except RenderError:
                    result = runtime_ai_capabilities(
                        self.data_root,
                        chinese_voice_available=False,
                        comic_core_ready=False,
                    )
                result.update(
                    {
                        "quickComicCards": {
                            "status": "runtime_ready" if result["capabilities"]["comicCore"] else "unavailable",
                            "pack": "functional-core",
                        },
                        "animeManga": {
                            "status": "runtime_ready" if result["capabilities"]["animeImage"] else "download_required",
                            "pack": "anime-core",
                        },
                        "realisticManga": {
                            "status": "runtime_ready" if result["capabilities"]["realisticImage"] else "download_required",
                            "pack": "realistic-core",
                        },
                        "cinematicI2v": {"status": "unavailable", "reason": "not_included"},
                    }
                )
            elif method == "job.create":
                project = params.get("project")
                if not isinstance(project, dict) or not project.get("id"):
                    raise ProtocolError("project is required")
                model_hashes = params.get("modelHashes") or []
                if not isinstance(model_hashes, list) or not all(isinstance(item, str) for item in model_hashes):
                    raise ProtocolError("modelHashes must be a string array")
                nodes = build_comic_dag(project, params.get("sampleLimit"), model_hashes)
                job_id = self.database.create_job(project["id"], nodes)
                result = {"jobId": job_id, "nodeCount": len(nodes)}
            elif method == "job.get":
                result = self.database.get_job(str(params.get("jobId")))
                if result is None:
                    raise ProtocolError("job not found")
            elif method in {"job.pause", "job.resume", "job.cancel"}:
                action = method.split(".", 1)[1]
                result = {"ok": self.database.request_action(str(params.get("jobId")), action)}
            else:
                raise ProtocolError(f"unknown method: {method}")
            return {"id": request_id, "ok": True, "result": result}
        except (ProtocolError, ValueError) as error:
            return {"id": request_id, "ok": False, "error": {"code": "BAD_REQUEST", "message": str(error)}}
        except Exception as error:  # keep the long-running worker alive; details stay in local logs
            return {"id": request_id, "ok": False, "error": {"code": "ENGINE_ERROR", "message": str(error)}}
