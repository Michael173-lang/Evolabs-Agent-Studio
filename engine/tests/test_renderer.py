from __future__ import annotations

import json
import os
import shutil
import tempfile
import time
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from evolabs_engine.image_providers import GeneratedImage, ProviderCapability
from evolabs_engine.lipsync_provider import LipSyncCapability, LipSyncResult

from evolabs_engine.renderer import (
    PREVIEW_ORPHAN_GRACE_SECONDS,
    RenderCanceled,
    RenderError,
    RenderJob,
    _completion_message,
    _motion_filter,
    _prune_preview_directories,
    _render_card,
    _safe_scene_preview_name,
    _scene_voice_profile,
    _spoken_dialogue,
    find_ffmpeg,
    render_project_file,
)


PROJECT = {
    "schemaVersion": 1,
    "id": "project_renderer_test",
    "title": "鐘樓測試短劇",
    "settings": {
        "mode": "anime",
        "format": "9:16",
        "targetSeconds": 2,
        "quality": "speed",
        "renderMode": "comic",
        "captions": True,
    },
    "characters": [
        {
            "id": "character_a",
            "name": "予棠",
            "role": "主角",
            "appearance": "黑色長髮",
            "voice": "中性・自然",
            "locked": True,
            "accent": "#aab4d6",
        }
    ],
    "scenes": [
        {
            "id": "scene_1",
            "order": 1,
            "title": "鐘樓亮起",
            "visual": "夜色中的校園鐘樓發出淡藍色光芒。",
            "dialogue": "予棠：時間，真的倒流了。",
            "characterIds": ["character_a"],
            "duration": 1,
            "shot": "中景・緩慢推進",
        }
    ],
}


