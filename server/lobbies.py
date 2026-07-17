"""Fixed lobby board: sandbox, 1v1, 4v4. Seat claims are server-authoritative."""

from __future__ import annotations

import time
from typing import Any, Optional

# Fixed lobby counts
SANDBOX_COUNT = 4
DUEL_COUNT = 8
SQUAD_COUNT = 4

SANDBOX_CAP = 8
DUEL_CAP = 2
SQUAD_CAP = 8  # 4 + 4

# 4v4: start if full, or idle 60s with ≥1 per side
SQUAD_IDLE_START_SEC = 60.0
SEAT_STALE_SEC = 8.0


def _now() -> float:
    return time.time()


def _empty_sandbox(lobby_id: str) -> dict[str, Any]:
    return {
        "id": lobby_id,
        "mode": "sandbox",
        "seats": {str(i): None for i in range(SANDBOX_CAP)},
        "status": "open",  # open | starting | live
        "last_change": _now(),
        "match_id": None,
    }


def _empty_duel(lobby_id: str) -> dict[str, Any]:
    return {
        "id": lobby_id,
        "mode": "1v1",
        "seats": {"A": None, "B": None},
        "status": "open",
        "last_change": _now(),
        "match_id": None,
    }


def _empty_squad(lobby_id: str) -> dict[str, Any]:
    seats: dict[str, Optional[str]] = {}
    for side in ("teamA", "teamB"):
        for i in range(4):
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
        for i in range(SANDBOX_COUNT):
            lid = f"sandbox-{i}"
            self.lobbies[lid] = _empty_sandbox(lid)
        for i in range(DUEL_COUNT):
            lid = f"1v1-{i}"
            self.lobbies[lid] = _empty_duel(lid)
        for i in range(SQUAD_COUNT):
            lid = f"4v4-{i}"
            self.lobbies[lid] = _empty_squad(lid)
        # username -> (lobby_id, seat)
        self.by_user: dict[str, tuple[str, str]] = {}

    def snapshot(self) -> dict[str, Any]:
        self._tick_stale_and_start()
        return {
            "sandbox": [self._public(self.lobbies[f"sandbox-{i}"]) for i in range(SANDBOX_COUNT)],
            "duel": [self._public(self.lobbies[f"1v1-{i}"]) for i in range(DUEL_COUNT)],
            "squad": [self._public(self.lobbies[f"4v4-{i}"]) for i in range(SQUAD_COUNT)],
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
            lobby["last_change"] = _now()
            if lobby["status"] == "live" and not any(lobby["seats"].values()):
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

    def claim(self, mode: str, lobby_id: str, username: str, seat: str) -> dict[str, Any]:
        username = (username or "").strip()
        if not username:
            return {"ok": False, "error": "username required"}
        lobby = self.lobbies.get(lobby_id)
        if not lobby or lobby["mode"] != mode:
            return {"ok": False, "error": "lobby not found"}
        if seat not in lobby["seats"]:
            return {"ok": False, "error": "invalid seat"}
        if lobby["status"] == "live":
            return {"ok": False, "error": "match already live"}
        if lobby["seats"][seat] is not None:
            return {"ok": False, "error": "seat taken"}

        # Move from previous seat if any
        self._clear_user(username)
        lobby["seats"][seat] = username
        lobby["last_change"] = _now()
        lobby.setdefault("_hb", {})[username] = _now()
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
            if now - hb > SEAT_STALE_SEC and lobby["status"] != "live":
                stale_users.append(username)
        for u in stale_users:
            self._clear_user(u)

        for lobby in self.lobbies.values():
            if lobby["status"] == "open":
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
            if seats.get("A") and seats.get("B"):
                return self._mark_starting(lobby)
            return False

        # 4v4
        team_a = [s for s, u in seats.items() if u and s.startswith("teamA")]
        team_b = [s for s, u in seats.items() if u and s.startswith("teamB")]
        if len(filled) >= SQUAD_CAP:
            return self._mark_starting(lobby)
        if team_a and team_b and (_now() - lobby["last_change"]) >= SQUAD_IDLE_START_SEC:
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
        out = []
        for seat, user in lobby["seats"].items():
            if user:
                side = "ffa"
                if seat in ("A", "B"):
                    side = seat
                elif seat.startswith("teamA"):
                    side = "teamA"
                elif seat.startswith("teamB"):
                    side = "teamB"
                out.append({"username": user, "seat": seat, "side": side})
        return out

    def get(self, lobby_id: str) -> Optional[dict[str, Any]]:
        return self.lobbies.get(lobby_id)


board = LobbyBoard()
