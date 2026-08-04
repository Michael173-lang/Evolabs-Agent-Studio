from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

from evolabs_engine.process_control import GpuFileLock, GpuLockTimeout, ProcessCanceled, run_cancellable


class CancellableProcessTests(unittest.TestCase):
    def test_normal_process_returns_completed_process_data(self) -> None:
        result = run_cancellable(
            [sys.executable, "-c", "print('ready')"],
            timeout=5,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "ready")

    def test_long_running_process_is_terminated_when_canceled(self) -> None:
        cancel_after = time.monotonic() + 0.15
        started = time.monotonic()
        with self.assertRaises(ProcessCanceled):
            run_cancellable(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                timeout=10,
                cancel_requested=lambda: time.monotonic() >= cancel_after,
                poll_interval=0.02,
            )
        self.assertLess(time.monotonic() - started, 3)


class GpuFileLockTests(unittest.TestCase):
    def test_two_workers_cannot_hold_the_gpu_lock_together(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "locks" / "gpu.lock"
            first = GpuFileLock(path)
            second = GpuFileLock(path)
            first.acquire(timeout=1)
            try:
                with self.assertRaises(GpuLockTimeout) as context:
                    second.acquire(timeout=0.15, poll_interval=0.02)
                self.assertEqual(context.exception.owner.get("pid"), os.getpid())
                self.assertTrue(context.exception.owner.get("pidRunning"))
                self.assertTrue(path.is_file())
            finally:
                first.release()

            second.acquire(timeout=1)
            second.release()
            self.assertTrue(path.is_file(), "the shared lock file must never be unlinked")

    def test_stale_owner_metadata_is_replaced_only_after_lock_acquisition(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "gpu.lock"
            stale_pid = 2_000_000_000
            path.write_text(json.dumps({"schemaVersion": 1, "pid": stale_pid}), encoding="utf-8")

            lock = GpuFileLock(path)
            lock.acquire(timeout=1)
            try:
                owner = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(owner["pid"], os.getpid())
            finally:
                lock.release()
            self.assertTrue(path.exists())


if __name__ == "__main__":
    unittest.main()
