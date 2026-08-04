from __future__ import annotations

import base64
import hashlib
import json
import lzma
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.7.0"
SHA256 = "220320fb5dff3beccdfe415fcc063431fa70e25684bb772b45a555221b7ca0ed"
PARTS = ROOT / "scripts" / ".v070-payload"
WORKFLOW_PATH = ".github/workflows/windows-installer.yml"


def main() -> int:
    encoded = "".join(path.read_text(encoding="ascii").strip() for path in sorted(PARTS.glob("part-*.txt")))
    raw = lzma.decompress(base64.b64decode(encoded))
    actual_sha256 = hashlib.sha256(raw).hexdigest()
    if actual_sha256 != SHA256:
        decoded = json.loads(raw.decode("utf-8"))
        raise RuntimeError(
            f"Evolabs v0.7.0 payload verification failed: expected={SHA256}, "
            f"actual={actual_sha256}, files={len(decoded)}"
        )
    files = json.loads(raw.decode("utf-8"))
    # GitHub's workflow token cannot modify workflow files. The connected
    # publisher applies this verified file separately after materialization.
    files.pop(WORKFLOW_PATH, None)
    for relative, content in files.items():
        target = ROOT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="")
        print(f"materialized {relative}")

    subprocess.run([sys.executable, str(ROOT / "scripts" / "sync-release-version.py"), VERSION], cwd=ROOT, check=True)
    subprocess.run([sys.executable, "-m", "py_compile", str(ROOT / "scripts" / "sync-release-version.py"), str(ROOT / "scripts" / "generate_icons.py")], cwd=ROOT, check=True)

    shutil.rmtree(PARTS, ignore_errors=True)
    (ROOT / "scripts" / "materialize-v070.py").unlink(missing_ok=True)
    print("Evolabs v0.7.0 source materialization complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
