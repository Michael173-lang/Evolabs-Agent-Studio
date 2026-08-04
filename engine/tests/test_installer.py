from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
import urllib.request
import zipfile
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from evolabs_engine.installer import (
    INSTALL_DISK_HEADROOM_BYTES,
    InstallError,
    _HttpsOnlyRedirectHandler,
    active_pack,
    install_model_pack,
    load_manifest,
)
from evolabs_engine.main import main


class InstallerTests(unittest.TestCase):
    def write_manifest(self, root: Path, artifact: bytes, *, kind: str = "file") -> Path:
        manifest = {
            "schemaVersion": 1,
            "id": "anime-core",
            "version": "0.3.0",
            "name": "動漫 AI 核心",
            "capabilities": ["anime_image"],
            "files": [
                {
                    "id": "fixture",
                    "url": "https://example.invalid/fixture.bin",
                    "size": len(artifact),
                    "sha256": hashlib.sha256(artifact).hexdigest(),
                    "kind": kind,
                    "destination": "models" if kind == "zip" else "models/model.safetensors",
                    "role": "model",
                }
            ],
            "activation": (
                {"provider": "fixture", "executableGlob": "models/**/sd-cli.exe"}
                if kind == "zip"
                else {"provider": "fixture", "modelPath": "models/model.safetensors"}
            ),
        }
        path = root / "manifest.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        return path

    def test_manifest_rejects_path_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = self.write_manifest(root, b"safe")
            for unsafe in ("../outside.bin", "D:/outside.bin", "models/file.bin:stream", "CON/model.bin"):
                raw = json.loads(path.read_text(encoding="utf-8"))
                raw["files"][0]["destination"] = unsafe
                path.write_text(json.dumps(raw), encoding="utf-8")
                with self.subTest(destination=unsafe), self.assertRaises(InstallError):
                    load_manifest(path)
                path = self.write_manifest(root, b"safe")

    def test_every_redirect_hop_must_remain_https(self) -> None:
        handler = _HttpsOnlyRedirectHandler()
        request = urllib.request.Request("https://example.invalid/model")
        with self.assertRaises(InstallError) as raised:
            handler.redirect_request(
                request,
                None,
                302,
                "Found",
                {},
                "http://cdn.example.invalid/model",
            )
        self.assertEqual(raised.exception.code, "DOWNLOAD_REDIRECT")

        safe = handler.redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "https://cdn.example.invalid/model",
        )
        self.assertIsNotNone(safe)
        assert safe is not None
        self.assertEqual(safe.full_url, "https://cdn.example.invalid/model")

    def test_installs_and_activates_verified_file(self) -> None:
        artifact = b"safe-safetensors-fixture"
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = self.write_manifest(root, artifact)

            def fake_download(item, destination, progress, cancel):
                self.assertFalse(cancel())
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(artifact)
                progress(len(artifact))

            with patch("evolabs_engine.installer._download_file", side_effect=fake_download):
                status = install_model_pack(root / "data", "install-test", manifest)
            self.assertEqual(status["state"], "completed")
            self.assertEqual(status["enginePid"], os.getpid())
            pack = active_pack(root / "data", "anime-core")
            self.assertIsNotNone(pack)
            assert pack is not None
            installed = Path(pack["root"]) / "models/model.safetensors"
            self.assertEqual(installed.read_bytes(), artifact)

    def test_rejects_zip_slip_and_does_not_activate(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / "unsafe.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("../outside.txt", "unsafe")
            artifact = archive.read_bytes()
            manifest = self.write_manifest(root, artifact, kind="zip")

            def fake_download(item, destination, progress, cancel):
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(artifact)
                progress(len(artifact))

            with patch("evolabs_engine.installer._download_file", side_effect=fake_download):
                status = install_model_pack(root / "data", "install-test", manifest)
            self.assertEqual(status["state"], "failed")
            self.assertEqual(status["error"]["code"], "ARCHIVE_UNSAFE")
            self.assertFalse((root / "outside.txt").exists())
            self.assertIsNone(active_pack(root / "data", "anime-core"))

    def test_manifest_archive_expansion_limit_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / "oversized.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("bin/sd-cli.exe", b"x" * 256)
            artifact = archive.read_bytes()
            manifest = self.write_manifest(root, artifact, kind="zip")
            raw = json.loads(manifest.read_text(encoding="utf-8"))
            raw["files"][0]["install"] = {"maxExtractedBytes": 128}
            manifest.write_text(json.dumps(raw), encoding="utf-8")

            def fake_download(item, destination, progress, cancel):
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(artifact)
                progress(len(artifact))

            with patch("evolabs_engine.installer._download_file", side_effect=fake_download):
                status = install_model_pack(root / "data", "install-limit", manifest)
            self.assertEqual(status["state"], "failed")
            self.assertEqual(status["error"]["code"], "ARCHIVE_TOO_LARGE")

    def test_verified_runtime_archive_is_reused_across_model_packs(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / "runtime.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("bin/sd-cli.exe", b"fixture executable")
            artifact = archive.read_bytes()
            first_manifest = self.write_manifest(root, artifact, kind="zip")
            first_manifest = first_manifest.rename(root / "anime.json")
            second_raw = json.loads(first_manifest.read_text(encoding="utf-8"))
            second_raw["id"] = "realistic-core"
            second_manifest = root / "realistic.json"
            second_manifest.write_text(json.dumps(second_raw), encoding="utf-8")
            download_calls = 0

            def fake_download(item, destination, progress, cancel):
                nonlocal download_calls
                download_calls += 1
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(artifact)
                progress(len(artifact))

            with patch("evolabs_engine.installer._download_file", side_effect=fake_download):
                first = install_model_pack(root / "data", "install-first", first_manifest)
                second = install_model_pack(root / "data", "install-second", second_manifest)

            self.assertEqual(first["state"], "completed")
            self.assertEqual(second["state"], "completed")
            self.assertEqual(download_calls, 1)
            digest = hashlib.sha256(artifact).hexdigest()
            self.assertEqual((root / "data" / "downloads" / f"{digest}.verified").read_bytes(), artifact)

    def test_corrupt_existing_pack_is_reinstalled_and_reverified(self) -> None:
        artifact = b"safe-safetensors-fixture"
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = self.write_manifest(root, artifact)
            download_calls = 0

            def fake_download(item, destination, progress, cancel):
                nonlocal download_calls
                download_calls += 1
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(artifact)
                progress(len(artifact))

            with patch("evolabs_engine.installer._download_file", side_effect=fake_download):
                first = install_model_pack(root / "data", "install-first", manifest)
                self.assertEqual(first["state"], "completed")
                pack = active_pack(root / "data", "anime-core")
                assert pack is not None
                installed = Path(pack["root"]) / "models/model.safetensors"
                installed.write_bytes(b"corrupt")
                second = install_model_pack(root / "data", "install-second", manifest)

            self.assertEqual(second["state"], "completed")
            self.assertEqual(download_calls, 2)
            repaired = active_pack(root / "data", "anime-core")
            assert repaired is not None
            self.assertEqual((Path(repaired["root"]) / "models/model.safetensors").read_bytes(), artifact)

    def test_cancel_during_hash_never_activates_pack(self) -> None:
        artifact = b"safe-safetensors-fixture"
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data_root = root / "data"
            install_id = "install-cancel-hash"
            manifest = self.write_manifest(root, artifact)

            def fake_download(item, destination, progress, cancel):
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(artifact)
                progress(len(artifact))
                control = data_root / "installs" / install_id / "control.json"
                control.write_text(json.dumps({"action": "cancel"}), encoding="utf-8")

            with patch("evolabs_engine.installer._download_file", side_effect=fake_download):
                status = install_model_pack(data_root, install_id, manifest)

            self.assertEqual(status["state"], "canceled")
            self.assertIsNone(active_pack(data_root, "anime-core"))

    def test_disk_gate_counts_only_missing_bytes_of_resumable_download(self) -> None:
        artifact = b"x" * 100
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data_root = root / "data"
            manifest = self.write_manifest(root, artifact)
            digest = hashlib.sha256(artifact).hexdigest()
            partial = data_root / "downloads" / f"{digest}.part"
            partial.parent.mkdir(parents=True)
            partial.write_bytes(artifact[:60])

            def fake_download(item, destination, progress, cancel):
                destination.write_bytes(artifact)
                progress(len(artifact))

            with patch("evolabs_engine.installer._download_file", side_effect=fake_download), patch(
                "evolabs_engine.installer.shutil.disk_usage",
                return_value=SimpleNamespace(free=INSTALL_DISK_HEADROOM_BYTES + 40),
            ):
                status = install_model_pack(data_root, "install-resume-space", manifest)

            self.assertEqual(status["state"], "completed")

    def test_cancel_before_activation_commit_never_activates_pack(self) -> None:
        artifact = b"safe-safetensors-fixture"
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data_root = root / "data"
            install_id = "install-cancel-commit"
            manifest = self.write_manifest(root, artifact)

            def fake_download(item, destination, progress, cancel):
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(artifact)
                progress(len(artifact))

            def resolve_and_cancel(staging_root, activation):
                control = data_root / "installs" / install_id / "control.json"
                control.write_text(json.dumps({"action": "cancel"}), encoding="utf-8")
                return {"provider": "fixture", "model": "models/model.safetensors"}

            with patch("evolabs_engine.installer._download_file", side_effect=fake_download), patch(
                "evolabs_engine.installer._resolve_activation", side_effect=resolve_and_cancel
            ):
                status = install_model_pack(data_root, install_id, manifest)

            self.assertEqual(status["state"], "canceled")
            self.assertIsNone(active_pack(data_root, "anime-core"))

    def test_engine_cli_routes_model_install_to_real_installer(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = root / "manifest.json"
            manifest.write_text("{}", encoding="utf-8")
            arguments = [
                "evolabs-engine",
                "--data-root",
                str(root / "data"),
                "--install-model-pack",
                str(manifest),
                "--install-id",
                "install-cli-test",
            ]
            with patch.object(sys, "argv", arguments), patch(
                "evolabs_engine.main.install_model_pack",
                return_value={"state": "completed"},
            ) as installer:
                self.assertEqual(main(), 0)
            installer.assert_called_once_with(root / "data", "install-cli-test", manifest)


if __name__ == "__main__":
    unittest.main()
