"""WebSocket match rooms — fan-out relay, no game simulation."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from lobbies import board


class MatchRoom:
    def __init__(self, lobby_id: str, mode: str, match_id: str) -> None:
        self.lobby_id = lobby_id
        self.mode = mode
        self.match_id = match_id
        self.clients: dict[str, WebSocket] = {}  # username -> ws
        self.lock = asyncio.Lock()
        self.started = False

    async def add(self, username: str, ws: WebSocket) -> None:
        async with self.lock:
            old = self.clients.get(username)
            if old and old is not ws:
                try:
                    await old.close()
                except Exception:
                    pass
            self.clients[username] = ws

    async def remove(self, username: str, ws: WebSocket) -> None:
        async with self.lock:
            if self.clients.get(username) is ws:
                del self.clients[username]

    async def broadcast(self, msg: dict[str, Any], exclude: str | None = None) -> None:
        data = json.dumps(msg)
        dead: list[str] = []
        async with self.lock:
            items = list(self.clients.items())
        for user, client in items:
            if exclude and user == exclude:
                continue
            try:
                await client.send_text(data)
            except Exception:
                dead.append(user)
        for user in dead:
            board.leave(user)
            async with self.lock:
                self.clients.pop(user, None)


rooms: dict[str, MatchRoom] = {}
rooms_lock = asyncio.Lock()


async def get_or_create_room(lobby_id: str, mode: str, match_id: str) -> MatchRoom:
    key = f"{mode}:{lobby_id}"
    async with rooms_lock:
        room = rooms.get(key)
        if room is None or room.match_id != match_id:
            room = MatchRoom(lobby_id, mode, match_id)
            rooms[key] = room
        return room


async def handle_match_ws(ws: WebSocket, mode: str, lobby_id: str, username: str) -> None:
    await ws.accept()
    username = (username or "").strip()
    if not username:
        await ws.send_text(json.dumps({"type": "error", "error": "username required"}))
        await ws.close()
        return

    lobby = board.get(lobby_id)
    if not lobby or lobby["mode"] != mode:
        await ws.send_text(json.dumps({"type": "error", "error": "lobby not found"}))
        await ws.close()
        return

    seat_info = board.by_user.get(username)
    if not seat_info or seat_info[0] != lobby_id:
        await ws.send_text(json.dumps({"type": "error", "error": "not seated in lobby"}))
        await ws.close()
        return

    board.heartbeat(username)

    # Wait until lobby is starting/live with a match_id (sandbox starts immediately;
    # 1v1 when both seats filled; 4v4 when full or 60s idle with both sides).
    for _ in range(180):
        lobby = board.get(lobby_id)
        if lobby:
            board._maybe_start(lobby)
            lobby = board.get(lobby_id)
        if lobby and lobby.get("match_id") and lobby["status"] in ("starting", "live"):
            break
        await asyncio.sleep(0.5)
        try:
            pub = board._public(lobby) if lobby else None
            await ws.send_text(json.dumps({"type": "waiting", "lobby": pub}))
        except Exception:
            return
    else:
        await ws.send_text(json.dumps({"type": "error", "error": "match did not start"}))
        await ws.close()
        return

    lobby = board.get(lobby_id)
    assert lobby and lobby["match_id"]
    match_id = lobby["match_id"]
    room = await get_or_create_room(lobby_id, mode, match_id)
    await room.add(username, ws)

    players = board.players_in(lobby_id)
    seat = board.by_user[username][1]
    start_payload = {
        "type": "match_start",
        "matchId": match_id,
        "mode": mode,
        "lobbyId": lobby_id,
        "username": username,
        "seat": seat,
        "players": players,
    }
    await ws.send_text(json.dumps(start_payload))
    board.mark_live(lobby_id)
    await room.broadcast(
        {"type": "player_joined", "username": username, "seat": seat, "players": board.players_in(lobby_id)},
        exclude=username,
    )

    try:
        while True:
            raw = await ws.receive_text()
            board.heartbeat(username)
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            msg["from"] = username
            # Heartbeat-only
            if msg.get("type") == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
                continue
            await room.broadcast(msg, exclude=username)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await room.remove(username, ws)
        board.leave(username)
        await room.broadcast(
            {
                "type": "player_left",
                "username": username,
                "players": board.players_in(lobby_id),
            }
        )
        async with rooms_lock:
            if room.lobby_id == lobby_id and not room.clients:
                rooms.pop(f"{mode}:{lobby_id}", None)
