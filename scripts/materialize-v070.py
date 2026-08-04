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
SHA256 = "ca10b6e443fb34fdb9f23a25854629d5085fde59c11c2d0f3e0a78bac9128e00"
PARTS = ROOT / "scripts" / ".v070-payload"
# This marker intentionally retriggers the branch materialization workflow.


def main() -> int:
    encoded = "".join(path.read_text(encoding="ascii").strip() for path in sorted(PARTS.glob("part-*.txt")))
    raw = lzma.decompress(base64.b64decode(encoded))
    if hashlib.sha256(raw).hexdigest() != SHA256:
        raise RuntimeError("Evolabs v0.7.0 payload verification failed.")
    files = json.loads(raw.decode("utf-8"))
    for relative, content in files.items():
        target = ROOT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="")
        print(f"materialized {relative}")

    subprocess.run([sys.executable, str(ROOT / "scripts" / "sync-release-version.py"), VERSION], cwd=ROOT, check=True)
    subprocess.run([sys.executable, "-m", "py_compile", str(ROOT / "scripts" / "sync-release-version.py"), str(ROOT / "scripts" / "generate_icons.py")], cwd=ROOT, check=True)

    shutil.rmtree(PARTS, ignore_errors=True)
    for temporary in (ROOT / "scripts" / "materialize-v070.py", ROOT / ".github" / "workflows" / "materialize-v070.yml"):
        temporary.unlink(missing_ok=True)
    print("Evolabs v0.7.0 source materialization complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
