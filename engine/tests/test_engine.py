from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from evolabs_engine import __version__
from evolabs_engine.cache import ArtifactStore, node_cache_key
from evolabs_engine.protocol import EngineProtocol
from evolabs_engine.planner import build_comic_dag


PROJECT = {
    "id": "project_test",
    "settings": {"mode": "anime"},
    "characters": [
        {"id": "character_a", "appearance": "black hair"},
        {"id": "character_b", "appearance": "long hair"},
    ],
    "scenes": [
        {
            "id": "scene_1",
            "visual": "clock tower",
            "dialogue": "你好",
            "duration": 5,
            "shot": "中景",
            "characterIds": ["character_a", "character_b"],
        }
    ],
}


class CacheTests(unittest.TestCase):
    def test_cache_key_is_canonical(self) -> None:
        first = node_cache_key("image", 1, {"width": 432, "prompt": "x"})
        second = node_cache_key("image", 1, {"prompt": "x", "width": 432})
        self.assertEqual(first, second)

    def test_cache_key_defaults_to_the_current_engine_version(self) -> None:
        default = node_cache_key("image", 1, {"prompt": "x"})
        current = node_cache_key("image", 1, {"prompt": "x"}, engine_version=__version__)
        stale = node_cache_key("image", 1, {"prompt": "x"}, engine_version="0.1.0")
        self.assertEqual(default, current)
        self.assertNotEqual(default, stale)

    def test_artifact_commit_is_content_addressed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = ArtifactStore(Path(directory))
            first = store.put_bytes(b"same", "json", "test")
            second = store.put_bytes(b"same", ".json", "test")
            self.assertEqual(first.path, second.path)
            self.assertTrue(first.path.exists())

    def test_export_cache_key_preserves_shot_order(self) -> None:
        scenes = [PROJECT["scenes"][0], {**PROJECT["scenes"][0], "id": "scene_2", "visual": "classroom"}]
        forward = build_comic_dag({**PROJECT, "scenes": scenes})[-1]["node_key"]
        reversed_project = {**PROJECT, "scenes": list(reversed(scenes))}
        reverse = build_comic_dag(reversed_project)[-1]["node_key"]
        self.assertNotEqual(forward, reverse)

    def test_export_plan_uses_the_actual_software_encoder(self) -> None:
        export = build_comic_dag(PROJECT)[-1]
        self.assertEqual(export["node_type"], "project.export")
        self.assertEqual(export["parameters"]["video_codec"], "libx264")


class ProtocolTests(unittest.TestCase):
    def test_capabilities_do_not_advertise_an_unshipped_i2v_pack(self) -> None:
        runtime_capabilities = {
            "aiReady": False,
            "aiProvider": None,
            "capabilities": {
                "comicCore": True,
                "animeImage": False,
                "realisticImage": False,
                "characterConsistency": False,
                "zhVoice": False,
                "lipSync": False,
                "imageToVideo": False,
            },
            "modelPacks": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            engine = EngineProtocol(Path(directory))
            try:
                with (
                    patch(
                        "evolabs_engine.protocol.runtime_info",
                        return_value=SimpleNamespace(chinese_voice_available=False),
                    ),
                    patch(
                        "evolabs_engine.protocol.runtime_ai_capabilities",
                        return_value=runtime_capabilities,
                    ),
                ):
                    response = engine.handle({"id": 1, "method": "capabilities"})
            finally:
                engine.close()

        self.assertTrue(response["ok"])
        self.assertEqual(
            response["result"]["cinematicI2v"],
            {"status": "unavailable", "reason": "not_included"},
        )
        self.assertNotIn("pack", response["result"]["cinematicI2v"])

    def test_job_survives_database_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            engine = EngineProtocol(Path(directory))
            created = engine.handle({"id": 1, "method": "job.create", "params": {"project": PROJECT}})
            self.assertTrue(created["ok"])
            job_id = created["result"]["jobId"]
            fetched = engine.handle({"id": 2, "method": "job.get", "params": {"jobId": job_id}})
            self.assertTrue(fetched["ok"])
            self.assertGreaterEqual(len(fetched["result"]["nodes"]), 6)
            engine.close()

    def test_non_object_request_does_not_kill_engine(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            engine = EngineProtocol(Path(directory))
            invalid = engine.handle([])
            self.assertFalse(invalid["ok"])
            healthy = engine.handle({"id": 2, "method": "hello"})
            self.assertTrue(healthy["ok"])
            engine.close()


if __name__ == "__main__":
    unittest.main()
