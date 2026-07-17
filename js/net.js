import { GhostManager } from './ghosts.js';
import { LocalCombat, damageFor, grenadeDamageAt, DAMAGE, inFlameCone, meleeHit } from './combat.js';

const STATE_HZ = 20;
const STATE_INTERVAL = 1 / STATE_HZ;
const LOBBY_POLL_MS = 1000;
const HEARTBEAT_MS = 3000;

function wsUrl(spaceUrl, mode, lobbyId, username) {
  const base = (spaceUrl || window.location.origin).replace(/\/$/, '');
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `/ws/match/${encodeURIComponent(mode)}/${encodeURIComponent(lobbyId)}`;
  u.search = `user=${encodeURIComponent(username)}`;
  return u.toString();
}

export class NetClient {
  constructor({ scene, onStatus, onMatchStart, onMatchEnd, onLobbyUpdate }) {
    this.scene = scene;
    this.onStatus = onStatus || (() => {});
    this.onMatchStart = onMatchStart || (() => {});
    this.onMatchEnd = onMatchEnd || (() => {});
    this.onLobbyUpdate = onLobbyUpdate || (() => {});

    this.username = null;
    this.avatarUrl = null;
    this.spaceUrl = null;
    this.mode = null; // sandbox | 1v1 | 4v4
    this.lobbyId = null;
    this.seat = null;
    this.side = null;
    this.matchId = null;
    this.inMatch = false;
    this.ws = null;
    this.ghosts = new GhostManager(scene);
    this.combat = new LocalCombat();
    this.board = null;
    this._pollTimer = null;
    this._hbTimer = null;
    this._stateAcc = 0;
    this._flameAcc = 0;
    this._spawnIndex = 0;
    this.players = [];
    this.teamAlive = { teamA: true, teamB: true };

    this.combat.onDeath = (from) => {
      this.send({ type: 'state', pos: this._lastPos, rot: this._lastRot, hp: 0, alive: false, weapon: this._weapon });
      this._checkTeamWipe();
    };
  }

  async initLocal() {
    const cfg = await fetch('/api/config').then((r) => r.json());
    // Empty spaceUrl = same origin. Config auto-picks HF Space when healthy.
    this.spaceUrl = cfg.spaceUrl || '';
    this.username = cfg.username || null;
    this.avatarUrl = cfg.avatarUrl || (this.username
      ? `https://huggingface.co/avatars/${encodeURIComponent(this.username)}`
      : null);
    if (!cfg.hasToken || !this.username) {
      return { ok: false, error: cfg.authError || 'Set HF_TOKEN in .env.local' };
    }
    return {
      ok: true,
      username: this.username,
      avatarUrl: this.avatarUrl,
      spaceUrl: this.spaceUrl || window.location.origin,
    };
  }

  _lobbyBase() {
    return this.spaceUrl || '';
  }

  async _fetchLobbies() {
    const tryBase = async (base) => {
      const res = await fetch(`${base}/api/lobbies`);
      if (!res.ok) throw new Error(`Lobby server ${res.status}`);
      const board = await res.json();
      if (!board?.duel && !board?.sandbox) throw new Error('Bad lobby payload');
      return board;
    };
    try {
      return await tryBase(this._lobbyBase());
    } catch (err) {
      // Space dead mid-session → fall back to local without touching env
      if (this.spaceUrl) {
        this.spaceUrl = '';
        return await tryBase('');
      }
      throw err;
    }
  }

