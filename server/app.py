"""HF Space: FastAPI lobbies/WS + full Dust2 game client (www/)."""

from __future__ import annotations

import mimetypes
import os
import re
import secrets
from pathlib import Path
from typing import Optional

import uvicorn
import httpx
from fastapi import Cookie, FastAPI, Header, Request, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from lobbies import board
from relay import handle_match_ws

WWW = Path(__file__).resolve().parent / "www"
_GUEST_RE = re.compile(r"^[A-Za-z0-9_-]{2,32}$")

mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/gltf+json", ".gltf")


class ClaimBody(BaseModel):
    username: str = Field(..., min_length=1)
    seat: str = Field(..., min_length=1)
    avatarUrl: Optional[str] = None


class LeaveBody(BaseModel):
    username: str = Field(..., min_length=1)


class HeartbeatBody(BaseModel):
    username: str = Field(..., min_length=1)


BOARD_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>RL-PVP · Lobby board</title>
  <style>
    :root {
      --bg0: #0c0a08;
      --line: #3a322a;
      --text: #ece6df;
      --muted: #9a9086;
      --accent: #d8d0c6;
      --live: #5dce8a;
      --open: #c4b5a0;
      --team-x: #c44b3c;
      --team-x-bg: #3a1814;
      --team-y: #3b7ec4;
      --team-y-bg: #142433;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", "Helvetica Neue", sans-serif;
      color: var(--text);
      background:
        radial-gradient(ellipse at 50% 0%, rgba(70, 50, 30, 0.35), transparent 55%),
        linear-gradient(180deg, #1a1510 0%, var(--bg0) 100%);
    }
    .wrap { max-width: 920px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 {
      margin: 0;
      font-size: clamp(1.8rem, 4vw, 2.6rem);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      font-weight: 800;
    }
    .lead { color: var(--muted); margin: 0.6rem 0 1.25rem; max-width: 42rem; line-height: 1.45; }
    .banner {
      border: 1px solid var(--line);
      background: rgba(12, 10, 8, 0.85);
      padding: 0.9rem 1rem;
      margin-bottom: 1.25rem;
      line-height: 1.45;
    }
    .banner strong { color: #fff; }
    .nav { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .tab, .play {
      border: 2px solid #5a5048;
      background: transparent;
      color: var(--text);
      padding: 0.45rem 0.9rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      cursor: pointer;
      font-size: 0.85rem;
      text-decoration: none;
      display: inline-block;
    }
    .tab.active { border-color: var(--accent); background: #1a1510; }
    .play { border-color: #5dce8a; color: #b8f0d0; }
    .list { display: flex; flex-direction: column; gap: 0.65rem; }
    .card {
      border: 1px solid var(--line);
      background: #100e0c;
      padding: 0.75rem 0.85rem;
    }
    .head { display: flex; justify-content: space-between; gap: 0.75rem; align-items: baseline; margin-bottom: 0.55rem; }
    .id { font-weight: 700; letter-spacing: 0.04em; }
    .meta { color: var(--muted); font-size: 0.85rem; }
    .meta .live { color: var(--live); }
    .meta .open { color: var(--open); }
    .seats-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
    }
    .team { display: flex; flex-wrap: wrap; gap: 0.35rem; max-width: 46%; }
    .team.x { justify-content: flex-start; }
    .team.y { justify-content: flex-end; }
    .seat {
      min-width: 2rem;
      text-align: center;
      border: 1px solid #5a5048;
      background: #1a1510;
      color: #ece6df;
      font-size: 0.78rem;
      font-weight: 700;
      padding: 0.35rem 0.5rem;
    }
    .seat.team-x { border-color: var(--team-x); background: var(--team-x-bg); color: #ffd4ce; }
    .seat.team-y { border-color: var(--team-y); background: var(--team-y-bg); color: #cfe4ff; }
    .seat .who { display: block; font-size: 0.62rem; font-weight: 500; opacity: 0.85; }
    .seats-flat { display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .hint { margin-top: 0.55rem; font-size: 0.78rem; color: var(--muted); }
    .actions { margin-top: 0.65rem; display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
    a.spec-btn {
      display: inline-block;
      text-decoration: none;
      border: 1px solid #5dce8a;
      background: #142018;
      color: #b8f0d0;
      font-size: 0.8rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 0.4rem 0.75rem;
    }
    .err { color: #ff8e8e; }
    footer { margin-top: 1.5rem; color: var(--muted); font-size: 0.8rem; }
    code { color: #d2b48c; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Dust2 · RL-PVP</h1>
    <p class="lead">Public lobby board + spectate. Playing requires the local client with HF login (for identity / analytics).</p>
    <div class="banner">
      <strong>Spectate (no HF account):</strong> click <em>Spectate</em> on a live lobby.
      <br/>In spectate: <strong>← →</strong> switch player · <strong>Esc</strong> back. No movement, no weapons, no play.
      <br/><strong>Play:</strong> local Dust2 only (<code>bash start.sh</code> + <code>HF_TOKEN</code>).
      <br/>Red = side X · Blue = side Y (labels are seat numbers only).
    </div>
    <div class="nav">
      <button type="button" class="tab active" data-mode="sandbox">Sandbox</button>
      <button type="button" class="tab" data-mode="1v1">1v1</button>
      <button type="button" class="tab" data-mode="4v4">4v4</button>
    </div>
    <div id="list" class="list">Loading lobbies…</div>
    <footer>Auto-refreshes every 2s · <code>/api/lobbies</code></footer>
  </div>
  <script>
    const KEY = { sandbox: 'sandbox', '1v1': 'duel', '4v4': 'squad' };
    let mode = 'sandbox';
    const list = document.getElementById('list');
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        mode = btn.dataset.mode;
        document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
        render(window.__board);
      });
    });
    function parseSeat(key) {
      const m = String(key).match(/^([XYS])-(\\d+)$/i);
      if (!m) return { team: null, n: key, cls: '' };
      const t = m[1].toUpperCase();
      return {
        team: t === 'S' ? null : t,
        n: m[2],
        cls: t === 'X' ? 'team-x' : t === 'Y' ? 'team-y' : '',
      };
    }
    function seatChip(key, user) {
      const p = parseSeat(key);
      const label = p.team ? p.n : key.replace(/^S-/, '');
      const who = user ? `<span class="who">${user}</span>` : '';
      return `<span class="seat ${p.cls}${user ? ' filled' : ''}">${label}${who}</span>`;
    }
    function seatsHtml(seats) {
      const entries = Object.entries(seats || {});
      const xs = entries.filter(([k]) => /^X-/i.test(k));
      const ys = entries.filter(([k]) => /^Y-/i.test(k));
      if (xs.length || ys.length) {
        return `<div class="seats-row">
          <div class="team x">${xs.map(([k, v]) => seatChip(k, v)).join('')}</div>
          <div class="team y">${ys.map(([k, v]) => seatChip(k, v)).join('')}</div>
        </div>`;
      }
      return `<div class="seats-flat">${entries.map(([k, v]) => seatChip(k, v)).join('')}</div>`;
    }
    function render(board) {
      if (!board) return;
      const lobbies = board[KEY[mode]] || [];
      if (!lobbies.length) {
        list.innerHTML = '<div class="card err">No lobbies in this mode.</div>';
        return;
      }
      list.innerHTML = lobbies.map((L) => {
        const st = L.status === 'live' || L.status === 'starting'
          ? `<span class="live">${L.status}</span>`
          : `<span class="open">${L.status}</span>`;
        const live = L.status === 'live' || L.status === 'starting';
        const href = `/?spectate=1&mode=${encodeURIComponent(mode)}&lobby=${encodeURIComponent(L.id)}`;
        const spec = live
          ? `<div class="actions">
               <a class="spec-btn" href="${href}">Spectate</a>
               <div class="hint">Read-only viewer — no HF login required.</div>
             </div>`
          : `<div class="hint">Open — players join from the local client (HF login).</div>`;
        return `<div class="card">
          <div class="head">
            <span class="id">${L.id}</span>
            <span class="meta">${L.filled}/${L.capacity} · ${st}</span>
          </div>
          ${seatsHtml(L.seats)}
          ${spec}
        </div>`;
      }).join('');
    }
    async function tick() {
      try {
        const r = await fetch('/api/lobbies');
        if (!r.ok) throw new Error(r.status);
        window.__board = await r.json();
        render(window.__board);
      } catch (e) {
        list.innerHTML = `<div class="card err">Lobby API unreachable (${e.message || e})</div>`;
      }
    }
    tick();
    setInterval(tick, 2000);
  </script>
</body>
</html>
"""


def _ensure_guest(response: Response, dust2_user: str | None) -> str:
    name = (dust2_user or "").strip()
    if not name or not _GUEST_RE.fullmatch(name):
        name = f"guest-{secrets.token_hex(3)}"
        response.set_cookie(
            key="dust2_user",
            value=name,
            max_age=60 * 60 * 24 * 30,
            httponly=False,
            samesite="lax",
        )
    return name


def _hf_username_from_auth(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    token = parts[1].strip()
    if not token:
        return None
    try:
        resp = httpx.get(
            "https://huggingface.co/api/whoami-v2",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15.0,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        name = data.get("name") or data.get("fullname")
        return str(name) if name else None
    except Exception:
        return None


def create_app() -> FastAPI:
    api = FastAPI()
    api.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @api.get("/api/health")
    def health():
        return {"ok": True, "host": "space", "hasClient": WWW.is_dir(), "playAllowed": False}

    @api.get("/api/config")
    def config(response: Response, dust2_user: str | None = Cookie(default=None)):
        # Guest id is for spectate only — Space never allows play.
        username = _ensure_guest(response, dust2_user)
        return {
            "ok": True,
            "spaceUrl": "",
            "username": username,
            "avatarUrl": None,
            "authError": None,
            "hasToken": False,
            "hasSpaceUrl": False,
            "lobbyHost": "space",
            "host": "space",
            "playAllowed": False,
        }

    @api.get("/api/lobbies")
    def get_lobbies():
        return board.snapshot()

    @api.post("/api/lobbies/{mode}/{lobby_id}/claim")
    def claim_seat(
        mode: str,
        lobby_id: str,
        body: ClaimBody,
        authorization: str | None = Header(default=None),
    ):
        # Play only via local client proxy with a real HF token (analytics identity).
        hf_user = _hf_username_from_auth(authorization)
        if not hf_user:
            return JSONResponse(
                {
                    "ok": False,
                    "error": "Play disabled on Space. Use local Dust2 with HF_TOKEN.",
                },
                status_code=403,
            )
        result = board.claim(
            mode, lobby_id, hf_user, body.seat, avatar_url=body.avatarUrl
        )
        return JSONResponse(result, status_code=200 if result.get("ok") else 400)

    @api.post("/api/lobbies/leave")
    def leave_lobby(body: LeaveBody, authorization: str | None = Header(default=None)):
        hf_user = _hf_username_from_auth(authorization)
        # Allow leave for HF-auth players; ignore anonymous spoof leave of others
        if hf_user:
            return board.leave(hf_user)
        if body.username and not str(body.username).startswith("guest-"):
            # Unauthenticated leave of a real seat — reject
            return JSONResponse({"ok": False, "error": "HF auth required"}, status_code=403)
        return {"ok": True}

    @api.post("/api/lobbies/heartbeat")
    def heartbeat(body: HeartbeatBody, authorization: str | None = Header(default=None)):
        hf_user = _hf_username_from_auth(authorization)
        if hf_user:
            board.heartbeat(hf_user)
        elif body.username and not str(body.username).startswith("guest-"):
            return JSONResponse({"ok": False, "error": "HF auth required"}, status_code=403)
        return {"ok": True}

    @api.websocket("/ws/match/{mode}/{lobby_id}")
    async def match_ws(
        ws: WebSocket,
        mode: str,
        lobby_id: str,
        user: str = "",
        role: str = "play",
    ):
        spectate = (role or "").lower() in ("spectate", "spec", "watch")
        # Browser on Space: spectate only. Play sockets are for seated HF players
        # (local client claims with HF_TOKEN, then connects play WS).
        if not spectate:
            # Allow play only if this user already holds a seat (HF-authenticated claim).
            seated = board.by_user.get((user or "").strip())
            if not seated or seated[0] != lobby_id:
                await ws.accept()
                await ws.send_text(
                    '{"type":"error","error":"Spectate only in browser. Play via local Dust2 + HF_TOKEN."}'
                )
                await ws.close()
                return
        await handle_match_ws(ws, mode, lobby_id, user, role=role)

    @api.get("/board", response_class=HTMLResponse)
    def lobby_board():
        return BOARD_HTML

    @api.get("/")
    def game_index(request: Request):
        # Game client on Space is spectate-entry only.
        q = request.query_params
        if q.get("spectate") == "1" and q.get("lobby"):
            index = WWW / "index.html"
            if not index.is_file():
                return HTMLResponse(
                    "<h1>Game client missing</h1><p>Rebuild Space with www/.</p>",
                    status_code=503,
                )
            return FileResponse(index)
        return RedirectResponse(url="/board", status_code=302)

    if WWW.is_dir():
        for mount, folder in (("assets", "assets"), ("js", "js"), ("css", "css")):
            path = WWW / folder
            if path.is_dir():
                api.mount(f"/{mount}", StaticFiles(directory=str(path)), name=mount)

    return api


app = create_app()


def main() -> None:
    port = int(os.environ.get("PORT") or "7860")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()