@unittest.skipUnless(shutil.which("ffmpeg"), "system ffmpeg is required for the media integration test")
class RendererIntegrationTests(unittest.TestCase):
    def test_real_render_produces_valid_mp4_and_terminal_status(self) -> None:
        with tempfile.TemporaryDirectory(prefix="evolabs 中文 路徑 ") as directory:
            root = Path(directory)
            project_path = root / "專案 snapshot.json"
            project_path.write_text(json.dumps(PROJECT, ensure_ascii=False), encoding="utf-8")
            job_id = "job_00000000-0000-4000-8000-000000000101"

            status = render_project_file(root, job_id, project_path)

            self.assertEqual(status["state"], "completed")
            self.assertEqual(status["stage"], "complete")
            self.assertEqual(status["overallProgress"], 100)
            self.assertEqual(status["scenes"][0]["sceneId"], "scene_1")
            self.assertEqual(status["scenes"][0]["state"], "done")
            output = Path(status["outputPath"])
            self.assertTrue(output.is_file())
            self.assertGreater(output.stat().st_size, 2048)
            with output.open("rb") as handle:
                self.assertEqual(handle.read(12)[4:8], b"ftyp")
            persisted = json.loads((root / "jobs" / job_id / "status.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted["outputBytes"], output.stat().st_size)
            self.assertFalse((root / "jobs" / job_id / "work").exists())
            preview = Path(status["scenes"][0]["previewPath"])
            self.assertTrue(preview.is_file())
            self.assertEqual(preview.parent, root / "jobs" / job_id / "previews")
            self.assertEqual(status["scenes"][0]["visualSource"], "motion-comic")
            self.assertEqual(status["scenes"][0]["voiceProfile"], "中性・自然")
            self.assertEqual(persisted["scenes"][0]["previewPath"], str(preview))

    def test_cancel_at_safe_boundary_never_commits_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            job_id = "job_00000000-0000-4000-8000-000000000102"
            job = RenderJob(root, job_id, PROJECT)
            job.job_directory.mkdir(parents=True)
            job.control_path.write_text(
                json.dumps({"jobId": job_id, "action": "cancel"}),
                encoding="utf-8",
            )

            status = job.run()

            self.assertEqual(status["state"], "canceled")
            self.assertIsNone(status["outputPath"])
            self.assertEqual(list((root / "outputs").glob("*.mp4")), [])
            self.assertFalse(job.work_directory.exists())

    def test_cancel_after_first_scene_keeps_completed_preview(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = json.loads(json.dumps(PROJECT))
            project["scenes"].append({**project["scenes"][0], "id": "scene_2", "order": 2})
            job_id = "job_00000000-0000-4000-8000-000000000108"
            job = RenderJob(root, job_id, project)
            checkpoint_calls = 0

            def cancel_before_second_scene() -> None:
                nonlocal checkpoint_calls
                checkpoint_calls += 1
                if checkpoint_calls == 3:
                    raise RenderCanceled()

            with patch.object(job, "checkpoint", side_effect=cancel_before_second_scene):
                status = job.run()

            self.assertEqual(status["state"], "canceled")
            self.assertEqual(status["scenes"][0]["state"], "done")
            self.assertTrue(Path(status["scenes"][0]["previewPath"]).is_file())
            self.assertIsNone(status["scenes"][1]["previewPath"])
            self.assertFalse(job.work_directory.exists())

    def test_failure_after_first_scene_keeps_completed_preview(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = json.loads(json.dumps(PROJECT))
            project["scenes"].append({**project["scenes"][0], "id": "scene_2", "order": 2})
            job = RenderJob(root, "job_00000000-0000-4000-8000-000000000109", project)
            render_calls = 0

            def fail_second_card(*args, **kwargs):
                nonlocal render_calls
                render_calls += 1
                if render_calls == 2:
                    raise RenderError("TEST_VISUAL_FAILED", "第二鏡測試失敗。")
                return _render_card(*args, **kwargs)

            with patch("evolabs_engine.renderer._render_card", side_effect=fail_second_card):
                status = job.run()

            self.assertEqual(status["state"], "failed")
            self.assertEqual(status["error"]["code"], "TEST_VISUAL_FAILED")
            self.assertTrue(Path(status["scenes"][0]["previewPath"]).is_file())
            self.assertEqual(status["scenes"][0]["visualSource"], "motion-comic")
            self.assertIsNone(status["scenes"][1]["previewPath"])
            self.assertFalse(job.work_directory.exists())

    def test_all_exposed_camera_motions_render_through_ffmpeg(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = json.loads(json.dumps(PROJECT))
            shots = (
                "中景・固定鏡頭",
                "中景・緩慢推進",
                "近景・固定鏡頭",
                "廣角・平移",
                "特寫・輕微晃動",
            )
            project["id"] = "project_motion_test"
            project["scenes"] = [
                {**PROJECT["scenes"][0], "id": f"scene_motion_{index}", "shot": shot}
                for index, shot in enumerate(shots)
            ]
            project_path = root / "motion-project.json"
            project_path.write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")

            status = render_project_file(
                root,
                "job_00000000-0000-4000-8000-000000000104",
                project_path,
            )

            self.assertEqual(status["state"], "completed")
            self.assertEqual([scene["state"] for scene in status["scenes"]], ["done"] * len(shots))

    def test_single_scene_render_preserves_project_identity_and_original_scene_number(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = json.loads(json.dumps(PROJECT))
            project["scenes"] = [
                {**project["scenes"][0], "id": f"scene_{index}", "order": index}
                for index in range(1, 4)
            ]
            project_path = root / "single-scene-project.json"
            project_path.write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")

            with patch("evolabs_engine.renderer._render_card", wraps=_render_card) as render_card:
                status = render_project_file(
                    root,
                    "job_00000000-0000-4000-8000-000000000110",
                    project_path,
                    scene_id="scene_3",
                )

            self.assertEqual(status["state"], "completed")
            self.assertEqual(status["scope"], "scene")
            self.assertEqual(status["projectId"], PROJECT["id"])
            self.assertEqual([scene["sceneId"] for scene in status["scenes"]], ["scene_3"])
            self.assertEqual(status["scenes"][0]["sceneNumber"], 3)
            self.assertEqual(render_card.call_args.args[2], 3)

    def test_ready_lipsync_provider_is_used_for_single_speaker_motion_comic_scene(self) -> None:
        class FakeImageProvider:
            provider_id = "fake-image"

            def probe(self):
                return ProviderCapability(
                    self.provider_id,
                    "Fake image",
                    "ready",
                    "ready",
                    model_name="fake-model",
                    details={"imageCapabilities": ["anime_image"]},
                )

            def generate(self, request, destination):
                destination.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGB", (request.width, request.height), (40, 50, 60)).save(destination, "PNG")
                return GeneratedImage(destination, self.provider_id, "fake-model", request.seed)

        class FakeLipSyncProvider:
            provider_id = "fake-lipsync"

            def __init__(self):
                self.requests = []

            def probe(self):
                return LipSyncCapability(self.provider_id, "Fake lip sync", "ready", "ready", version="1.5")

            def generate(self, request, destination):
                self.requests.append(request)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(request.source_video, destination)
                return LipSyncResult(destination, self.provider_id, "1.5")

        def fake_tts(_dialogue, destination, _working_directory, _voice_profile):
            with wave.open(str(destination), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(16000)
                output.writeframes(b"\0\0" * 16000)
            return True

        with tempfile.TemporaryDirectory() as directory:
            project = json.loads(json.dumps(PROJECT))
            project["settings"].update({"visualMode": "ai-images", "lipSync": True})
            lip_sync = FakeLipSyncProvider()
            with (
                patch("evolabs_engine.renderer.runtime_info") as mocked_runtime,
                patch("evolabs_engine.renderer._try_windows_tts", side_effect=fake_tts),
            ):
                mocked_runtime.return_value.ffmpeg = find_ffmpeg()
                mocked_runtime.return_value.font = None
                mocked_runtime.return_value.chinese_voice_available = True
                job = RenderJob(
                    Path(directory),
                    "job_00000000-0000-4000-8000-000000000113",
                    project,
                    image_provider=FakeImageProvider(),
                    lip_sync_provider=lip_sync,
                )
                status = job.run()

            self.assertEqual(status["state"], "completed")
            self.assertEqual(status["lipSyncProvider"], "fake-lipsync")
            self.assertTrue(status["scenes"][0]["lipSynced"])
            self.assertEqual(len(lip_sync.requests), 1)
            self.assertEqual(lip_sync.requests[0].fps, 25)
            self.assertIn("1 鏡已完成本機單人對嘴", status["message"])


class RendererUnitTests(unittest.TestCase):
    def test_single_character_scene_uses_that_characters_voice_profile(self) -> None:
        project = json.loads(json.dumps(PROJECT))
        project["characters"][0]["voice"] = "成熟・沉穩"
        self.assertEqual(_scene_voice_profile(project, project["scenes"][0]), "成熟・沉穩")

    def test_dialogue_name_selects_speaker_in_multi_character_scene(self) -> None:
        project = json.loads(json.dumps(PROJECT))
        project["characters"].append({
            "id": "character_b",
            "name": "子晴",
            "voice": "少女・清冷",
        })
        scene = dict(project["scenes"][0], characterIds=["character_a", "character_b"], dialogue="子晴：先別碰時針。")
        self.assertEqual(_scene_voice_profile(project, scene), "少女・清冷")

    def test_ambiguous_multi_character_scene_uses_neutral_fallback(self) -> None:
        project = json.loads(json.dumps(PROJECT))
        project["characters"].append({"id": "character_b", "name": "子晴", "voice": "少女・清冷"})
        scene = dict(project["scenes"][0], characterIds=["character_a", "character_b"], dialogue="先別碰時針。")
        self.assertEqual(_scene_voice_profile(project, scene), "中性・自然")

    def test_off_scene_speaker_label_does_not_select_that_characters_voice(self) -> None:
        project = json.loads(json.dumps(PROJECT))
        project["characters"].append({"id": "character_b", "name": "子晴", "voice": "少女・清冷"})
        scene = dict(project["scenes"][0], characterIds=["character_a"], dialogue="子晴：先別碰時針。")
        self.assertEqual(_scene_voice_profile(project, scene), "中性・自然")

    def test_unknown_voice_profile_is_normalized_to_neutral(self) -> None:
        project = json.loads(json.dumps(PROJECT))
        project["characters"][0]["voice"] = "legacy-unknown-voice"
        self.assertEqual(_scene_voice_profile(project, project["scenes"][0]), "中性・自然")

    def test_speech_removes_known_character_label_but_keeps_body(self) -> None:
        project = json.loads(json.dumps(PROJECT))
        scene = dict(project["scenes"][0], dialogue="  予棠： 別再轉動時針。 ")
        self.assertEqual(_spoken_dialogue(project, scene), "別再轉動時針。")

    def test_speech_removes_narrator_label_and_preserves_unlabelled_text(self) -> None:
        project = json.loads(json.dumps(PROJECT))
        self.assertEqual(_spoken_dialogue(project, {"dialogue": "旁白：鐘聲再次響起。"}), "鐘聲再次響起。")
        self.assertEqual(_spoken_dialogue(project, {"dialogue": "時間：仍在倒退。"}), "時間：仍在倒退。")

    def test_ffmpeg_can_be_resolved(self) -> None:
        self.assertTrue(find_ffmpeg().is_file())

    def test_scene_count_has_a_hard_limit(self) -> None:
        project = {**PROJECT, "scenes": [dict(PROJECT["scenes"][0], id=f"scene_{index}") for index in range(241)]}
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RenderError) as context:
                RenderJob(Path(directory), "job_00000000-0000-4000-8000-000000000103", project)
        self.assertEqual(context.exception.code, "TOO_MANY_SCENES")

    def test_single_scene_scope_selects_only_the_requested_original_scene(self) -> None:
        project = json.loads(json.dumps(PROJECT))
        project["scenes"] = [
            {**project["scenes"][0], "id": f"scene_{index}", "order": index}
            for index in range(1, 5)
        ]
        with tempfile.TemporaryDirectory() as directory:
            job = RenderJob(
                Path(directory),
                "job_00000000-0000-4000-8000-000000000111",
                project,
                scene_id="scene_4",
            )
        self.assertEqual(job.scope, "scene")
        self.assertEqual([scene["id"] for scene in job.scenes], ["scene_4"])
        self.assertEqual(job.scenes[0]["_evolabsSceneNumber"], 4)
        self.assertEqual(job.status["scenes"][0]["sceneNumber"], 4)

    def test_single_scene_scope_rejects_missing_unsafe_or_ambiguous_ids(self) -> None:
        cases = (
            ({"scene_id": "missing"}, "SCENE_NOT_FOUND"),
            ({"scene_id": "scene_1\n"}, "INVALID_SCENE_ID"),
            ({"sample_limit": 3, "scene_id": "scene_1"}, "INVALID_RENDER_SCOPE"),
        )
        for arguments, expected_code in cases:
            with self.subTest(arguments=arguments):
                with tempfile.TemporaryDirectory() as directory:
                    with self.assertRaises(RenderError) as context:
                        RenderJob(
                            Path(directory),
                            "job_00000000-0000-4000-8000-000000000112",
                            PROJECT,
                            **arguments,
                        )
                self.assertEqual(context.exception.code, expected_code)

    def test_duplicate_character_ids_are_rejected_before_render(self) -> None:
        project = json.loads(json.dumps(PROJECT))
        project["characters"].append(dict(project["characters"][0]))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RenderError) as context:
                RenderJob(Path(directory), "job_00000000-0000-4000-8000-000000000105", project)
        self.assertEqual(context.exception.code, "INVALID_CHARACTER")

    def test_scene_character_ids_must_be_unique_and_exist(self) -> None:
        for character_ids in (["character_a", "character_a"], ["missing_character"]):
            with self.subTest(character_ids=character_ids):
                project = json.loads(json.dumps(PROJECT))
                project["scenes"][0]["characterIds"] = character_ids
                with tempfile.TemporaryDirectory() as directory:
                    with self.assertRaises(RenderError) as context:
                        RenderJob(Path(directory), "job_00000000-0000-4000-8000-000000000106", project)
                self.assertEqual(context.exception.code, "INVALID_SCENE_CHARACTERS")

    def test_oversized_embedded_reference_is_rejected(self) -> None:
        project = json.loads(json.dumps(PROJECT))
        project["characters"][0]["referenceImageDataUrl"] = "data:image/png;base64," + ("A" * (14 * 1024 * 1024))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RenderError) as context:
                RenderJob(Path(directory), "job_00000000-0000-4000-8000-000000000107", project)
        self.assertEqual(context.exception.code, "INVALID_REFERENCE")

    def test_supported_shots_have_distinct_motion_filters(self) -> None:
        filters = {
            shot: _motion_filter(shot, 720, 1280, 5, 24)
            for shot in (
                "中景・固定鏡頭",
                "中景・緩慢推進",
                "近景・固定鏡頭",
                "廣角・平移",
                "特寫・輕微晃動",
            )
        }
        self.assertEqual(len(set(filters.values())), len(filters))
        self.assertNotIn("zoompan", filters["中景・固定鏡頭"])
        self.assertIn("zoompan", filters["中景・緩慢推進"])

    def test_completion_message_respects_disabled_captions(self) -> None:
        message = _completion_message(dialogue_scenes=2, voiced_scenes=0, captions=False)
        self.assertIn("字幕已關閉", message)
        self.assertNotIn("使用字幕", message)

    def test_preview_filename_never_contains_untrusted_scene_path(self) -> None:
        filename = _safe_scene_preview_name(r"../../CON\\evil:name", 0)
        self.assertRegex(filename, r"^scene-001-[0-9a-f]{16}\.png$")
        self.assertNotIn("..", filename)
        self.assertNotIn("/", filename)
        self.assertNotIn("\\", filename)

    def test_preview_retention_keeps_only_newest_terminal_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jobs = Path(directory) / "jobs"
            jobs.mkdir()
            for index in range(5):
                job = jobs / f"job_{index}"
                previews = job / "previews"
                previews.mkdir(parents=True)
                (previews / "scene.png").write_bytes(b"preview")
                (job / "status.json").write_text(json.dumps({"state": "completed"}), encoding="utf-8")
                timestamp = 1_700_000_000 + index
                os.utime(previews, (timestamp, timestamp))

            _prune_preview_directories(
                jobs,
                "job_current",
                max_jobs=2,
                max_bytes=1024,
                now=1_800_000_000,
            )

            retained = sorted(path.parent.name for path in jobs.glob("*/previews"))
            self.assertEqual(retained, ["job_3", "job_4"])

    def test_recent_nonterminal_preview_is_not_pruned(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jobs = Path(directory) / "jobs"
            previews = jobs / "job_running" / "previews"
            previews.mkdir(parents=True)
            (previews / "scene.png").write_bytes(b"preview")
            (jobs / "job_running" / "status.json").write_text(
                json.dumps({"state": "running"}), encoding="utf-8"
            )
            now = time.time()
            os.utime(previews, (now, now))

            _prune_preview_directories(jobs, "job_current", max_jobs=0, max_bytes=0, now=now)

            self.assertTrue(previews.is_dir())
            self.assertLess(now - previews.stat().st_mtime, PREVIEW_ORPHAN_GRACE_SECONDS)


if __name__ == "__main__":
    unittest.main()
