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
        self.clients: dict[str, WebSocket] = {}  # seated players
        self.spectators: dict[str, WebSocket] = {}  # read-only viewers
        self.lock = asyncio.Lock()
        self.started = False

    async def add(self, username: str, ws: WebSocket, *, spectate: bool = False) -> None:
        async with self.lock:
            bucket = self.spectators if spectate else self.clients
            old = bucket.get(username)
            if old and old is not ws:
                try:
                    await old.close()
                except Exception:
                    pass
            bucket[username] = ws

    async def remove(self, username: str, ws: WebSocket, *, spectate: bool = False) -> None:
        async with self.lock:
            bucket = self.spectators if spectate else self.clients
            if bucket.get(username) is ws:
                del bucket[username]

    async def broadcast(self, msg: dict[str, Any], exclude: str | None = None) -> None:
        data = json.dumps(msg)
        dead_players: list[str] = []
        dead_specs: list[str] = []
        async with self.lock:
            players = list(self.clients.items())
            specs = list(self.spectators.items())
        for user, client in players + specs:
            if exclude and user == exclude:
                continue
            try:
                await client.send_text(data)
            except Exception:
                if user in self.clients:
                    dead_players.append(user)
                else:
                    dead_specs.append(user)
        for u in dead_players:
            board.leave(u)
            async with self.lock:
                self.clients.pop(u, None)
        async with self.lock:
            for u in dead_specs:
                self.spectators.pop(u, None)


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


async def handle_match_ws(
    ws: WebSocket,
    mode: str,
    lobby_id: str,
    username: str,
    role: str = "play",
) -> None:
    await ws.accept()
    username = (username or "").strip()
    spectate = (role or "play").lower() in ("spectate", "spec", "watch")
    if not username:
        await ws.send_text(json.dumps({"type": "error", "error": "username required"}))
        await ws.close()
        return

    # Spectators use a distinct key so they never collide with a seated player name
    if spectate:
        username = f"spec:{username}"

    lobby = board.get(lobby_id)
    if not lobby or lobby["mode"] != mode:
        await ws.send_text(json.dumps({"type": "error", "error": "lobby not found"}))
        await ws.close()
        return

    if not spectate:
        seat_info = board.by_user.get(username)
        if not seat_info or seat_info[0] != lobby_id:
            await ws.send_text(json.dumps({"type": "error", "error": "not seated in lobby"}))
            await ws.close()
            return
        board.heartbeat(username)

    # Wait until lobby is starting/live with a match_id
    for _ in range(180):
        lobby = board.get(lobby_id)
        if lobby and not spectate:
            # Keep seat alive while parked in the wait loop (HTTP HB can lag).
            board.heartbeat(username)
            board._maybe_start(lobby)
            lobby = board.get(lobby_id)
            # Seat was wiped (stale / leave) — stop waiting instead of crashing later.
            if not board.by_user.get(username) or board.by_user.get(username)[0] != lobby_id:
                await ws.send_text(json.dumps({"type": "error", "error": "seat lost — rejoin lobby"}))
                await ws.close()
                return
        if lobby and lobby.get("match_id") and lobby["status"] in ("starting", "live"):
            # Only proceed if this player is still seated (or spectating).
            if spectate or (board.by_user.get(username) and board.by_user[username][0] == lobby_id):
                break
        if spectate and lobby and lobby["status"] == "open" and not lobby.get("match_id"):
            await ws.send_text(
                json.dumps({"type": "waiting", "lobby": board._public(lobby), "spectating": True})
            )
            await asyncio.sleep(0.5)
            continue
        await asyncio.sleep(0.5)
        try:
            pub = board._public(lobby) if lobby else None
            await ws.send_text(
                json.dumps({"type": "waiting", "lobby": pub, "spectating": spectate})
            )
        except Exception:
            return
    else:
        await ws.send_text(json.dumps({"type": "error", "error": "match did not start"}))
        await ws.close()
        return

    lobby = board.get(lobby_id)
    if not lobby or not lobby.get("match_id"):
        await ws.send_text(json.dumps({"type": "error", "error": "lobby reset — rejoin"}))
        await ws.close()
        return

    seat = None
    if not spectate:
        seat_info = board.by_user.get(username)
        if not seat_info or seat_info[0] != lobby_id:
            await ws.send_text(json.dumps({"type": "error", "error": "not seated in lobby"}))
            await ws.close()
            return
        seat = seat_info[1]

    match_id = lobby["match_id"]
    room = await get_or_create_room(lobby_id, mode, match_id)
    await room.add(username, ws, spectate=spectate)

    players = board.players_in(lobby_id)
    start_payload = {
        "type": "match_start",
        "matchId": match_id,
        "mode": mode,
        "lobbyId": lobby_id,
        "username": username,
        "seat": seat,
        "players": players,
        "spectating": spectate,
    }
    await ws.send_text(json.dumps(start_payload))
    if not spectate:
        board.mark_live(lobby_id)
        await room.broadcast(
            {
                "type": "player_joined",
                "username": username,
                "seat": seat,
                "players": board.players_in(lobby_id),
            },
            exclude=username,
        )

    try:
        while True:
            raw = await ws.receive_text()
            if not spectate:
                board.heartbeat(username)
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            # Spectators are receive-only (except ping)
            if spectate:
                if msg.get("type") == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))
                continue
            msg["from"] = username
            if msg.get("type") == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
                continue
            await room.broadcast(msg, exclude=username)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await room.remove(username, ws, spectate=spectate)
        if not spectate:
            # HF WS often blips right at match_start. Instant leave was wiping BOTH
            # seats and bootstrapping players back to an empty lobby.
            await asyncio.sleep(3.0)
            still = board.by_user.get(username)
            reconnected = username in room.clients
            if still and still[0] == lobby_id and not reconnected:
                board.leave(username)
                await room.broadcast(
                    {
                        "type": "player_left",
                        "username": username,
                        "players": board.players_in(lobby_id),
                    }
                )
        async with rooms_lock:
            if room.lobby_id == lobby_id and not room.clients and not room.spectators:
                rooms.pop(f"{mode}:{lobby_id}", None)
