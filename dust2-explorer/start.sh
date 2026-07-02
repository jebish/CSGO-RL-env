#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

mkdir -p assets

[[ -d .venv ]] || python3 -m venv .venv
source .venv/bin/activate
python serve.py
