"""Fixed lobby board: sandbox, 1v1, 4v4. Seat claims are server-authoritative."""

from __future__ import annotations

import string
import time
from typing import Any, Optional

# Lobby IDs: 0A–0X, 1A–1H, 4A–4H (category is already in the mode UI)
_LETTERS = string.ascii_uppercase
SANDBOX_IDS = [f"0{ch}" for ch in _LETTERS[:10]]  # 0A … 0J
DUEL_IDS = [f"1{ch}" for ch in _LETTERS[:8]]  # 1A … 1H
SQUAD_IDS = [f"4{ch}" for ch in _LETTERS[:8]]  # 4A … 4H

SANDBOX_CAP = 1  # one seat per sandbox lobby
DUEL_CAP = 2
SQUAD_CAP = 8  # 4 + 4

# 4v4: start if full, or idle 60s with ≥1 per side
SQUAD_IDLE_START_SEC = 60.0
SEAT_STALE_SEC = 8.0
# Ghost matches: if nobody heartbeats, free the lobby (was locking seats forever).
STARTING_TIMEOUT_SEC = 40.0
LIVE_STALE_SEC = 40.0


def _now() -> float:
    return time.time()


def _empty_sandbox(lobby_id: str) -> dict[str, Any]:
    return {
        "id": lobby_id,
        "mode": "sandbox",
        "seats": {f"S-{i}": None for i in range(1, SANDBOX_CAP + 1)},
        "status": "open",  # open | starting | live
        "last_change": _now(),
        "match_id": None,
    }


def _empty_duel(lobby_id: str) -> dict[str, Any]:
    return {
        "id": lobby_id,
        "mode": "1v1",
        "seats": {"X-1": None, "Y-1": None},
        "status": "open",
        "last_change": _now(),
        "match_id": None,
    }


def _empty_squad(lobby_id: str) -> dict[str, Any]:
    seats: dict[str, Optional[str]] = {}
    for side in ("X", "Y"):
        for i in range(1, 5):
            seats[f"{side}-{i}"] = None
    return {
        "id": lobby_id,
        "mode": "4v4",
        "seats": seats,
        "status": "open",
        "last_change": _now(),
        "match_id": None,
    }


