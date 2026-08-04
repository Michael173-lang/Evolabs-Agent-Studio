from __future__ import annotations

import unittest
from unittest.mock import patch

from evolabs_engine.main import main


class MainArgumentTests(unittest.TestCase):
    def test_scene_id_and_sample_limit_are_mutually_exclusive(self) -> None:
        with patch(
            "sys.argv",
            [
                "evolabs-engine",
                "--render-project",
                "project.json",
                "--job-id",
                "job_00000000-0000-4000-8000-000000000113",
                "--sample-limit",
                "3",
                "--scene-id",
                "scene_1",
            ],
        ):
            with self.assertRaises(SystemExit) as context:
                main()
        self.assertEqual(context.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
