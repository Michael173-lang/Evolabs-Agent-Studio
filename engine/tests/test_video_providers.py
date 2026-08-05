from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from PIL import Image

from evolabs_engine.video_providers import (
    ComfyUiVideoProvider,
    VideoGenerationRequest,
    VideoProviderError,
    _validate_workflow,
)


class _State:
    def __init__(self, *, image_only: bool = False) -> None:
        self.image_only = image_only
        self.prompt_payload: dict[str, Any] | None = None
        self.upload_body = b""


class _Handler(BaseHTTPRequestHandler):
    server_version = "EvolabsComfyFixture/1.0"

    @property
    def state(self) -> _State:
        return self.server.state  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _json(self, value: Any, status: int = 200) -> None:
        payload = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        if self.path == "/system_stats":
            self._json({"system": {"os": "fixture"}, "devices": [{"name": "fixture GPU"}]})
            return
        if self.path == "/object_info":
            self._json({
                "EvolabsVideoModelFixture": {
                    "input": {"required": {}},
                    "output": ["LATENT"],
                    "output_name": ["latent"],
                    "name": "EvolabsVideoModelFixture",
                    "display_name": "Evolabs fixture",
                    "description": "test fixture",
                    "category": "testing",
                },
                "VHS_VideoCombine": {
                    "input": {"required": {}},
                    "output": ["VHS_FILENAMES"],
                    "output_name": ["files"],
                    "name": "VHS_VideoCombine",
                    "display_name": "Video combine fixture",
                    "description": "test video output fixture",
                    "category": "testing",
                }
            })
            return
        if self.path == "/history/prompt-1":
            filename = "static.png" if self.state.image_only else "scene.mp4"
            key = "images" if self.state.image_only else "videos"
            self._json({
                "prompt-1": {
                    "status": {"completed": True, "status_str": "success"},
                    "outputs": {"9": {key: [{"filename": filename, "subfolder": "evolabs", "type": "output"}]}}
                }
            })
            return
        if self.path.startswith("/view?"):
            body = (b"fixture-video-output" * 128)[:2048]
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        if self.path == "/upload/image":
            self.state.upload_body = body
            self._json({"name": "reference.png", "subfolder": "evolabs", "type": "input"})
            return
        if self.path == "/prompt":
            self.state.prompt_payload = json.loads(body.decode("utf-8"))
            self._json({"prompt_id": "prompt-1", "number": 1})
            return
        if self.path == "/interrupt":
            self._json({"ok": True})
            return
        self._json({"error": "not found"}, 404)


class _FixtureServer:
    def __init__(self, *, image_only: bool = False) -> None:
        self.state = _State(image_only=image_only)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.httpd.state = self.state  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def endpoint(self) -> str:
        host, port = self.httpd.server_address
        return f"http://{host}:{port}"

    def __enter__(self) -> "_FixtureServer":
        self.thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)


WORKFLOW = {
    "1": {
        "class_type": "EvolabsVideoModelFixture",
        "inputs": {
            "positive": "{{EVOLABS_PROMPT}}",
            "negative": "{{EVOLABS_NEGATIVE_PROMPT}}",
            "seed": "{{EVOLABS_SEED}}",
            "width": "{{EVOLABS_WIDTH}}",
            "height": "{{EVOLABS_HEIGHT}}",
            "frames": "{{EVOLABS_FRAMES}}",
            "fps": "{{EVOLABS_FPS}}",
            "filename_prefix": "{{EVOLABS_OUTPUT_PREFIX}}",
            "ckpt_name": "ltx-video-2b-distilled-fp8.safetensors",
        },
    },
    "9": {
        "class_type": "VHS_VideoCombine",
        "inputs": {
            "images": ["1", 0],
            "frame_rate": "{{EVOLABS_FPS}}",
            "filename_prefix": "{{EVOLABS_OUTPUT_PREFIX}}",
        },
    },
}


