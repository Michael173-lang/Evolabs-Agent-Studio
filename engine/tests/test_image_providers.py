from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import shutil
import struct
import sys
import tempfile
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from PIL import Image

import evolabs_engine.image_providers as image_providers
from evolabs_engine.image_providers import (
    Automatic1111Provider,
    ImageGenerationRequest,
    ImageProviderError,
    ProviderCapability,
    StableDiffusionCppProvider,
    _resolved_pack_path,
    runtime_ai_capabilities,
    select_image_provider,
)
from evolabs_engine.image_cache import AiImageCache, ai_image_cache_key
from evolabs_engine.renderer import RenderJob, _character_reference_request, _scene_ai_request


PROJECT = {
    "schemaVersion": 1,
    "id": "project_ai_test",
    "title": "本機 AI 測試",
    "settings": {
        "mode": "anime",
        "format": "9:16",
        "quality": "speed",
        "renderMode": "comic",
        "visualMode": "ai-images",
        "captions": True,
    },
    "characters": [
        {
            "id": "character_a",
            "name": "Evo",
            "appearance": "short black hair, silver jacket",
            "consistencyStrength": 0.76,
        }
    ],
    "scenes": [
        {
            "id": "scene_1",
            "title": "鐘樓",
            "visual": "夜晚校園鐘樓下的角色",
            "dialogue": "Evo：這張圖由本機模型生成。",
            "duration": 1,
            "shot": "中景・緩慢推進",
            "characterIds": ["character_a"],
        }
    ],
}


def _create_fake_sd_cli(root: Path, *, delay_seconds: float = 0) -> tuple[Path, Path]:
    executable = root / "sd-cli"
    script = f"""#!{sys.executable}
import json
import sys
import time
from pathlib import Path
from PIL import Image

HELP = '''-m --model -p --prompt -n --negative-prompt -o --output -W --width -H --height
--steps --cfg-scale -s --seed --sampling-method --diffusion-fa --vae --vae-tiling
--offload-to-cpu --max-vram --clip_vision --ip-adapter --ip-adapter-image --ip-adapter-strength'''
if '--help' in sys.argv:
    print(HELP)
    raise SystemExit(0)
args = sys.argv[1:]
def value(flag):
    return args[args.index(flag) + 1]
time.sleep({delay_seconds!r})
output = Path(value('-o'))
output.parent.mkdir(parents=True, exist_ok=True)
Image.new('RGB', (int(value('-W')), int(value('-H'))), (28, 36, 52)).save(output, 'PNG')
(Path(__file__).parent / 'last-args.json').write_text(json.dumps(args), encoding='utf-8')
"""
    executable.write_text(script, encoding="utf-8")
    executable.chmod(0o755)
    model = root / "anime.safetensors"
    header = json.dumps(
        {"fixture": {"dtype": "F16", "shape": [1], "data_offsets": [0, 2]}},
        separators=(",", ":"),
    ).encode("utf-8")
    with model.open("wb") as handle:
        handle.write(struct.pack("<Q", len(header)))
        handle.write(header)
        handle.write(b"\0\0")
        handle.truncate(1024 * 1024)
    return executable, model