class LobbyBoard:
    def __init__(self) -> None:
        self.lobbies: dict[str, dict[str, Any]] = {}
        for lid in SANDBOX_IDS:
            self.lobbies[lid] = _empty_sandbox(lid)
        for lid in DUEL_IDS:
            self.lobbies[lid] = _empty_duel(lid)
        for lid in SQUAD_IDS:
            self.lobbies[lid] = _empty_squad(lid)
        # username -> (lobby_id, seat)
        self.by_user: dict[str, tuple[str, str]] = {}

    def snapshot(self) -> dict[str, Any]:
        self._tick_stale_and_start()
        return {
            "sandbox": [self._public(self.lobbies[lid]) for lid in SANDBOX_IDS],
            "duel": [self._public(self.lobbies[lid]) for lid in DUEL_IDS],
            "squad": [self._public(self.lobbies[lid]) for lid in SQUAD_IDS],
            "serverTime": _now(),
        }

    def _public(self, lobby: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": lobby["id"],
            "mode": lobby["mode"],
            "seats": dict(lobby["seats"]),
            "status": lobby["status"],
            "lastChange": lobby["last_change"],
            "matchId": lobby["match_id"],
            "filled": sum(1 for v in lobby["seats"].values() if v),
            "capacity": len(lobby["seats"]),
        }

    def _clear_user(self, username: str) -> None:
        prev = self.by_user.pop(username, None)
        if not prev:
            return
        lid, seat = prev
        lobby = self.lobbies.get(lid)
        if lobby and lobby["seats"].get(seat) == username:
            lobby["seats"][seat] = None
            lobby.get("_avatars", {}).pop(username, None)
            lobby.get("_hb", {}).pop(username, None)
            lobby["last_change"] = _now()
            # Empty live/starting lobby must reset — otherwise match_id lingers
            # and the next WS wait loop "starts" a ghost match with no players.
            if lobby["status"] in ("live", "starting") and not any(lobby["seats"].values()):
                self._reset_lobby(lobby)

    def _reset_lobby(self, lobby: dict[str, Any]) -> None:
        mode = lobby["mode"]
        lid = lobby["id"]
        if mode == "sandbox":
            self.lobbies[lid] = _empty_sandbox(lid)
        elif mode == "1v1":
            self.lobbies[lid] = _empty_duel(lid)
        else:
            self.lobbies[lid] = _empty_squad(lid)

    def leave(self, username: str) -> dict[str, Any]:
        self._clear_user(username)
        return {"ok": True}

    def claim(
        self,
        mode: str,
        lobby_id: str,
        username: str,
        seat: str,
        avatar_url: str | None = None,
    ) -> dict[str, Any]:
        username = (username or "").strip()
        if not username:
            return {"ok": False, "error": "username required"}
        lobby = self.lobbies.get(lobby_id)
        if not lobby or lobby["mode"] != mode:
            return {"ok": False, "error": "lobby not found"}
        if seat not in lobby["seats"]:
            return {"ok": False, "error": "invalid seat"}
        if lobby["status"] in ("live", "starting"):
            return {"ok": False, "error": "match already starting"}
        if lobby["seats"][seat] is not None:
            return {"ok": False, "error": "seat taken"}

        # Move from previous seat if any
        self._clear_user(username)
        lobby["seats"][seat] = username
        lobby["last_change"] = _now()
        lobby.setdefault("_hb", {})[username] = _now()
        avatars = lobby.setdefault("_avatars", {})
        if avatar_url and str(avatar_url).strip():
            avatars[username] = str(avatar_url).strip()
        elif username not in avatars:
            avatars[username] = f"https://huggingface.co/avatars/{username}"
        self.by_user[username] = (lobby_id, seat)
        started = self._maybe_start(lobby)
        return {
            "ok": True,
            "lobby": self._public(lobby),
            "seat": seat,
            "started": started,
            "matchId": lobby["match_id"],
        }

    def heartbeat(self, username: str) -> None:
        prev = self.by_user.get(username)
        if not prev:
            return
        lid, seat = prev
        lobby = self.lobbies.get(lid)
        if not lobby:
            return
        # Stash last seen on seat metadata via parallel dict
        lobby.setdefault("_hb", {})[username] = _now()

    def _tick_stale_and_start(self) -> None:
        now = _now()
        stale_users: list[str] = []
        for username, (lid, seat) in list(self.by_user.items()):
            lobby = self.lobbies.get(lid)
            if not lobby:
                stale_users.append(username)
                continue
            hb = lobby.get("_hb", {}).get(username, lobby["last_change"])
            status = lobby["status"]
            if status == "open" and now - hb > SEAT_STALE_SEC:
                stale_users.append(username)
            elif status == "live" and now - hb > LIVE_STALE_SEC:
                # Drop ghost "live" seats so the board doesn't stay unclickable forever.
                stale_users.append(username)
            elif status == "starting" and now - lobby["last_change"] > STARTING_TIMEOUT_SEC:
                stale_users.append(username)
        for u in stale_users:
            self._clear_user(u)

        for lobby in list(self.lobbies.values()):
            if lobby["status"] == "starting" and now - lobby["last_change"] > STARTING_TIMEOUT_SEC:
                self._reset_lobby(lobby)
            elif lobby["status"] == "live":
                seated = [u for u in lobby["seats"].values() if u]
                if seated and all(
                    now - lobby.get("_hb", {}).get(u, 0) > LIVE_STALE_SEC for u in seated
                ):
                    self._reset_lobby(lobby)
            elif lobby["status"] == "open":
                self._maybe_start(lobby)

    def _maybe_start(self, lobby: dict[str, Any]) -> bool:
        if lobby["status"] != "open":
            return False
        mode = lobby["mode"]
        seats = lobby["seats"]
        filled = [s for s, u in seats.items() if u]

        if mode == "sandbox":
            # Start as soon as anyone joins
            if filled:
                return self._mark_starting(lobby)
            return False

        if mode == "1v1":
            if seats.get("X-1") and seats.get("Y-1"):
                return self._mark_starting(lobby)
            return False

        # 4v4
        team_x = [s for s, u in seats.items() if u and s.startswith("X-")]
        team_y = [s for s, u in seats.items() if u and s.startswith("Y-")]
        if len(filled) >= SQUAD_CAP:
            return self._mark_starting(lobby)
        if team_x and team_y and (_now() - lobby["last_change"]) >= SQUAD_IDLE_START_SEC:
            return self._mark_starting(lobby)
        return False

    def _mark_starting(self, lobby: dict[str, Any]) -> bool:
        import uuid

        lobby["status"] = "starting"
        lobby["match_id"] = str(uuid.uuid4())
        lobby["last_change"] = _now()
        return True

    def mark_live(self, lobby_id: str) -> None:
        lobby = self.lobbies.get(lobby_id)
        if lobby and lobby["status"] == "starting":
            lobby["status"] = "live"

    def players_in(self, lobby_id: str) -> list[dict[str, str]]:
        lobby = self.lobbies.get(lobby_id)
        if not lobby:
            return []
        avatars = lobby.get("_avatars") or {}
        out = []
        for seat, user in lobby["seats"].items():
            if user:
                side = "ffa"
                if seat.startswith("X-"):
                    side = "X"
                elif seat.startswith("Y-"):
                    side = "Y"
                out.append(
                    {
                        "username": user,
                        "seat": seat,
                        "side": side,
                        "avatarUrl": avatars.get(user)
                        or f"https://huggingface.co/avatars/{user}",
                    }
                )
        return out

    def get(self, lobby_id: str) -> Optional[dict[str, Any]]:
        return self.lobbies.get(lobby_id)


board = LobbyBoard()
