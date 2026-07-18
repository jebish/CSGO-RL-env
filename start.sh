#!/usr/bin/env bash
# macOS / Linux / Git Bash — thin wrapper around start.py
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if command -v python3 >/dev/null 2>&1; then
  exec python3 start.py
elif command -v python >/dev/null 2>&1; then
  exec python start.py
else
  echo "Python 3 is required. Install from https://www.python.org/downloads/"
  exit 1
fi
