/** Shared combat rules for online matches (attacker-authoritative). */

export const MAX_HP = 100;
export const RESPAWN_SEC = 3.5;

export const DAMAGE = {
  machinegun: { body: 12, head: 28 },
  sniper: { body: 55, head: 100 },
  melee: { body: 35, head: 50 },
  flamethrower: { body: 6, head: 8 }, // per tick
  grenade: { max: 80, radius: 4.0 },
};

export const MELEE_RANGE = 1.85;
export const FLAME_RANGE = 5.2;
export const FLAME_HALF_ANGLE = (18 * Math.PI) / 180;
export const PLAYER_RADIUS = 0.38;
export const PLAYER_HEIGHT = 1.75;
export const HEAD_FRAC = 0.22;

export function zoneFromHitY(hitY, feetY) {
  const rel = (hitY - feetY) / PLAYER_HEIGHT;
  return rel >= 1 - HEAD_FRAC ? 'head' : 'body';
}

export function damageFor(weaponId, zone) {
  const table = DAMAGE[weaponId];
  if (!table) return 0;
  if (weaponId === 'grenade') return 0;
  return zone === 'head' ? table.head : table.body;
}

export function grenadeDamageAt(distance) {
  const { max, radius } = DAMAGE.grenade;
  if (distance >= radius) return 0;
  const t = 1 - distance / radius;
  return Math.round(max * t * t);
}

/**
 * Ray vs vertical capsule (feet at pos, height PLAYER_HEIGHT, radius PLAYER_RADIUS).
 * Returns { hit, point, zone, dist } or null.
 */
export function raycastCapsule(origin, dir, feet, maxDist = 80) {
  // Expand to cylinder + hemispheres approximated as thicker cylinder
  const ox = origin.x - feet.x;
  const oz = origin.z - feet.z;
  const dx = dir.x;
  const dz = dir.z;
  const a = dx * dx + dz * dz;
  const b = 2 * (ox * dx + oz * dz);
  const c = ox * ox + oz * oz - PLAYER_RADIUS * PLAYER_RADIUS;
  let tEnter = 0;
  let tExit = maxDist;

  if (a < 1e-8) {
    if (c > 0) return null;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    tEnter = (-b - s) / (2 * a);
    tExit = (-b + s) / (2 * a);
    if (tExit < 0 || tEnter > maxDist) return null;
    tEnter = Math.max(0, tEnter);
  }

  // Sample along segment for Y in capsule
  for (let i = 0; i < 12; i += 1) {
    const t = tEnter + ((tExit - tEnter) * i) / 11;
    if (t < 0 || t > maxDist) continue;
    const y = origin.y + dir.y * t;
    const minY = feet.y;
    const maxY = feet.y + PLAYER_HEIGHT;
    if (y >= minY && y <= maxY) {
      return {
        hit: true,
        dist: t,
        point: {
          x: origin.x + dir.x * t,
          y,
          z: origin.z + dir.z * t,
        },
        zone: zoneFromHitY(y, feet.y),
      };
    }
  }
  return null;
}

export function inFlameCone(origin, forward, targetFeet) {
  const tx = targetFeet.x - origin.x;
  const ty = (targetFeet.y + PLAYER_HEIGHT * 0.5) - origin.y;
  const tz = targetFeet.z - origin.z;
  const dist = Math.hypot(tx, ty, tz);
  if (dist < 0.2 || dist > FLAME_RANGE) return false;
  const inv = 1 / dist;
  const dot = (tx * inv) * forward.x + (ty * inv) * forward.y + (tz * inv) * forward.z;
  return dot >= Math.cos(FLAME_HALF_ANGLE);
}

export function meleeHit(origin, forward, targetFeet) {
  const tx = targetFeet.x - origin.x;
  const ty = (targetFeet.y + PLAYER_HEIGHT * 0.45) - origin.y;
  const tz = targetFeet.z - origin.z;
  const dist = Math.hypot(tx, ty, tz);
  if (dist > MELEE_RANGE) return null;
  const inv = 1 / Math.max(dist, 1e-4);
  const dot = (tx * inv) * forward.x + (tz * inv) * forward.z;
  if (dot < 0.35) return null;
  return {
    zone: zoneFromHitY(targetFeet.y + PLAYER_HEIGHT * 0.45, targetFeet.y),
    dist,
  };
}

export class LocalCombat {
  constructor() {
    this.hp = MAX_HP;
    this.alive = true;
    this.respawnAt = 0;
    this.onDeath = null;
    this.onRespawn = null;
    this.onHpChange = null;
  }

  reset() {
    this.hp = MAX_HP;
    this.alive = true;
    this.respawnAt = 0;
    this._emitHp();
  }

  applyDamage(amount, fromUser = null) {
    if (!this.alive || amount <= 0) return false;
    this.hp = Math.max(0, this.hp - amount);
    this._emitHp();
    if (this.hp <= 0) {
      this.alive = false;
      this.respawnAt = performance.now() * 0.001 + RESPAWN_SEC;
      if (this.onDeath) this.onDeath(fromUser);
      return true;
    }
    return false;
  }

  update(nowSec) {
    if (!this.alive && nowSec >= this.respawnAt) {
      this.hp = MAX_HP;
      this.alive = true;
      this._emitHp();
      if (this.onRespawn) this.onRespawn();
    }
  }

  _emitHp() {
    if (this.onHpChange) this.onHpChange(this.hp, this.alive);
  }
}
