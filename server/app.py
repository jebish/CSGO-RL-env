"""Minimal HF Space entry — must boot with plain Gradio first.

Lobby API + WebSocket are mounted on the same ASGI app.
"""

from __future__ import annotations

import gradio as gr
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from lobbies import board
from relay import handle_match_ws

ws_app = FastAPI()
ws_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ClaimBody(BaseModel):
    username: str = Field(..., min_length=1)
    seat: str = Field(..., min_length=1)


class LeaveBody(BaseModel):
    username: str = Field(..., min_length=1)


class HeartbeatBody(BaseModel):
    username: str = Field(..., min_length=1)


@ws_app.get("/api/health")
def health():
    return {"ok": True}


@ws_app.get("/api/lobbies")
def get_lobbies():
    return board.snapshot()


@ws_app.post("/api/lobbies/{mode}/{lobby_id}/claim")
def claim_seat(mode: str, lobby_id: str, body: ClaimBody):
    result = board.claim(mode, lobby_id, body.username, body.seat)
    return JSONResponse(result, status_code=200 if result.get("ok") else 400)


@ws_app.post("/api/lobbies/leave")
def leave_lobby(body: LeaveBody):
    return board.leave(body.username)


@ws_app.post("/api/lobbies/heartbeat")
def heartbeat(body: HeartbeatBody):
    board.heartbeat(body.username)
    return {"ok": True}


@ws_app.websocket("/ws/match/{mode}/{lobby_id}")
async def match_ws(ws: WebSocket, mode: str, lobby_id: str, user: str = ""):
    await handle_match_ws(ws, mode, lobby_id, user)


def render_board(_=None):
    snap = board.snapshot()
    lines = ["### Dust2 lobbies (live)", ""]
    for title, key in (("Sandbox", "sandbox"), ("1v1", "duel"), ("4v4", "squad")):
        lines.append(f"**{title}**")
        for L in snap.get(key, []):
            seats = ", ".join(f"{k}:{v or '—'}" for k, v in (L.get("seats") or {}).items())
            lines.append(f"- {L['id']} | {L['filled']}/{L['capacity']} | {L['status']} | {seats}")
        lines.append("")
    return "\n".join(lines)


with gr.Blocks(title="RL-PVP") as demo:
    gr.Markdown("# RL-PVP")
    out = gr.Markdown(render_board())
    btn = gr.Button("Refresh lobbies")
    btn.click(render_board, outputs=out)
    # auto refresh
    demo.load(render_board, outputs=out)
    try:
        t = gr.Timer(1.0)
        t.tick(render_board, outputs=out)
    except Exception:
        pass

demo.queue()
app = gr.mount_gradio_app(ws_app, demo, path="/")
