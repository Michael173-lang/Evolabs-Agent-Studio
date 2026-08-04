from __future__ import annotations

import uuid
from typing import Any

from .cache import node_cache_key


def _node(
    node_type: str,
    resource_class: str,
    parameters: dict[str, Any],
    dependencies: list[str] | None = None,
    shot_id: str | None = None,
    model_hashes: list[str] | None = None,
) -> dict[str, Any]:
    dependencies = dependencies or []
    model_hashes = model_hashes or []
    return {
        "id": f"node_{uuid.uuid4()}",
        "shot_id": shot_id,
        "node_type": node_type,
        "resource_class": resource_class,
        "parameters": parameters,
        "dependencies": dependencies,
        "node_key": node_cache_key(node_type, 1, parameters, dependencies, model_hashes),
    }


def build_comic_dag(
    project: dict[str, Any],
    sample_limit: int | None = None,
    model_hashes: list[str] | None = None,
) -> list[dict[str, Any]]:
    """RTX 3050 path: reuse characters/backgrounds instead of regenerating every video frame."""
    nodes: list[dict[str, Any]] = []
    model_hashes = model_hashes or []
    settings = project.get("settings", {})
    image_sizes = {"9:16": [432, 768], "16:9": [768, 432], "1:1": [512, 512]}
    export_sizes = {"9:16": [720, 1280], "16:9": [1280, 720], "1:1": [1080, 1080]}
    image_size = image_sizes.get(settings.get("format", "9:16"), [432, 768])
    export_size = export_sizes.get(settings.get("format", "9:16"), [720, 1280])
    quality_steps = {"speed": 8, "balanced": 18, "cinema": 24}.get(settings.get("quality", "balanced"), 18)
    character_by_id = {character["id"]: character for character in project.get("characters", [])}
    character_nodes: dict[str, str] = {}
    for character in project.get("characters", []):
        node = _node(
            "character.sprite",
            "GPU_EXCLUSIVE",
            {
                "character_id": character["id"],
                "appearance": character.get("appearance", ""),
                "mode": settings.get("mode", "anime"),
                "size": image_size,
                "quality_steps": quality_steps,
            },
            model_hashes=model_hashes,
        )
        nodes.append(node)
        character_nodes[character["id"]] = node["node_key"]

    shot_outputs: list[str] = []
    scenes = project.get("scenes", [])
    if sample_limit is not None:
        scenes = scenes[:sample_limit]
    for scene in scenes:
        background = _node(
            "scene.background",
            "GPU_EXCLUSIVE",
            {
                "scene_id": scene["id"],
                "visual": scene.get("visual", ""),
                "size": image_size,
                "quality_steps": quality_steps,
                "render_mode": settings.get("renderMode", "comic"),
            },
            shot_id=scene["id"],
            model_hashes=model_hashes,
        )
        character_ids = [
            character_id for character_id in scene.get("characterIds", []) if character_id in character_by_id
        ]
        voice = _node(
            "dialogue.tts",
            "CPU_HEAVY",
            {
                "scene_id": scene["id"],
                "dialogue": scene.get("dialogue", ""),
                "voices": [character_by_id[character_id].get("voice", "中性・自然") for character_id in character_ids],
                "sample_rate": 24000,
            },
            shot_id=scene["id"],
            model_hashes=model_hashes,
        )
        dependencies = [background["node_key"], voice["node_key"]]
        dependencies.extend(
            character_nodes[character_id]
            for character_id in scene.get("characterIds", [])
            if character_id in character_nodes
        )
        compose = _node(
            "shot.compose",
            "FFMPEG",
            {
                "scene_id": scene["id"],
                "duration": scene.get("duration", 5),
                "shot": scene.get("shot", "中景・固定鏡頭"),
                "preview_size": [360, 640],
                "preview_fps": 12,
                "captions": bool(settings.get("captions", True)),
                "format": settings.get("format", "9:16"),
            },
            dependencies=dependencies,
            shot_id=scene["id"],
            model_hashes=model_hashes,
        )
        nodes.extend([background, voice, compose])
        shot_outputs.append(compose["node_key"])

    nodes.append(
        _node(
            "project.export",
            "FFMPEG",
            {
                "project_id": project["id"],
                "size": export_size,
                "fps": 24,
                "video_codec": "libx264",
                "audio_codec": "aac",
                "captions": bool(settings.get("captions", True)),
                "ordered_shots": shot_outputs,
            },
            dependencies=shot_outputs,
            model_hashes=model_hashes,
        )
    )
    return nodes
