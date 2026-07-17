#!/usr/bin/env python3
"""One-shot / periodic push of server/ to your HF Space (no Docker)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
SPACE_NAME = "RL-PVP"


def main() -> int:
    load_dotenv(ROOT / ".env.local")
    token = (os.environ.get("HF_TOKEN") or "").strip()
    if not token:
        print("Set HF_TOKEN in .env.local first")
        return 1

    try:
        from huggingface_hub import HfApi, create_repo
    except ImportError:
        print("pip install huggingface_hub")
        return 1

    who = httpx.get(
        "https://huggingface.co/api/whoami-v2",
        headers={"Authorization": f"Bearer {token}"},
        timeout=20,
    )
    if who.status_code != 200:
        print(f"HF login failed ({who.status_code})")
        return 1
    user = who.json().get("name")
    if not user:
        print("No username from HF")
        return 1

    repo_id = f"{user}/{SPACE_NAME}"
    api = HfApi(token=token)
    try:
        create_repo(repo_id, repo_type="space", space_sdk="gradio", exist_ok=True, token=token)
    except Exception as exc:
        print(f"create_repo: {exc}")

    api.upload_folder(
        folder_path=str(SERVER),
        repo_id=repo_id,
        repo_type="space",
        token=token,
        ignore_patterns=[".venv/**", "__pycache__/**", "*.pyc"],
    )

    # HF runtime subdomains are lowercase; spaces → hyphens
    slug = SPACE_NAME.replace("_", "-").replace(" ", "-").lower()
    space_url = f"https://{user.lower()}-{slug}.hf.space"

    env_path = ROOT / ".env.local"
    text = env_path.read_text() if env_path.exists() else ""
    lines = []
    found = False
    for line in text.splitlines():
        if line.startswith("HF_SPACE_URL="):
            lines.append(f"HF_SPACE_URL={space_url}")
            found = True
        else:
            lines.append(line)
    if not found:
        lines.append(f"HF_SPACE_URL={space_url}")
    env_path.write_text("\n".join(lines) + "\n")

    print(f"Pushed {repo_id}")
    print(f"Spectators: https://huggingface.co/spaces/{repo_id}")
    print(f"Clients use: {space_url}")
    print("Wrote HF_SPACE_URL into .env.local")
    return 0


if __name__ == "__main__":
    sys.exit(main())
