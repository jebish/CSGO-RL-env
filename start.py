#!/usr/bin/env python3
"""Cross-platform launcher (Windows / macOS / Linux).

  python start.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
REQ = ROOT / "requirements.txt"


def _python() -> Path:
    if os.name == "nt":
        return VENV / "Scripts" / "python.exe"
    return VENV / "bin" / "python"


def _ensure_venv() -> Path:
    py = _python()
    if not py.is_file():
        print(f"Creating virtualenv at {VENV} …")
        venv.create(VENV, with_pip=True)
    if not py.is_file():
        sys.exit(f"Failed to create venv python at {py}")
    return py


def main() -> int:
    os.chdir(ROOT)
    (ROOT / "assets").mkdir(exist_ok=True)

    py = _ensure_venv()
    if not REQ.is_file():
        sys.exit(f"Missing {REQ}")

    print("Installing dependencies …")
    subprocess.check_call([str(py), "-m", "pip", "install", "-q", "-r", str(REQ)])

    print("Starting server …")
    # Replace this process so Ctrl+C / signals behave normally.
    if os.name == "nt":
        return subprocess.call([str(py), str(ROOT / "serve.py")])
    os.execv(str(py), [str(py), str(ROOT / "serve.py")])
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
