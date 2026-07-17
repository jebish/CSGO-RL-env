import * as THREE from 'three';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from './combat.js';

function makeGhostMesh(color = 0x3aa0ff) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT - PLAYER_RADIUS * 2, 4, 8),
    new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      metalness: 0.1,
      roughness: 0.7,
    }),
  );
  body.position.y = PLAYER_HEIGHT * 0.5;
  body.castShadow = true;
  g.add(body);

  const label = document.createElement('div');
  // nametag via CSS2D would need addon; use sprite text fallback — skip for now
  g.userData.body = body;
  return g;
}

export class GhostManager {
  constructor(scene) {
    this.scene = scene;
    this.ghosts = new Map(); // username -> { mesh, target, hp, weapon, side }
    this._tmp = new THREE.Vector3();
  }

  syncPlayers(players, selfName) {
    const keep = new Set();
    for (const p of players || []) {
      if (!p.username || p.username === selfName) continue;
      keep.add(p.username);
      if (!this.ghosts.has(p.username)) {
        const color = p.side === 'teamB' || p.side === 'B' ? 0xe85d4c : 0x3aa0ff;
        const mesh = makeGhostMesh(color);
        this.scene.add(mesh);
        this.ghosts.set(p.username, {
          mesh,
          target: new THREE.Vector3(),
          pos: new THREE.Vector3(),
          yaw: 0,
          hp: 100,
          weapon: 'machinegun',
          side: p.side || 'ffa',
          seat: p.seat || '',
        });
      } else {
        const g = this.ghosts.get(p.username);
        g.side = p.side || g.side;
        g.seat = p.seat || g.seat;
      }
    }
    for (const [name, g] of this.ghosts) {
      if (!keep.has(name)) {
        this.scene.remove(g.mesh);
        this.ghosts.delete(name);
      }
    }
  }

  applyState(username, msg) {
    const g = this.ghosts.get(username);
    if (!g || !msg.pos) return;
    g.target.set(msg.pos[0], msg.pos[1], msg.pos[2]);
    if (msg.rot) g.yaw = msg.rot[0] || 0;
    if (typeof msg.hp === 'number') g.hp = msg.hp;
    if (msg.weapon) g.weapon = msg.weapon;
    g.mesh.visible = msg.alive !== false;
  }

  remove(username) {
    const g = this.ghosts.get(username);
    if (!g) return;
    this.scene.remove(g.mesh);
    this.ghosts.delete(username);
  }

  clear() {
    for (const [, g] of this.ghosts) this.scene.remove(g.mesh);
    this.ghosts.clear();
  }

  update(delta) {
    const lp = 1 - Math.pow(0.001, delta);
    for (const g of this.ghosts.values()) {
      g.pos.lerp(g.target, Math.min(1, lp * 14));
      g.mesh.position.copy(g.pos);
      g.mesh.rotation.y = g.yaw;
    }
  }

  /** Closest ghost hit by ray; returns { username, zone, dist, feet } */
  raycast(origin, dir, maxDist = 80) {
    let best = null;
    for (const [username, g] of this.ghosts) {
      if (!g.mesh.visible) continue;
      const feet = g.pos;
      // inline capsule test (avoid circular import issues — duplicate thin check)
      const hit = capsuleRay(origin, dir, feet, maxDist);
      if (!hit) continue;
      if (!best || hit.dist < best.dist) {
        best = { username, zone: hit.zone, dist: hit.dist, feet: feet.clone() };
      }
    }
    return best;
  }

  forEach(fn) {
    for (const [username, g] of this.ghosts) fn(username, g);
  }
}

function capsuleRay(origin, dir, feet, maxDist) {
  const R = PLAYER_RADIUS;
  const H = PLAYER_HEIGHT;
  const ox = origin.x - feet.x;
  const oz = origin.z - feet.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  const b = 2 * (ox * dir.x + oz * dir.z);
  const c = ox * ox + oz * oz - R * R;
  let t0 = 0;
  let t1 = maxDist;
  if (a < 1e-8) {
    if (c > 0) return null;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    t0 = (-b - s) / (2 * a);
    t1 = (-b + s) / (2 * a);
    if (t1 < 0 || t0 > maxDist) return null;
    t0 = Math.max(0, t0);
  }
  for (let i = 0; i < 10; i += 1) {
    const t = t0 + ((t1 - t0) * i) / 9;
    const y = origin.y + dir.y * t;
    if (y >= feet.y && y <= feet.y + H) {
      const rel = (y - feet.y) / H;
      return { dist: t, zone: rel >= 0.78 ? 'head' : 'body' };
    }
  }
  return null;
}
