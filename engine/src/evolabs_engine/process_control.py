from __future__ import annotations

import errno
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Callable, Mapping, Sequence


CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
CancelCallback = Callable[[], bool]
WINDOWS_LOCK_OFFSET = 1024 * 1024


class ProcessCanceled(RuntimeError):
    """Raised after a cancellable child process has been stopped and reaped."""


class GpuLockCanceled(RuntimeError):
    """Raised when a caller cancels while waiting for the shared GPU lock."""


class GpuLockTimeout(TimeoutError):
    def __init__(self, path: Path, owner: Mapping[str, object] | None = None) -> None:
        detail = ""
        if owner:
            pid = owner.get("pid")
            state = "running" if owner.get("pidRunning") else "stale"
            detail = f"; recorded owner pid={pid!r} ({state})"
        super().__init__(f"timed out waiting for GPU lock {path}{detail}")
        self.path = path
        self.owner = dict(owner or {})


def _stop_process(process: subprocess.Popen[str], grace_seconds: float) -> tuple[str, str]:
    if process.poll() is None:
        try:
            process.terminate()
        except OSError:
            pass
    try:
        return process.communicate(timeout=max(0.05, grace_seconds))
    except subprocess.TimeoutExpired:
        if process.poll() is None:
            try:
                process.kill()
            except OSError:
                pass
        return process.communicate()


def run_cancellable(
    arguments: Sequence[str | os.PathLike[str]],
    *,
    timeout: float,
    cancel_requested: CancelCallback | None = None,
    cwd: str | os.PathLike[str] | None = None,
    env: Mapping[str, str] | None = None,
    poll_interval: float = 0.1,
    terminate_grace: float = 3.0,
) -> subprocess.CompletedProcess[str]:
    """Run a child while polling cancellation and always reap it before returning.

    Non-zero exit codes are returned to the caller. Cancellation and timeout stop
    the child first, then raise ``ProcessCanceled`` or ``TimeoutExpired``.
    """

    command = [os.fspath(value) for value in arguments]
    if not command:
        raise ValueError("arguments must not be empty")
    if timeout <= 0:
        raise ValueError("timeout must be positive")
    interval = max(0.02, min(1.0, poll_interval))
    started = time.monotonic()
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=cwd,
        env=None if env is None else dict(env),
        creationflags=CREATE_NO_WINDOW,
    )
    while True:
        if cancel_requested is not None and cancel_requested():
            _stop_process(process, terminate_grace)
            raise ProcessCanceled("process canceled")
        remaining = timeout - (time.monotonic() - started)
        if remaining <= 0:
            stdout, stderr = _stop_process(process, terminate_grace)
            raise subprocess.TimeoutExpired(command, timeout, output=stdout, stderr=stderr)
        try:
            stdout, stderr = process.communicate(timeout=min(interval, remaining))
            return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
        except subprocess.TimeoutExpired:
            continue


def _pid_is_running(pid: object) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        # os.kill(pid, 0) is not a harmless existence probe on Windows: signals
        # other than CTRL events are implemented with TerminateProcess.
        import ctypes

        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            # Access denied still proves that a process currently owns the PID.
            return ctypes.get_last_error() == 5
        try:
            exit_code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return True
            return exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except OSError as error:
        return error.errno == errno.EPERM
    return True


class GpuFileLock:
    """Advisory cross-process GPU lock whose lock file is never unlinked.

    The OS releases the actual lock when a process exits. Owner metadata may be
    stale after a crash, but it is informational only: stale files are never
    deleted and are overwritten only after the OS lock has been acquired.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._handle: object | None = None

    @staticmethod
    def _try_lock(handle: object) -> bool:
        if os.name == "nt":
            import msvcrt

            # Lock a byte far beyond the JSON metadata. Locking byte 0 on
            # Windows prevents other handles from reading the owner metadata,
            # which breaks diagnostics and even same-process tests. Windows
            # permits byte-range locks beyond EOF, so the file remains valid
            # UTF-8 JSON while the advisory lock stays independent.
            handle.seek(WINDOWS_LOCK_OFFSET)  # type: ignore[attr-defined]
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)  # type: ignore[attr-defined]
                return True
            except OSError:
                return False
        import fcntl

        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)  # type: ignore[attr-defined]
            return True
        except (BlockingIOError, OSError):
            return False

    @staticmethod
    def _unlock(handle: object) -> None:
        if os.name == "nt":
            import msvcrt

            handle.seek(WINDOWS_LOCK_OFFSET)  # type: ignore[attr-defined]
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)  # type: ignore[attr-defined]
            return
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)  # type: ignore[attr-defined]

    @staticmethod
    def _owner(handle: object) -> dict[str, object] | None:
        try:
            handle.seek(0)  # type: ignore[attr-defined]
            raw = handle.read(64 * 1024)  # type: ignore[attr-defined]
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", "replace")
            value = json.loads(raw)
            if not isinstance(value, dict):
                return None
            owner = dict(value)
            owner["pidRunning"] = _pid_is_running(owner.get("pid"))
            return owner
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
            return None

    def acquire(
        self,
        *,
        timeout: float,
        cancel_requested: CancelCallback | None = None,
        poll_interval: float = 0.1,
    ) -> None:
        if self._handle is not None:
            raise RuntimeError("GPU lock is already acquired by this object")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        try:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\n")
                handle.flush()
                os.fsync(handle.fileno())
            started = time.monotonic()
            owner: dict[str, object] | None = None
            interval = max(0.02, min(1.0, poll_interval))
            while not self._try_lock(handle):
                owner = self._owner(handle)
                if cancel_requested is not None and cancel_requested():
                    raise GpuLockCanceled("GPU lock wait canceled")
                if time.monotonic() - started >= timeout:
                    raise GpuLockTimeout(self.path, owner)
                time.sleep(interval)
            metadata = {
                "schemaVersion": 1,
                "pid": os.getpid(),
                "acquiredAtUnixMs": int(time.time() * 1000),
            }
            handle.seek(0)
            handle.truncate()
            handle.write((json.dumps(metadata, separators=(",", ":")) + "\n").encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
            self._handle = handle
        except Exception:
            handle.close()
            raise

    def release(self) -> None:
        handle = self._handle
        if handle is None:
            return
        self._handle = None
        try:
            self._unlock(handle)
        finally:
            handle.close()  # type: ignore[attr-defined]

    def __enter__(self) -> GpuFileLock:
        self.acquire(timeout=45 * 60)
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        self.release()
