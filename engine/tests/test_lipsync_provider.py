from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

from evolabs_engine.lipsync_provider import (
    REQUIRED_HELP_OPTIONS,
    LipSyncProviderError,
    LipSyncRequest,
    MuseTalk15Provider,
)


FAKE_INFERENCE = r'''from __future__ import annotations
import pathlib
import json
import sys
import time

if "--help" in sys.argv:
    print(" ".join(%r))
    raise SystemExit(0)

root = pathlib.Path.cwd()
if (root / "FAIL").exists():
    print("fake failure", file=sys.stderr)
    raise SystemExit(7)
if (root / "SLEEP").exists():
    time.sleep(30)
(root / "last-args.json").write_text(json.dumps(sys.argv), encoding="utf-8")

def value(option):
    return sys.argv[sys.argv.index(option) + 1]

result = pathlib.Path(value("--result_dir")) / "v15" / "scene-output.mp4"
result.parent.mkdir(parents=True, exist_ok=True)
result.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"\x00" * 128)
''' % (REQUIRED_HELP_OPTIONS,)


class MuseTalkProviderTests(unittest.TestCase):
    def make_runtime(self, root: Path) -> tuple[Path, Path]:
        package = root / "scripts"
        package.mkdir(parents=True, exist_ok=True)
        (package / "__init__.py").write_text("", encoding="utf-8")
        (package / "inference.py").write_text(FAKE_INFERENCE, encoding="utf-8")
        for relative in MuseTalk15Provider._required_files:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_bytes(b"fixture")
        ffmpeg = root / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        ffmpeg.write_bytes(b"fixture")
        return root, ffmpeg

    def provider(
        self,
        root: Path,
        *,
        cancel_requested=None,
        timeout: float = 10,
        gpu_lock: Path | None = None,
    ) -> MuseTalk15Provider:
        runtime, ffmpeg = self.make_runtime(root)
        return MuseTalk15Provider(
            Path(sys.executable),
            runtime,
            ffmpeg,
            cuda_available=True,
            vram_mb=4096,
            generation_timeout=timeout,
            cancel_requested=cancel_requested,
            gpu_lock_path=gpu_lock,
        )

    @staticmethod
    def inputs(root: Path) -> LipSyncRequest:
        video = root / "input.mp4"
        audio = root / "voice.wav"
        video.write_bytes(b"video")
        audio.write_bytes(b"audio")
        return LipSyncRequest(video, audio, duration_seconds=8, subject_count=1, fps=25)

    def test_unconfigured_provider_is_missing_not_ready(self) -> None:
        provider = MuseTalk15Provider(None, None, None, cuda_available=True, vram_mb=4096)
        capability = provider.probe()
        self.assertEqual(capability.status, "missing")
        self.assertFalse(capability.ready)
        self.assertFalse(capability.details["managedInstall"])

    def test_cpu_and_sub_4gb_are_hard_gated(self) -> None:
        cpu = MuseTalk15Provider(None, None, None, cuda_available=False, vram_mb=16384).probe()
        low_vram = MuseTalk15Provider(None, None, None, cuda_available=True, vram_mb=3072).probe()
        self.assertEqual(cpu.status, "unavailable")
        self.assertEqual(low_vram.status, "unavailable")

    def test_probe_requires_complete_runtime_and_expected_cli(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            provider = self.provider(root)
            self.assertTrue(provider.probe().ready)
            (root / "models/whisper/pytorch_model.bin").unlink()
            incomplete = MuseTalk15Provider(
                Path(sys.executable), root, root / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"),
                cuda_available=True, vram_mb=4096,
            ).probe()
            self.assertEqual(incomplete.status, "missing")

    def test_generate_single_subject_fp16_min_batch_and_atomic_mp4(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            provider = self.provider(root, gpu_lock=root / "gpu.lock")
            request = self.inputs(root)
            destination = root / "final.mp4"
            result = provider.generate(request, destination)
            self.assertEqual(result.path, destination)
            self.assertEqual(destination.read_bytes()[4:8], b"ftyp")
            self.assertTrue((root / "gpu.lock").exists())
            arguments = (root / "last-args.json").read_text(encoding="utf-8")
            self.assertIn('"--use_float16"', arguments)
            self.assertIn('"--batch_size", "1"', arguments)
            self.assertIn('"--version", "v15"', arguments)

    def test_rejects_multi_subject_and_unsafe_duration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            provider = self.provider(root)
            request = self.inputs(root)
            with self.assertRaisesRegex(LipSyncProviderError, "一名"):
                provider.generate(
                    LipSyncRequest(request.source_video, request.audio, duration_seconds=8, subject_count=2),
                    root / "multi.mp4",
                )
            with self.assertRaisesRegex(LipSyncProviderError, "30"):
                provider.generate(
                    LipSyncRequest(request.source_video, request.audio, duration_seconds=31),
                    root / "long.mp4",
                )

    def test_cancel_stops_fake_runtime_and_leaves_no_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.make_runtime(root)
            (root / "SLEEP").write_text("1", encoding="utf-8")
            started = time.monotonic()
            provider = MuseTalk15Provider(
                Path(sys.executable), root, root / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"),
                cuda_available=True, vram_mb=4096,
                cancel_requested=lambda: time.monotonic() - started > 0.2,
                generation_timeout=10,
                gpu_lock_path=root / "gpu.lock",
            )
            destination = root / "canceled.mp4"
            with self.assertRaises(LipSyncProviderError) as raised:
                provider.generate(self.inputs(root), destination)
            self.assertEqual(raised.exception.code, "LIPSYNC_CANCELED")
            self.assertFalse(destination.exists())

    def test_nonzero_and_missing_output_are_never_reported_as_success(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            provider = self.provider(root)
            (root / "FAIL").write_text("1", encoding="utf-8")
            with self.assertRaises(LipSyncProviderError) as raised:
                provider.generate(self.inputs(root), root / "failed.mp4")
            self.assertEqual(raised.exception.code, "LIPSYNC_PROCESS_FAILED")


if __name__ == "__main__":
    unittest.main()