class ComfyUiVideoProviderTests(unittest.TestCase):
    def _request(self, *, input_image: Path | None = None) -> VideoGenerationRequest:
        return VideoGenerationRequest(
            prompt="A student turns toward a clock tower",
            negative_prompt="nudity, extra eyes",
            seed=12345,
            width=512,
            height=288,
            frames=65,
            fps=16,
            output_prefix="evolabs/test/scene-001",
            input_image=input_image,
        )

    def test_real_video_output_is_downloaded_and_all_bindings_are_applied(self) -> None:
        with _FixtureServer() as server, tempfile.TemporaryDirectory() as directory:
            provider = ComfyUiVideoProvider(
                endpoint=server.endpoint,
                workflow_name="LTX low VRAM fixture",
                workflow=WORKFLOW,
                model_names=("ltx-video-2b-distilled-fp8.safetensors",),
                poll_interval=0.01,
                timeout_seconds=5,
            )
            result = provider.generate(self._request(), Path(directory) / "shot.mp4")

            self.assertTrue(result.path.is_file())
            self.assertEqual(result.path.suffix, ".mp4")
            self.assertGreater(result.path.stat().st_size, 1024)
            self.assertEqual(result.prompt_id, "prompt-1")
            self.assertEqual(result.model_names, ("ltx-video-2b-distilled-fp8.safetensors",))
            posted = server.state.prompt_payload
            self.assertIsNotNone(posted)
            inputs = posted["prompt"]["1"]["inputs"]  # type: ignore[index]
            self.assertEqual(inputs["positive"], "A student turns toward a clock tower")
            self.assertEqual(inputs["negative"], "nudity, extra eyes")
            self.assertEqual(inputs["seed"], 12345)
            self.assertEqual(inputs["width"], 512)
            self.assertEqual(inputs["height"], 288)
            self.assertEqual(inputs["frames"], 65)
            self.assertEqual(inputs["fps"], 16)

    def test_image_only_workflow_can_never_masquerade_as_ai_video(self) -> None:
        with _FixtureServer(image_only=True) as server, tempfile.TemporaryDirectory() as directory:
            provider = ComfyUiVideoProvider(
                endpoint=server.endpoint,
                workflow_name="Invalid image-only fixture",
                workflow=WORKFLOW,
                poll_interval=0.01,
                timeout_seconds=5,
            )
            with self.assertRaises(VideoProviderError) as context:
                provider.generate(self._request(), Path(directory) / "shot.mp4")
            self.assertEqual(context.exception.code, "COMFYUI_VIDEO_OUTPUT_REQUIRED")

    def test_reference_workflow_uploads_the_input_image(self) -> None:
        workflow = json.loads(json.dumps(WORKFLOW))
        workflow["1"]["inputs"]["image"] = "{{EVOLABS_INPUT_IMAGE}}"
        with _FixtureServer() as server, tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "reference.png"
            Image.new("RGB", (64, 64), "navy").save(reference)
            provider = ComfyUiVideoProvider(
                endpoint=server.endpoint,
                workflow_name="I2V fixture",
                workflow=workflow,
                poll_interval=0.01,
                timeout_seconds=5,
            )
            provider.generate(self._request(input_image=reference), Path(directory) / "shot.mp4")
            self.assertIn(b'filename="evolabs-', server.state.upload_body)
            posted = server.state.prompt_payload
            self.assertEqual(posted["prompt"]["1"]["inputs"]["image"], "evolabs/reference.png")  # type: ignore[index]


    def test_output_prefix_is_required_in_node_inputs(self) -> None:
        workflow = json.loads(json.dumps(WORKFLOW))
        workflow["1"]["inputs"].pop("filename_prefix", None)
        workflow["9"]["inputs"].pop("filename_prefix", None)
        workflow["9"]["_meta"] = {"note": "{{EVOLABS_OUTPUT_PREFIX}}"}
        with self.assertRaises(VideoProviderError) as context:
            _validate_workflow(workflow)
        self.assertEqual(context.exception.code, "VIDEO_WORKFLOW_BINDING")
        self.assertIn("EVOLABS_OUTPUT_PREFIX", context.exception.message)

    def test_load_video_node_is_not_accepted_as_an_output(self) -> None:
        workflow = {
            "1": {
                "class_type": "LoadVideo",
                "inputs": {
                    "prompt": "{{EVOLABS_PROMPT}} {{EVOLABS_NEGATIVE_PROMPT}}",
                    "seed": "{{EVOLABS_SEED}}",
                    "frames": "{{EVOLABS_FRAMES}}",
                    "fps": "{{EVOLABS_FPS}}",
                    "video": "input-reference.mp4",
                },
            }
        }
        with self.assertRaises(VideoProviderError) as context:
            _validate_workflow(workflow)
        self.assertEqual(context.exception.code, "COMFYUI_VIDEO_OUTPUT_REQUIRED")

    def test_non_loopback_endpoint_is_rejected(self) -> None:
        with self.assertRaises(VideoProviderError) as context:
            ComfyUiVideoProvider("https://example.com", "remote", WORKFLOW)
        self.assertEqual(context.exception.code, "VIDEO_PROVIDER_ENDPOINT")


if __name__ == "__main__":
    unittest.main()