  startLobbyPoll(mode) {
    this.mode = mode;
    this.stopLobbyPoll();
    const tick = async () => {
      try {
        const board = await this._fetchLobbies();
        this.board = board;
        this.onLobbyUpdate(board, mode, null);
      } catch (err) {
        this.onStatus(`Lobby poll failed: ${err.message}`);
        this.onLobbyUpdate(null, mode, err.message || String(err));
      }
    };
    tick();
    this._pollTimer = setInterval(tick, LOBBY_POLL_MS);
    this._hbTimer = setInterval(() => {
      if (!this.username) return;
      const base = this._lobbyBase();
      fetch(`${base}/api/lobbies/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.username }),
      }).catch(() => {});
    }, HEARTBEAT_MS);
  }

  stopLobbyPoll() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._hbTimer) clearInterval(this._hbTimer);
    this._pollTimer = null;
    this._hbTimer = null;
  }

  async claim(mode, lobbyId, seat) {
    const base = this.spaceUrl || '';
    const res = await fetch(`${base}/api/lobbies/${encodeURIComponent(mode)}/${encodeURIComponent(lobbyId)}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, seat }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'claim failed');
    this.mode = mode;
    this.lobbyId = lobbyId;
    this.seat = seat;
    this.side = seatSide(seat);
    this.matchId = data.matchId || null;
    return data;
  }

  async leaveLobby() {
    this.disconnectMatch();
    if (!this.username) return;
    const base = this.spaceUrl || '';
    await fetch(`${base}/api/lobbies/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username }),
    }).catch(() => {});
    this.lobbyId = null;
    this.seat = null;
  }

  connectMatch() {
    if (!this.lobbyId || !this.mode) return;
    this.disconnectMatch(false);
    const url = wsUrl(this.spaceUrl, this.mode, this.lobbyId, this.username);
    this.onStatus('Connecting to match…');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.onStatus('Waiting for match start…');
      this.send({ type: 'ready', username: this.username });
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this._onMessage(msg);
    };

    ws.onclose = () => {
      if (this.ws === ws) {
        this.inMatch = false;
        this.onStatus('Match connection closed');
      }
    };

    ws.onerror = () => {
      this.onStatus('Match WebSocket error');
    };
  }

  disconnectMatch(clearGhosts = true) {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.ws = null;
    this.inMatch = false;
    this.matchId = null;
    if (clearGhosts) this.ghosts.clear();
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  _onMessage(msg) {
    const type = msg.type;
    if (type === 'waiting') {
      this.onStatus('In lobby — waiting for match start…');
      return;
    }
    if (type === 'error') {
      this.onStatus(msg.error || 'Server error');
      return;
    }
    if (type === 'match_start') {
      this.inMatch = true;
      this.matchId = msg.matchId;
      this.players = msg.players || [];
      this.seat = msg.seat || this.seat;
      this.side = seatSide(this.seat);
      this.ghosts.syncPlayers(this.players, this.username);
      this.combat.reset();
      this._spawnIndex = spawnIndexFor(this.seat, this.mode, this.players);
      this.onMatchStart({
        mode: msg.mode || this.mode,
        seat: this.seat,
        side: this.side,
        players: this.players,
        spawnIndex: this._spawnIndex,
      });
      this.onStatus(`Match live — ${this.mode}`);
      return;
    }
    if (type === 'player_joined' || type === 'player_left') {
      this.players = msg.players || this.players;
      this.ghosts.syncPlayers(this.players, this.username);
      return;
    }
    if (type === 'state' && msg.from) {
      this.ghosts.applyState(msg.from, msg);
      return;
    }
    if (type === 'hit' && msg.target === this.username) {
      this.combat.applyDamage(msg.damage || 0, msg.from);
      return;
    }
    if (type === 'fire' && msg.from && this.onRemoteFire) {
      this.onRemoteFire(msg);
      return;
    }
    if (type === 'flame' && msg.from && this.onRemoteFlame) {
      this.onRemoteFlame(msg);
      return;
    }
    if (type === 'grenade_throw' && msg.from && this.onRemoteGrenadeThrow) {
      this.onRemoteGrenadeThrow(msg);
      return;
    }
    if (type === 'grenade_explode' && msg.from && this.onRemoteGrenadeExplode) {
      this.onRemoteGrenadeExplode(msg);
      return;
    }
    if (type === 'melee' && msg.from && this.onRemoteMelee) {
      this.onRemoteMelee(msg);
      return;
    }
    if (type === 'match_end') {
      this.onMatchEnd(msg);
      this.onStatus(`Match over — ${msg.winner || 'draw'}`);
    }
  }

  /** Call each frame while in match */
  update(delta, player, weaponId) {
    if (!this.inMatch || !player) return;
    this.combat.update(performance.now() * 0.001);
    this.ghosts.update(delta);

    this._stateAcc += delta;
    if (this._stateAcc >= STATE_INTERVAL) {
      this._stateAcc = 0;
      const feet = player.position;
      this._lastPos = [feet.x, feet.y, feet.z];
      this._lastRot = [player.cameraYaw, player.cameraPitch];
      this._weapon = weaponId;
      this.send({
        type: 'state',
        pos: this._lastPos,
        rot: this._lastRot,
        hp: this.combat.hp,
        alive: this.combat.alive,
        weapon: weaponId,
        action: player.isMoving?.() ? 'move' : 'idle',
      });
    }
  }

  // ── Combat helpers used by WeaponSystem ───────────────────────────

  tryHitscan(weaponId, origin, dir) {
    if (!this.inMatch || !this.combat.alive) return null;
    const hit = this.ghosts.raycast(origin, dir, 80);
    if (!hit) {
      this.send({
        type: 'fire',
        weapon: weaponId,
        origin: [origin.x, origin.y, origin.z],
        dir: [dir.x, dir.y, dir.z],
      });
      return null;
    }
    const dmg = damageFor(weaponId, hit.zone);
    this.send({
      type: 'fire',
      weapon: weaponId,
      origin: [origin.x, origin.y, origin.z],
      dir: [dir.x, dir.y, dir.z],
      hitUser: hit.username,
      zone: hit.zone,
      damage: dmg,
    });
    this.send({
      type: 'hit',
      target: hit.username,
      zone: hit.zone,
      damage: dmg,
      weapon: weaponId,
    });
    return hit;
  }

  tryFlameTick(origin, forward, delta) {
    if (!this.inMatch || !this.combat.alive) return;
    this._flameAcc += delta;
    if (this._flameAcc < 0.1) return;
    this._flameAcc = 0;
    const hits = [];
    this.ghosts.forEach((username, g) => {
      if (!g.mesh.visible) return;
      if (inFlameCone(origin, forward, g.pos)) {
        const dmg = damageFor('flamethrower', 'body');
        hits.push({ user: username, damage: dmg });
        this.send({ type: 'hit', target: username, zone: 'body', damage: dmg, weapon: 'flamethrower' });
      }
    });
    this.send({
      type: 'flame',
      origin: [origin.x, origin.y, origin.z],
      dir: [forward.x, forward.y, forward.z],
      hitUsers: hits,
    });
  }

  notifyGrenadeThrow(origin, vel, fuse) {
    if (!this.inMatch) return;
    this.send({
      type: 'grenade_throw',
      origin: [origin.x, origin.y, origin.z],
      vel: [vel.x, vel.y, vel.z],
      fuse,
    });
  }

  resolveGrenadeExplosion(pos) {
    if (!this.inMatch || !this.combat.alive) return;
    const radius = DAMAGE.grenade.radius;
    this.send({
      type: 'grenade_explode',
      pos: [pos.x, pos.y, pos.z],
      radius,
    });
    // Damage ghosts
    this.ghosts.forEach((username, g) => {
      const d = g.pos.distanceTo(pos);
      const dmg = grenadeDamageAt(d);
      if (dmg > 0) {
        this.send({ type: 'hit', target: username, zone: 'body', damage: dmg, weapon: 'grenade' });
      }
    });
    // Self damage
    if (this._lastPos) {
      const dx = this._lastPos[0] - pos.x;
      const dy = this._lastPos[1] - pos.y;
      const dz = this._lastPos[2] - pos.z;
      const d = Math.hypot(dx, dy, dz);
      const selfDmg = grenadeDamageAt(d);
      if (selfDmg > 0) this.combat.applyDamage(selfDmg, this.username);
    }
  }

  tryMelee(origin, forward) {
    if (!this.inMatch || !this.combat.alive) return;
    let best = null;
    this.ghosts.forEach((username, g) => {
      if (!g.mesh.visible) return;
      const hit = meleeHit(origin, forward, g.pos);
      if (!hit) return;
      if (!best || hit.dist < best.dist) best = { username, zone: hit.zone, dist: hit.dist };
    });
    if (!best) {
      this.send({
        type: 'melee',
        origin: [origin.x, origin.y, origin.z],
        dir: [forward.x, forward.y, forward.z],
      });
      return;
    }
    const dmg = damageFor('melee', best.zone);
    this.send({
      type: 'melee',
      origin: [origin.x, origin.y, origin.z],
      dir: [forward.x, forward.y, forward.z],
      hitUser: best.username,
      zone: best.zone,
      damage: dmg,
    });
    this.send({ type: 'hit', target: best.username, zone: best.zone, damage: dmg, weapon: 'melee' });
  }

  _checkTeamWipe() {
    if (this.mode === 'sandbox') return;
    // Soft check: announce if we think our side is wiped — peers also track
    // Full authority is weak; send match_end when local sees all enemies dead via state
    let enemyAlive = false;
    let allyAlive = this.combat.alive;
    this.ghosts.forEach((_u, g) => {
      const enemy = isEnemy(this.side, g.side, this.mode);
      if (g.hp > 0 && g.mesh.visible) {
        if (enemy) enemyAlive = true;
        else allyAlive = true;
      }
    });
    if (!enemyAlive && this.mode === '1v1') {
      this.send({ type: 'match_end', winner: this.side, winnerUser: this.username });
      this.onMatchEnd({ winner: this.side, winnerUser: this.username });
    }
    if (this.mode === '4v4' && !enemyAlive) {
      this.send({ type: 'match_end', winner: this.side });
      this.onMatchEnd({ winner: this.side });
    }
  }
}

function seatSide(seat) {
  if (!seat) return 'ffa';
  if (seat === 'A' || seat === 'B') return seat;
  if (String(seat).startsWith('teamA')) return 'teamA';
  if (String(seat).startsWith('teamB')) return 'teamB';
  return 'ffa';
}

function isEnemy(mySide, theirSide, mode) {
  if (mode === 'sandbox') return true;
  if (mode === '1v1') return theirSide !== mySide;
  return theirSide !== mySide;
}

/** Deterministic spawn slot from seat. */
export function spawnIndexFor(seat, mode, players) {
  if (mode === '1v1') return seat === 'B' ? 1 : 0;
  if (mode === '4v4') {
    const m = String(seat).match(/team([AB])-(\d)/);
    if (!m) return 0;
    const side = m[1] === 'A' ? 0 : 4;
    return side + Number(m[2]);
  }
  // sandbox: index among players
  const names = (players || []).map((p) => p.username).sort();
  const idx = Math.max(0, names.indexOf(players?.find((p) => p.seat === seat)?.username));
  return idx % 8;
}

/** Map-relative spawn offsets (applied in main after base spawn). */
export const SPAWN_OFFSETS = [
  { x: 0, z: 0 },
  { x: 12, z: 12 },
  { x: -12, z: 12 },
  { x: 12, z: -12 },
  { x: -12, z: -12 },
  { x: 18, z: 0 },
  { x: -18, z: 0 },
  { x: 0, z: 18 },
];
