#!/usr/bin/env python3
"""Local game host: static files + HF identity + lobby/match server.

HF Space is optional (cross-internet / spectators). If the Space is stuck
building, lobbies still run here on localhost.
"""

from __future__ import annotations

import mimetypes
import os
import sys
import time
from pathlib import Path

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "server"))

from lobbies import board  # noqa: E402
from relay import handle_match_ws  # noqa: E402

load_dotenv(ROOT / ".env.local")
load_dotenv(ROOT / ".env")

PORT = int(os.environ.get("PORT", "8080"))
HF_TOKEN = (os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip()
HF_SPACE_URL = (os.environ.get("HF_SPACE_URL") or "").rstrip("/")
SPACE_NAME = "RL-PVP"
_SPACE_PROBE_TTL = 15.0  # seconds

mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/gltf+json", ".gltf")
mimetypes.add_type("application/wasm", ".wasm")

app = FastAPI(title="Dust2 Explorer Local Host")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_username_cache: dict[str, str | None] = {"value": None, "avatarUrl": None, "error": None}
_space_probe: dict[str, float | str | None] = {"url": None, "checked_at": 0.0}


def _resolve_username() -> tuple[str | None, str | None]:
    if _username_cache["value"]:
        return _username_cache["value"], None
    if not HF_TOKEN:
        return None, "HF_TOKEN missing in .env.local"
    try:
        resp = httpx.get(
            "https://huggingface.co/api/whoami-v2",
            headers={"Authorization": f"Bearer {HF_TOKEN}"},
            timeout=15.0,
        )
        if resp.status_code != 200:
            err = f"HF whoami failed ({resp.status_code})"
            _username_cache["error"] = err
            return None, err
        data = resp.json()
        name = data.get("name") or data.get("fullname")
        if not name:
            return None, "HF whoami returned no username"
        avatar = data.get("avatarUrl") or data.get("avatar") or None
        if isinstance(avatar, str) and avatar.strip():
            _username_cache["avatarUrl"] = avatar.strip()
        else:
            _username_cache["avatarUrl"] = f"https://huggingface.co/avatars/{name}"
        _username_cache["value"] = str(name)
        _username_cache["error"] = None
        return _username_cache["value"], None
    except Exception as exc:
        err = f"HF whoami error: {exc}"
        _username_cache["error"] = err
        return None, err


def _avatar_url() -> str | None:
    _resolve_username()
    return _username_cache.get("avatarUrl")


def _space_ready() -> bool:
    """True when HF Space answers /api/health. Cached briefly."""
    if not HF_SPACE_URL:
        return False
    now = time.monotonic()
    if now - float(_space_probe["checked_at"] or 0) < _SPACE_PROBE_TTL:
        return bool(_space_probe["url"])
    ready = False
    try:
        resp = httpx.get(f"{HF_SPACE_URL}/api/health", timeout=3.0)
        ready = resp.status_code == 200 and bool(resp.json().get("ok"))
    except Exception:
        ready = False
    _space_probe["checked_at"] = now
    _space_probe["url"] = HF_SPACE_URL if ready else None
    return ready


def _game_server_url() -> str:
    """HF Space when it's up; otherwise same-origin (local lobbies). No flags."""
    if _space_ready():
        return HF_SPACE_URL
    return ""


class ClaimBody(BaseModel):
    username: str = Field(..., min_length=1)
    seat: str = Field(..., min_length=1)


class LeaveBody(BaseModel):
    username: str = Field(..., min_length=1)


class HeartbeatBody(BaseModel):
    username: str = Field(..., min_length=1)


@app.get("/api/me")
async def api_me():
    username, err = _resolve_username()
    if not username:
        return JSONResponse(
            {"ok": False, "username": None, "avatarUrl": None, "error": err or "unauthorized"},
            status_code=401,
        )
    return {"ok": True, "username": username, "avatarUrl": _avatar_url()}


@app.get("/api/config")
async def api_config():
    username, err = _resolve_username()
    space = _game_server_url()
    return {
        "ok": True,
        "spaceUrl": space,
        "username": username,
        "avatarUrl": _avatar_url() if username else None,
        "authError": err,
        "hasToken": bool(HF_TOKEN),
        "hasSpaceUrl": True,
        "lobbyHost": "hf" if space else "local",
    }


@app.get("/api/health")
async def api_health():
    return {"ok": True, "host": "local"}


@app.get("/api/lobbies")
async def api_lobbies():
    return board.snapshot()


@app.post("/api/lobbies/{mode}/{lobby_id}/claim")
async def api_claim(mode: str, lobby_id: str, body: ClaimBody):
    result = board.claim(mode, lobby_id, body.username, body.seat)
    return JSONResponse(result, status_code=200 if result.get("ok") else 400)


@app.post("/api/lobbies/leave")
async def api_leave(body: LeaveBody):
    return board.leave(body.username)


@app.post("/api/lobbies/heartbeat")
async def api_heartbeat(body: HeartbeatBody):
    board.heartbeat(body.username)
    return {"ok": True}


@app.websocket("/ws/match/{mode}/{lobby_id}")
async def api_match_ws(ws: WebSocket, mode: str, lobby_id: str, user: str = ""):
    await handle_match_ws(ws, mode, lobby_id, user)


@app.get("/{path:path}")
async def static_files(path: str = ""):
    rel = path or "index.html"
    target = (ROOT / rel).resolve()
    if not str(target).startswith(str(ROOT)) or not target.is_file():
        if not path:
            target = ROOT / "index.html"
        else:
            raise HTTPException(404, "Not found")
    return FileResponse(target)


def main() -> None:
    print(f"Dust2 Explorer running at http://localhost:{PORT}")
    if HF_SPACE_URL:
        print(f"HF Space: {HF_SPACE_URL} (auto — used when healthy, else local lobbies)")
    else:
        print("Lobbies: local (set HF_SPACE_URL in .env.local for online Space)")
    if not HF_TOKEN:
        print("Note: HF_TOKEN not set in .env.local")
    print("Press Ctrl+C to stop")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")


if __name__ == "__main__":
    main()