def _recorded_file(pack_root: Path, path: Path, record_id: str) -> dict[str, object]:
    return {
        "id": record_id,
        "kind": "file",
        "destination": path.relative_to(pack_root).as_posix(),
        "size": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def _write_fake_active_pack(root: Path, *, archive_runtime: bool = False) -> tuple[Path, Path, Path]:
    pack_root = root / "models" / "anime-core" / "1.0.0"
    runtime = pack_root / "runtime"
    runtime.mkdir(parents=True)
    executable, model = _create_fake_sd_cli(runtime)
    executable_relative = executable.relative_to(pack_root).as_posix()
    model_relative = model.relative_to(pack_root).as_posix()
    records = [
        _recorded_file(pack_root, executable, "runtime-executable"),
        _recorded_file(pack_root, model, "model"),
    ]
    if archive_runtime:
        installed_entries = [
            {
                "path": str(record["destination"]),
                "size": record["size"],
                "sha256": record["sha256"],
            }
            for record in records
        ]
        records = [
            {
                "id": "runtime-archive",
                "kind": "zip",
                "destination": "runtime",
                "size": 1,
                "sha256": "a" * 64,
                "installedEntries": installed_entries,
            }
        ]
    (root / "models" / "anime-core" / "current.json").write_text(
        json.dumps({"id": "anime-core", "version": "1.0.0"}), encoding="utf-8"
    )
    (pack_root / "pack.json").write_text(
        json.dumps(
            {
                "id": "anime-core",
                "version": "1.0.0",
                "name": "Anime Core",
                "capabilities": ["anime_image"],
                "files": records,
                "resolvedActivation": {
                    "provider": "sd-cli",
                    "executable": executable_relative,
                    "model": model_relative,
                },
            }
        ),
        encoding="utf-8",
    )
    return pack_root, executable, model


@unittest.skipIf(os.name == "nt", "the fake POSIX sd-cli executable is exercised on non-Windows CI")
class StableDiffusionCppProviderTests(unittest.TestCase):
    def test_long_running_generation_can_be_canceled(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable, model = _create_fake_sd_cli(root, delay_seconds=30)
            cancel_after = time.monotonic() + 0.2
            provider = StableDiffusionCppProvider(
                executable,
                model,
                generation_timeout=10,
                cancel_requested=lambda: time.monotonic() >= cancel_after,
                gpu_lock_path=root / "locks" / "gpu.lock",
            )
            request = ImageGenerationRequest(
                prompt="cancel fixture",
                negative_prompt="",
                width=256,
                height=256,
                steps=4,
                cfg_scale=4,
                seed=7,
            )
            destination = root / "canceled.png"

            started = time.monotonic()
            with self.assertRaises(ImageProviderError) as context:
                provider.generate(request, destination)

            self.assertEqual(context.exception.code, "AI_IMAGE_CANCELED")
            self.assertLess(time.monotonic() - started, 3)
            self.assertFalse(destination.exists())
            released = image_providers.GpuFileLock(root / "locks" / "gpu.lock")
            released.acquire(timeout=1)
            released.release()

    def test_help_probe_and_generation_use_low_vram_arguments(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable, model = _create_fake_sd_cli(root)
            clip = root / "clip.safetensors"
            adapter = root / "ip-adapter.safetensors"
            clip.write_bytes(b"clip")
            adapter.write_bytes(b"adapter")
            reference = root / "reference.png"
            Image.new("RGB", (64, 64), "white").save(reference)
            provider = StableDiffusionCppProvider(
                executable,
                model,
                vae=model,
                clip_vision=clip,
                ip_adapter=adapter,
                image_capabilities=("anime_image", "character_consistency"),
                generation_timeout=10,
            )

            capability = provider.probe()
            self.assertTrue(capability.ready)
            self.assertTrue(capability.reference_conditioning)
            destination = root / "out.png"
            generated = provider.generate(
                ImageGenerationRequest(
                    prompt="anime character",
                    negative_prompt="blurry",
                    width=448,
                    height=768,
                    steps=8,
                    cfg_scale=6,
                    seed=123,
                    quality="speed",
                    reference_image=reference,
                    consistency_strength=0.76,
                ),
                destination,
            )

            self.assertTrue(generated.reference_conditioned)
            with Image.open(destination) as image:
                self.assertEqual(image.size, (448, 768))
            arguments = json.loads((root / "last-args.json").read_text(encoding="utf-8"))
            for expected in (
                "--diffusion-fa",
                "--vae",
                "--vae-tiling",
                "--offload-to-cpu",
                "--max-vram",
                "--sampling-method",
                "--clip_vision",
                "--ip-adapter-image",
            ):
                self.assertIn(expected, arguments)
            self.assertEqual(arguments[arguments.index("--max-vram") + 1], "3.0")
            self.assertEqual(arguments[arguments.index("--vae") + 1], str(model))
            self.assertEqual(arguments[arguments.index("--sampling-method") + 1], "euler_a")

    def test_placeholder_model_is_never_reported_ready(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable, model = _create_fake_sd_cli(root)
            model.write_bytes(b"not a model")
            capability = StableDiffusionCppProvider(executable, model).probe()
            self.assertEqual(capability.status, "invalid")
            self.assertIn("占位檔", capability.message)


class CapabilityContractTests(unittest.TestCase):
    def test_pack_activation_rejects_windows_drive_and_ads_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for unsafe in ("D:/outside.safetensors", "model.safetensors:stream", "CON/model.bin"):
                with self.subTest(path=unsafe), self.assertRaises(ImageProviderError):
                    _resolved_pack_path(root, unsafe, required=True)

    def test_health_rows_are_installable_pack_ids_and_do_not_claim_realistic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            if os.name == "nt":
                self.skipTest("fake executable is POSIX-only")
            _write_fake_active_pack(root)
            unavailable = ProviderCapability(
                "automatic1111", "WebUI", "unavailable", "not running"
            )
            with patch.object(Automatic1111Provider, "probe", return_value=unavailable):
                result = runtime_ai_capabilities(root, chinese_voice_available=False)

            self.assertEqual([item["id"] for item in result["modelPacks"]], ["anime-core", "realistic-core"])
            self.assertEqual(result["modelPacks"][0]["status"], "ready")
            self.assertEqual(result["modelPacks"][1]["status"], "missing")
            self.assertTrue(result["capabilities"]["animeImage"])
            self.assertFalse(result["capabilities"]["realisticImage"])

    def test_tampered_runtime_is_rejected_before_execution(self) -> None:
        if os.name == "nt":
            self.skipTest("fake executable is POSIX-only")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, executable, _ = _write_fake_active_pack(root)
            original = executable.read_bytes()
            executable.write_bytes(b"X" * len(original))
            unavailable = ProviderCapability("automatic1111", "WebUI", "unavailable", "not running")
            with patch.object(Automatic1111Provider, "probe", return_value=unavailable), patch.object(
                image_providers, "_run_help"
            ) as run_help:
                result = runtime_ai_capabilities(root, chinese_voice_available=False)

            self.assertEqual(result["modelPacks"][0]["status"], "invalid")
            self.assertIn("SHA-256", result["modelPacks"][0]["message"])
            run_help.assert_not_called()

    def test_integrity_cache_rehashes_when_file_metadata_changes(self) -> None:
        if os.name == "nt":
            self.skipTest("fake executable is POSIX-only")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, _, model = _write_fake_active_pack(root)
            unavailable = ProviderCapability("automatic1111", "WebUI", "unavailable", "not running")
            with patch.object(Automatic1111Provider, "probe", return_value=unavailable), patch.object(
                image_providers,
                "_pack_file_sha256",
                wraps=image_providers._pack_file_sha256,
            ) as digest:
                first = runtime_ai_capabilities(root, chinese_voice_available=False)
                first_hashes = digest.call_count
                second = runtime_ai_capabilities(root, chinese_voice_available=False)
                self.assertEqual(digest.call_count, first_hashes)

                with model.open("r+b") as handle:
                    handle.seek(-1, os.SEEK_END)
                    byte = handle.read(1)
                    handle.seek(-1, os.SEEK_END)
                    handle.write(bytes([byte[0] ^ 0xFF]))
                stat_result = model.stat()
                os.utime(model, ns=(stat_result.st_atime_ns, stat_result.st_mtime_ns + 1_000_000))
                third = runtime_ai_capabilities(root, chinese_voice_available=False)

            self.assertEqual(first["modelPacks"][0]["status"], "ready")
            self.assertEqual(second["modelPacks"][0]["status"], "ready")
            self.assertEqual(third["modelPacks"][0]["status"], "invalid")
            self.assertGreater(digest.call_count, first_hashes)

    def test_archive_runtime_rejects_unrecorded_files(self) -> None:
        if os.name == "nt":
            self.skipTest("fake executable is POSIX-only")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pack_root, _, _ = _write_fake_active_pack(root, archive_runtime=True)
            (pack_root / "runtime" / "unexpected.dll").write_bytes(b"unexpected")
            unavailable = ProviderCapability("automatic1111", "WebUI", "unavailable", "not running")
            with patch.object(Automatic1111Provider, "probe", return_value=unavailable), patch.object(
                image_providers, "_run_help"
            ) as run_help:
                result = runtime_ai_capabilities(root, chinese_voice_available=False)

            self.assertEqual(result["modelPacks"][0]["status"], "invalid")
            self.assertIn("內容已改變", result["modelPacks"][0]["message"])
            run_help.assert_not_called()

    def test_realistic_selection_does_not_reuse_anime_pack(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unavailable = ProviderCapability("automatic1111", "WebUI", "unavailable", "not running")
            with patch.object(Automatic1111Provider, "probe", return_value=unavailable):
                with self.assertRaises(ImageProviderError):
                    select_image_provider(root, {"mode": "realistic", "imageProvider": "auto"})


class _FakeImageProvider:
    provider_id = "fake-local"
    display_name = "Fake test provider"

    def __init__(self) -> None:
        self.generate_calls = 0

    def probe(self) -> ProviderCapability:
        return ProviderCapability(
            self.provider_id,
            self.display_name,
            "ready",
            "ready",
            model_name="test.safetensors",
            version="test-v1",
            details={"imageCapabilities": ["anime_image"], "modelHash": "a" * 64},
        )

    def generate(self, request: ImageGenerationRequest, destination: Path):
        from evolabs_engine.image_providers import GeneratedImage

        self.generate_calls += 1
        Image.new("RGB", (request.width, request.height), (32, 52, 78)).save(destination)
        return GeneratedImage(destination, self.provider_id, "test.safetensors", request.seed, False)


class _UnavailableImageProvider(_FakeImageProvider):
    def probe(self) -> ProviderCapability:
        return ProviderCapability(self.provider_id, self.display_name, "missing", "model missing")


@unittest.skipUnless(shutil.which("ffmpeg"), "system ffmpeg is required for the AI render integration test")
class AiRendererIntegrationTests(unittest.TestCase):
    def test_ai_visual_mode_reaches_real_provider_and_mp4(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            status = RenderJob(
                Path(directory),
                "job_00000000-0000-4000-8000-000000000301",
                json.loads(json.dumps(PROJECT)),
                image_provider=_FakeImageProvider(),
            ).run()
            self.assertEqual(status["state"], "completed")
            self.assertEqual(status["visualMode"], "ai-images")
            self.assertEqual(status["scenes"][0]["visualSource"], "ai")
            preview = Path(status["scenes"][0]["previewPath"])
            self.assertTrue(preview.is_file())
            self.assertEqual(preview.parent.name, "previews")
            self.assertTrue(Path(status["outputPath"]).is_file())
            self.assertIn("本機 AI 實際生成", status["message"])

    def test_second_job_reuses_provenance_complete_ai_cache(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            provider = _FakeImageProvider()
            first = RenderJob(
                root,
                "job_00000000-0000-4000-8000-000000000303",
                json.loads(json.dumps(PROJECT)),
                image_provider=provider,
            ).run()
            second = RenderJob(
                root,
                "job_00000000-0000-4000-8000-000000000304",
                json.loads(json.dumps(PROJECT)),
                image_provider=provider,
            ).run()
            self.assertEqual(first["state"], "completed")
            self.assertEqual(second["state"], "completed")
            # The first run generates one reusable character identity asset and one scene frame.
            # The second run must reuse both provenance-complete cache entries.
            self.assertEqual(provider.generate_calls, 2)
            self.assertTrue(first["characterAssets"][0]["generated"])
            self.assertTrue(second["characterAssets"][0]["cacheHit"])
            self.assertFalse(first["scenes"][0]["cacheHit"])
            self.assertTrue(second["scenes"][0]["cacheHit"])

    def test_explicit_ai_mode_never_silently_falls_back_to_cards(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            status = RenderJob(
                Path(directory),
                "job_00000000-0000-4000-8000-000000000302",
                json.loads(json.dumps(PROJECT)),
                image_provider=_UnavailableImageProvider(),
            ).run()
            self.assertEqual(status["state"], "failed")
            self.assertEqual(status["error"]["code"], "AI_IMAGE_UNAVAILABLE")
            self.assertIsNone(status["outputPath"])


class AiCacheKeyTests(unittest.TestCase):
    def test_every_generation_and_provenance_field_changes_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference_a = root / "a.png"
            reference_b = root / "b.png"
            Image.new("RGB", (64, 64), "red").save(reference_a)
            Image.new("RGB", (64, 64), "blue").save(reference_b)
            request = ImageGenerationRequest(
                "prompt",
                "negative",
                448,
                768,
                12,
                6.0,
                123,
                "balanced",
                reference_a,
                0.72,
            )
            capability = ProviderCapability(
                "sd-cli",
                "SD CLI",
                "ready",
                "ready",
                model_name="anime.safetensors",
                version="1.0.0",
                reference_conditioning=True,
                details={"modelHash": "a" * 64},
            )
            baseline = ai_image_cache_key(request, capability)
            self.assertIsNotNone(baseline)
            self.assertIsNone(ai_image_cache_key(request, replace(capability, version=None)))
            variants = [
                replace(request, prompt="other"),
                replace(request, negative_prompt="other"),
                replace(request, width=384),
                replace(request, height=640),
                replace(request, steps=8),
                replace(request, cfg_scale=7.0),
                replace(request, seed=456),
                replace(request, reference_image=reference_b),
                replace(request, consistency_strength=0.5),
            ]
            for variant in variants:
                self.assertNotEqual(baseline, ai_image_cache_key(variant, capability))
            self.assertNotEqual(
                baseline,
                ai_image_cache_key(request, replace(capability, provider_id="automatic1111")),
            )
            self.assertNotEqual(
                baseline,
                ai_image_cache_key(request, replace(capability, model_name="other.safetensors")),
            )
            self.assertNotEqual(
                baseline,
                ai_image_cache_key(request, replace(capability, version="2.0.0")),
            )
            changed_hash = dict(capability.details)
            changed_hash["modelHash"] = "b" * 64
            self.assertNotEqual(
                baseline,
                ai_image_cache_key(request, replace(capability, details=changed_hash)),
            )

    def test_corrupt_cache_entry_is_rejected_and_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = AiImageCache(root)
            key = "a" * 64
            cached = cache.path_for(key)
            cached.parent.mkdir(parents=True)
            cached.write_bytes(b"not a png" * 20)
            destination = root / "restored.png"
            self.assertFalse(cache.restore(key, destination, (448, 768)))
            self.assertFalse(destination.exists())
            self.assertFalse(cached.exists())

class ReferenceInputTests(unittest.TestCase):
    def test_data_url_is_materialized_as_bounded_png_not_passed_as_argument(self) -> None:
        stream = io.BytesIO()
        Image.new("RGB", (96, 128), "white").save(stream, "PNG")
        project = json.loads(json.dumps(PROJECT))
        project["characters"][0]["referenceImageDataUrl"] = "data:image/png;base64," + base64.b64encode(
            stream.getvalue()
        ).decode("ascii")
        with tempfile.TemporaryDirectory() as directory:
            reference_root = Path(directory) / "work" / "ref"
            request = _scene_ai_request(project, project["scenes"][0], 1, reference_root)
            self.assertIsNotNone(request.reference_image)
            self.assertIn("night", request.prompt)
            self.assertIn("school campus", request.prompt)
            assert request.reference_image is not None
            self.assertTrue(request.reference_image.is_file())
            self.assertEqual(request.reference_image.parent, reference_root)
            self.assertNotIn("data:image", str(request.reference_image))
            with Image.open(request.reference_image) as materialized:
                self.assertEqual(materialized.mode, "RGB")

    def test_realistic_mode_materializes_reference_for_capable_provider(self) -> None:
        stream = io.BytesIO()
        Image.new("RGB", (96, 128), "white").save(stream, "PNG")
        project = json.loads(json.dumps(PROJECT))
        project["settings"]["mode"] = "realistic"
        project["characters"][0]["referenceImageDataUrl"] = "data:image/png;base64," + base64.b64encode(
            stream.getvalue()
        ).decode("ascii")
        with tempfile.TemporaryDirectory() as directory:
            request = _scene_ai_request(project, project["scenes"][0], 1, Path(directory) / "ref")
        self.assertIsNotNone(request.reference_image)
        self.assertIn("photorealistic", request.prompt)

    def test_reference_can_be_disabled_when_selected_provider_cannot_use_it(self) -> None:
        stream = io.BytesIO()
        Image.new("RGB", (96, 128), "white").save(stream, "PNG")
        project = json.loads(json.dumps(PROJECT))
        project["characters"][0]["referenceImageDataUrl"] = "data:image/png;base64," + base64.b64encode(
            stream.getvalue()
        ).decode("ascii")
        with tempfile.TemporaryDirectory() as directory:
            request = _scene_ai_request(
                project,
                project["scenes"][0],
                1,
                Path(directory) / "ref",
                allow_reference=False,
            )
        self.assertIsNone(request.reference_image)

    def test_agent_production_bible_is_inherited_by_scene_prompt(self) -> None:
        project = json.loads(json.dumps(PROJECT))
        project["characters"][0].update({
            "identityAnchor": "oval face, amber eyes, short asymmetric black hair",
            "appearancePrompt": "young woman in a silver cropped jacket",
            "negativePrompt": "blue eyes, long hair",
            "wardrobe": "silver cropped jacket with one red wrist strap",
        })
        project["productionBible"] = {
            "artDirection": {
                "globalPrompt": "premium hand-painted anime thriller, magenta rim light",
                "globalNegativePrompt": "flat lighting, chibi proportions",
            },
            "ipBible": {
                "continuityRules": ["the red wrist strap remains on the right wrist"],
                "prohibitedChanges": ["never change the clock tower facade"],
            },
            "locations": [{
                "id": "location_clock",
                "prompt": "old brick clock tower courtyard with a circular fountain",
                "environmentAnchor": "one arched entrance behind the fountain",
                "lighting": "single warm clock face against cool moonlight",
                "timeOfDay": "midnight",
                "weather": "light rain",
                "keyProps": ["red bicycle"],
                "negativePrompt": "modern skyscraper",
            }],
        }
        project["scenes"][0].update({
            "locationId": "location_clock",
            "startFramePrompt": "Evo stops beside the red bicycle and looks up",
            "composition": "low-angle medium shot",
            "action": "one hand reaches for the clock tower door",
            "emotion": "afraid but determined",
            "motionPrompt": "slow dolly in",
            "continuityIn": "right hand is wet from rain",
            "continuityOut": "right hand touches the brass handle",
            "negativePrompt": "daylight",
        })
        with tempfile.TemporaryDirectory() as directory:
            request = _scene_ai_request(project, project["scenes"][0], 1, Path(directory) / "ref", allow_reference=False)
        self.assertIn("premium hand-painted anime thriller", request.prompt)
        self.assertIn("old brick clock tower courtyard", request.prompt)
        self.assertIn("oval face, amber eyes", request.prompt)
        self.assertIn("red wrist strap remains", request.prompt)
        self.assertIn("never change the clock tower facade", request.prompt)
        self.assertIn("modern skyscraper", request.negative_prompt)
        self.assertIn("blue eyes, long hair", request.negative_prompt)
        self.assertIn("daylight", request.negative_prompt)

    def test_character_reference_request_is_deterministic_and_identity_locked(self) -> None:
        project = json.loads(json.dumps(PROJECT))
        project["productionBible"] = {
            "artDirection": {
                "globalPrompt": "cinematic anime character bible",
                "globalNegativePrompt": "style drift",
            }
        }
        project["characters"][0].update({
            "role": "lead",
            "identityAnchor": "amber eyes, short black hair, triangular scar under left eye",
            "appearancePrompt": "slender teenager, silver bomber jacket",
            "wardrobe": "silver bomber jacket, black skirt, red wrist strap",
            "negativePrompt": "blue eyes, long hair",
        })
        first = _character_reference_request(project, project["characters"][0], 1)
        second = _character_reference_request(project, project["characters"][0], 1)
        self.assertEqual(first.seed, second.seed)
        self.assertIn("triangular scar under left eye", first.prompt)
        self.assertIn("silver bomber jacket", first.prompt)
        self.assertIn("one person only", first.prompt)
        self.assertIn("blue eyes, long hair", first.negative_prompt)
        self.assertIn("style drift", first.negative_prompt)


if __name__ == "__main__":
    unittest.main()
