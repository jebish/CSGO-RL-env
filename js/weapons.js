import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WeaponAudio } from './weapon-audio.js?v=13';
import { ImpactSystem } from './impacts.js?v=5';
import { SMOKE_RADIUS } from './combat.js?v=3';

const WEAPON_IDS = ['machinegun', 'shotgun', 'sniper', 'flamethrower', 'grenade', 'smoke', 'melee'];
const WEAPON_LABELS = {
  machinegun: 'PU-21',
  shotgun: 'Combat Shotgun',
  sniper: 'Bolt Rifle',
  flamethrower: 'Flamethrower',
  grenade: 'Stick Grenade',
  smoke: 'Smoke Canister',
  melee: 'Pipe Wrench',
};

const HAND_POS = new THREE.Vector3(0.28, 0.72, 0.22);
const FLAME_RANGE = 5.2;
const FLAME_HALF_ANGLE = THREE.MathUtils.degToRad(18);
const FLAME_PARTICLES = 220;

const MACHINEGUN_FIRE_INTERVAL = 1 / 8;
/** Base sniper 2s; +10% RoF → shorter interval. */
const SNIPER_FIRE_INTERVAL = 2 / 1.1;
/** Base shotgun was sniper/2 (=1s); +25% RoF. */
const SHOTGUN_FIRE_INTERVAL = 1 / 1.25;
const GRENADE_THROW_INTERVAL = 2;
const GRENADE_FUSE = 2.5;
const GRENADE_THROW_SPEED = 14;
const GRENADE_GRAVITY = 18;

const MACHINEGUN_RECOIL_MOVING_DEG = 6;
/** Scoped MG: FOV-true shots, but harder kick for balance. */
const MACHINEGUN_RECOIL_SCOPED_DEG = 8.5;
const MACHINEGUN_RECOIL_STILL_DEG = 3;
/** Scoped sniper: perfect when still; ≤2° cone while moving. */
const SNIPER_SCOPED_STILL_DEG = 0;
const SNIPER_SCOPED_MOVING_DEG = 2;
const SHOTGUN_PELLETS_MIN = 8;
const SHOTGUN_PELLETS_MAX = 12;
const SHOTGUN_SPREAD_DEG = 11;
const SHOTGUN_RECOIL_MOVING_DEG = 10;
const SHOTGUN_RECOIL_STILL_DEG = 7;
/** Hip FOV / scope FOV ≈ zoom. Sniper zoom = 2.5× machinegun zoom. */
const MACHINEGUN_SCOPE_FOV = 48;
const SNIPER_SCOPE_FOV = MACHINEGUN_SCOPE_FOV / 2.5;
const FLAME_USE_PER_SEC = 30;
/** Smoke: expand 1s → hold 8s → shrink 1s. */
const SMOKE_EXPAND_SEC = 1;
const SMOKE_HOLD_SEC = 8;
const SMOKE_SHRINK_SEC = 1;
const SMOKE_TOTAL_SEC = SMOKE_EXPAND_SEC + SMOKE_HOLD_SEC + SMOKE_SHRINK_SEC;
/** View-left shoulder origin (screen-left), fire toward crosshair aim point. */
const FIRE_SHOULDER_Y = 1.18;
const FIRE_SHOULDER_FORWARD = 0.28;
const FIRE_VIEW_LEFT = 0.28;
const FIRE_AIM_POINT_DIST = 80;
const TRACER_LENGTH = 16;

const AMMO_CONFIG = {
  machinegun: { magSize: 80, reserve: 1000, reloadTime: 2 },
  shotgun: { magSize: 8, reserve: 40, reloadTime: 2.8 },
  sniper: { magSize: 5, reserve: 40, reloadTime: 2.5 },
  flamethrower: { magSize: 200, reserve: 2500, reloadTime: 4 },
  grenade: { magSize: 3, reserve: 12, reloadTime: 1.5 },
  smoke: { magSize: 2, reserve: 8, reloadTime: 1.5 },
  melee: { infinite: true },
};

/** Per-weapon capability flags. */
const WEAPON_FLAGS = {
  machinegun: { canScope: true, requireScopeToFire: false },
  shotgun: { canScope: false, requireScopeToFire: false },
  sniper: { canScope: true, requireScopeToFire: true },
  flamethrower: { canScope: false, requireScopeToFire: false },
  grenade: { canScope: false, requireScopeToFire: false },
  smoke: { canScope: false, requireScopeToFire: false },
  melee: { canScope: false, requireScopeToFire: false },
};

function createShotgunProp() {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, metalness: 0.55, roughness: 0.4 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x5a3a22, metalness: 0.1, roughness: 0.7 });
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.72, 10), dark);
  barrel.rotation.z = Math.PI / 2;
  barrel.position.set(0.2, 0.04, 0);
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.06), dark);
  receiver.position.set(0.02, 0.03, 0);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.07, 0.05), wood);
  stock.position.set(-0.2, 0.0, 0);
  stock.rotation.z = 0.15;
  const pump = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.05), wood);
  pump.position.set(0.12, -0.02, 0);
  g.add(barrel, receiver, stock, pump);
  return g;
}

function createSmokeCanisterProp() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.038, 0.16, 12),
    new THREE.MeshStandardMaterial({ color: 0x6a7a88, metalness: 0.4, roughness: 0.45 }),
  );
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 0.03, 10),
    new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.6, roughness: 0.35 }),
  );
  cap.position.y = 0.095;
  const pin = new THREE.Mesh(
    new THREE.TorusGeometry(0.02, 0.004, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.3 }),
  );
  pin.position.set(0.02, 0.11, 0);
  pin.rotation.y = Math.PI / 2;
  g.add(body, cap, pin);
  return g;
}

const INFINITY = '∞';

/** Attachment / alt-part name fragments to strip from the PU-21 kit. */
const MACHINEGUN_DROP_NAME_PARTS = [
  'barrel_alt',
  'grip_main_quick',
  'grip_main_sprint',
  'mag_drum',
  'mag_extended',
  'stock_alt',
  'stock_flinch',
  'bar_mix',
  'mag_ext',
  'stock_mix',
  'stock_flinch',
  'pgrip_quick',
  'pgrip_sprint',
];

function fitWeaponModel(model, targetLength) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z, 0.001);
  model.scale.setScalar(targetLength / longest);
  box.setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);
  model.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

function stripMachinegunAttachments(root) {
  root.traverse((child) => {
    const name = (child.name || '').toLowerCase();
    const meshName = (child.isMesh && child.geometry ? (child.name || '') : child.name || '').toLowerCase();
    // Also check material names when present
    let matName = '';
    if (child.isMesh && child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      matName = mats.map((m) => (m && m.name) || '').join(' ').toLowerCase();
    }
    const hay = `${name} ${meshName} ${matName}`;
    if (MACHINEGUN_DROP_NAME_PARTS.some((p) => hay.includes(p))) {
      child.visible = false;
    }
  });
}

function createFlameTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255, 250, 210, 1)');
  grad.addColorStop(0.35, 'rgba(255, 160, 40, 0.85)');
  grad.addColorStop(0.7, 'rgba(220, 50, 10, 0.35)');
  grad.addColorStop(1, 'rgba(40, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class FlameCone {
  constructor(scene, { remote = false } = {}) {
    this.scene = scene;
    this.remote = !!remote;
    this.active = false;
    this.origin = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.right = new THREE.Vector3(1, 0, 0);
    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();
    this._axisZ = new THREE.Vector3(0, 0, 1);

    const positions = new Float32Array(FLAME_PARTICLES * 3);
    const ages = new Float32Array(FLAME_PARTICLES);
    const seeds = new Float32Array(FLAME_PARTICLES);
    for (let i = 0; i < FLAME_PARTICLES; i++) {
      ages[i] = Math.random();
      seeds[i] = Math.random();
      positions[i * 3 + 1] = -10;
    }
    this.ages = ages;
    this.seeds = seeds;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry = geometry;

    // Remote/spectate: larger particles so the cone reads from the follow cam
    // (exact look axis otherwise collapses to a glowing tip blob).
    const pointSize = this.remote ? 0.72 : 0.55;
    this.points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        map: createFlameTexture(),
        size: pointSize,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        color: 0xffaa44,
        sizeAttenuation: true,
        opacity: this.remote ? 1 : 0.95,
      }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.visible = false;
    scene.add(this.points);

    // Soft volumetric “ice cream” core — rounded cone, not a flat fan
    const coreGeo = new THREE.ConeGeometry(0.95, FLAME_RANGE, 20, 1, true);
    coreGeo.translate(0, -FLAME_RANGE * 0.5, 0);
    coreGeo.rotateX(-Math.PI / 2);
    this.core = new THREE.Mesh(
      coreGeo,
      new THREE.MeshBasicMaterial({
        color: 0xff6a18,
        transparent: true,
        opacity: this.remote ? 0.1 : 0.18,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    this.core.visible = false;
    scene.add(this.core);

    const tipGeo = new THREE.SphereGeometry(this.remote ? 0.12 : 0.22, 12, 12);
    this.tip = new THREE.Mesh(
      tipGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffe08a,
        transparent: true,
        opacity: this.remote ? 0.25 : 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.tip.visible = false;
    scene.add(this.tip);
  }

  setFiring(on) {
    this.active = on;
    this.points.visible = on;
    this.core.visible = on;
    // Tip reads as a fake yellow ball on the spectate look-axis — keep dim/off for remote.
    this.tip.visible = on && !this.remote;
  }

  update(delta, origin, forward) {
    this.origin.copy(origin);
    this.forward.copy(forward).normalize();
    this.up.set(0, 1, 0);
    if (Math.abs(this.forward.dot(this.up)) > 0.92) this.up.set(1, 0, 0);
    this.right.crossVectors(this.forward, this.up).normalize();
    this.up.crossVectors(this.right, this.forward).normalize();

    const mid = this.tmp.copy(this.origin).addScaledVector(this.forward, FLAME_RANGE * 0.48);
    this.core.position.copy(mid);
    this.core.quaternion.setFromUnitVectors(this._axisZ, this.forward);
    this.core.scale.setScalar(1);

    this.tip.position.copy(this.origin).addScaledVector(this.forward, 0.12);

    if (!this.active) return;

    const positions = this.geometry.attributes.position.array;
    const pulse = 0.85 + 0.15 * Math.sin(performance.now() * 0.02);

    for (let i = 0; i < FLAME_PARTICLES; i++) {
      this.ages[i] += delta * (1.15 + this.seeds[i] * 0.9);
      if (this.ages[i] >= 1) this.ages[i] -= 1;

      const t = this.ages[i];
      const seed = this.seeds[i];
      // Fill a 3D cone volume (soft-serve style), not a flat sector
      const radiusT = Math.tan(FLAME_HALF_ANGLE) * (t * FLAME_RANGE);
      const angle = seed * Math.PI * 2 + t * 2.4;
      const radial = Math.sqrt(seed) * radiusT * (0.35 + 0.65 * (1 - t * 0.35));
      const swirl = 0.08 * Math.sin(t * 10 + seed * 20);

      this.tmp2
        .copy(this.origin)
        .addScaledVector(this.forward, t * FLAME_RANGE * pulse)
        .addScaledVector(this.right, Math.cos(angle) * radial + swirl)
        .addScaledVector(this.up, Math.sin(angle) * radial + Math.sin(t * 6 + seed) * 0.05);

      positions[i * 3] = this.tmp2.x;
      positions[i * 3 + 1] = this.tmp2.y;
      positions[i * 3 + 2] = this.tmp2.z;
    }

    this.geometry.attributes.position.needsUpdate = true;
    const base = this.remote ? 0.58 : 0.42;
    this.points.material.size = base + 0.22 * pulse;
    this.core.material.opacity = (this.remote ? 0.08 : 0.12) + 0.08 * pulse;
  }

  dispose() {
    this.scene.remove(this.points, this.core, this.tip);
    this.geometry.dispose();
    this.points.material.map?.dispose();
    this.points.material.dispose();
    this.core.geometry.dispose();
    this.core.material.dispose();
    this.tip.geometry.dispose();
    this.tip.material.dispose();
  }
}

const SMOKE_PARTICLES = 640;
/** Keep emitting through expand+hold; last 1s only existing wisps fade. */
const SMOKE_EMIT_SEC = SMOKE_EXPAND_SEC + SMOKE_HOLD_SEC;
const SMOKE_PUFF_LIFE = 3.2;
/** SmokeCloud was authored around HE×1.1 (~4.4m); scale motion/size from that. */
const SMOKE_DESIGN_RADIUS = 4.4;

function createSmokeTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(195, 198, 202, 0.55)');
  g.addColorStop(0.35, 'rgba(170, 174, 178, 0.3)');
  g.addColorStop(0.7, 'rgba(130, 134, 138, 0.1)');
  g.addColorStop(1, 'rgba(100, 100, 100, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * World-space billboard quads (NOT gl.POINTS).
 * Points hit GPU max point-size — scoped FOV makes enemies grow but points clamp,
 * so smoke looked tiny when ADS. Quads scale with the camera like real geometry.
 */
class SmokeCloud {
  constructor(scene, origin, radius) {
    this.scene = scene;
    this.origin = origin.clone();
    this.origin.y += 0.15;
    this.radius = radius;
    this.age = 0;
    this.emitAcc = 0;
    this._cam = null;

    const n = SMOKE_PARTICLES;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.baseSize = new Float32Array(n);
    this.alive = new Uint8Array(n);

    for (let i = 0; i < n; i += 1) {
      this.alive[i] = 0;
      this.py[i] = -999;
    }

    const geo = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.MeshBasicMaterial({
      map: createSmokeTexture(),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      opacity: 1,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, n);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Start all instances hidden
    const hide = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < n; i += 1) this.mesh.setMatrixAt(i, hide);
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);

    this._dummy = new THREE.Object3D();
    this._hideMat = hide;

    for (let i = 0; i < 70; i += 1) this._spawnPuff(0.15 + Math.random() * 0.35);
  }

  setCamera(camera) {
    this._cam = camera || null;
  }

  _spawnPuff(speedScale = 1) {
    let slot = -1;
    for (let i = 0; i < SMOKE_PARTICLES; i += 1) {
      if (!this.alive[i]) {
        slot = i;
        break;
      }
    }
    if (slot < 0) {
      let oldest = 0;
      let best = -1;
      for (let i = 0; i < SMOKE_PARTICLES; i += 1) {
        if (this.life[i] > best) {
          best = this.life[i];
          oldest = i;
        }
      }
      slot = oldest;
    }

    const scale = Math.max(0.25, this.radius / SMOKE_DESIGN_RADIUS);
    const jitter = 0.14 * scale;
    this.px[slot] = this.origin.x + (Math.random() - 0.5) * jitter;
    this.py[slot] = this.origin.y + Math.random() * 0.12 * scale;
    this.pz[slot] = this.origin.z + (Math.random() - 0.5) * jitter;

    const ang = Math.random() * Math.PI * 2;
    // Velocities must grow with radius or the cloud stays tiny while the limit number climbs.
    const out = (0.35 + Math.random() * 0.85) * speedScale * scale;
    const up = (0.25 + Math.random() * 0.55) * speedScale * scale;
    this.vx[slot] = Math.cos(ang) * out;
    this.vy[slot] = up;
    this.vz[slot] = Math.sin(ang) * out;

    this.life[slot] = 0;
    this.maxLife[slot] = SMOKE_PUFF_LIFE * (0.75 + Math.random() * 0.5);
    this.baseSize[slot] = (1.1 + Math.random() * 1.6) * Math.sqrt(scale);
    this.alive[slot] = 1;
  }

  /** @returns {boolean} false when finished and disposed */
  update(delta, camera = null) {
    if (camera) this._cam = camera;
    this.age += delta;
    if (this.age >= SMOKE_TOTAL_SEC) {
      this.dispose();
      return false;
    }

    const emitting = this.age < SMOKE_EMIT_SEC;
    let emitRate = 0;
    const dens = Math.max(1, this.radius / SMOKE_DESIGN_RADIUS);
    if (this.age < SMOKE_EXPAND_SEC) {
      emitRate = 70 * dens * (this.age / SMOKE_EXPAND_SEC);
    } else if (emitting) {
      emitRate = 85 * dens;
    }

    if (emitRate > 0) {
      this.emitAcc += emitRate * delta;
      while (this.emitAcc >= 1) {
        this.emitAcc -= 1;
        this._spawnPuff(0.7 + Math.random() * 0.5);
      }
    }

    let globalFade = 1;
    if (this.age > SMOKE_EMIT_SEC) {
      globalFade = 1 - (this.age - SMOKE_EMIT_SEC) / SMOKE_SHRINK_SEC;
    } else if (this.age < SMOKE_EXPAND_SEC) {
      globalFade = 0.4 + 0.6 * (this.age / SMOKE_EXPAND_SEC);
    }
    this.material.opacity = Math.max(0, globalFade);

    const drag = Math.pow(0.92, delta * 60);
    let anyAlive = false;
    const cam = this._cam;

    for (let i = 0; i < SMOKE_PARTICLES; i += 1) {
      if (!this.alive[i]) {
        this.mesh.setMatrixAt(i, this._hideMat);
        continue;
      }
      anyAlive = true;

      this.life[i] += delta / this.maxLife[i];
      this.vy[i] += 0.15 * delta;
      this.vx[i] *= drag;
      this.vy[i] *= drag;
      this.vz[i] *= drag;
      this.px[i] += this.vx[i] * delta;
      this.py[i] += this.vy[i] * delta;
      this.pz[i] += this.vz[i] * delta;

      const dx = this.px[i] - this.origin.x;
      const dy = this.py[i] - this.origin.y;
      const dz = this.pz[i] - this.origin.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > this.radius * 0.92) this.life[i] += delta * 0.55;

      if (this.life[i] >= 1) {
        this.alive[i] = 0;
        this.py[i] = -999;
        this.life[i] = 0;
        this.mesh.setMatrixAt(i, this._hideMat);
        continue;
      }

      const fadeIn = Math.min(1, this.life[i] / 0.12);
      const fadeOut = 1 - Math.max(0, (this.life[i] - 0.45) / 0.55);
      const grow = 0.55 + 1.85 * this.life[i];
      const s = this.baseSize[i] * grow * Math.max(0.05, fadeIn * fadeOut);

      this._dummy.position.set(this.px[i], this.py[i], this.pz[i]);
      if (cam) this._dummy.quaternion.copy(cam.quaternion);
      this._dummy.scale.set(s, s, s);
      this._dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this._dummy.matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;

    if (!emitting && !anyAlive) {
      this.dispose();
      return false;
    }
    return true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }
}

export class WeaponSystem {
  constructor(scene, character, domElement) {
    this.scene = scene;
    this.character = character;
    this.domElement = domElement;
    this.ready = false;
    this.index = 0;
    this.onWeaponChange = null;
    this.onAmmoChange = null;
    this.net = null;
    this.paused = true;
    this._meleeHitSent = false;
    this.lmbHeld = false;
    this.swingT = 0;
    this.swinging = false;
    this.actionCooldown = 0;
    this.muzzleFlashT = 0;
    this._playerRef = null;
    this.machinegunLoaded = false;
    this.machinegunLoading = false;
    this.sniperLoaded = false;
    this.sniperLoading = false;
    this.grenadeLoaded = false;
    this.grenadeLoading = false;
    this.shotgunLoaded = false;
    this.smokeLoaded = false;
    this.reloading = null;
    this.reloadTimer = 0;
    this._cameraPos = null;
    this._aimDirRef = null;
    this.scoping = false;
    this.liveGrenades = [];
    this.liveSmokes = [];
    this._grenadeVel = new THREE.Vector3();
    this._grenadeNext = new THREE.Vector3();
    this._pelletDir = new THREE.Vector3();

    this.ammo = {
      machinegun: { mag: AMMO_CONFIG.machinegun.magSize, reserve: AMMO_CONFIG.machinegun.reserve },
      shotgun: { mag: AMMO_CONFIG.shotgun.magSize, reserve: AMMO_CONFIG.shotgun.reserve },
      sniper: { mag: AMMO_CONFIG.sniper.magSize, reserve: AMMO_CONFIG.sniper.reserve },
      flamethrower: { mag: AMMO_CONFIG.flamethrower.magSize, reserve: AMMO_CONFIG.flamethrower.reserve },
      grenade: { mag: AMMO_CONFIG.grenade.magSize, reserve: AMMO_CONFIG.grenade.reserve },
      smoke: { mag: AMMO_CONFIG.smoke.magSize, reserve: AMMO_CONFIG.smoke.reserve },
    };

    this.root = new THREE.Group();
    this.root.position.copy(HAND_POS);
    character.add(this.root);

    this.slots = {
      machinegun: new THREE.Group(),
      shotgun: new THREE.Group(),
      sniper: new THREE.Group(),
      flamethrower: new THREE.Group(),
      grenade: new THREE.Group(),
      smoke: new THREE.Group(),
      melee: new THREE.Group(),
    };
    for (const id of WEAPON_IDS) {
      this.slots[id].visible = false;
      this.root.add(this.slots[id]);
    }

    this.flame = new FlameCone(scene);
    // Keep light in the scene graph (not under character) so it works while scoped/hidden.
    this.muzzleLight = new THREE.PointLight(0xffcc66, 0, 5, 2);
    scene.add(this.muzzleLight);

    this.audio = new WeaponAudio();
    this.impacts = new ImpactSystem(scene);
    this._flameWasFiring = false;
    /** @type {Map<string, { cone: FlameCone, origin: THREE.Vector3, dir: THREE.Vector3, until: number }>} */
    this.remoteFlames = new Map();
    this._remoteMuzzleT = 0;
    this.onArmsReady = null;

    this.tracers = [];
    this._tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffe08a,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });

    this._forward = new THREE.Vector3();
    this._muzzleWorld = new THREE.Vector3();
    this._aimEnd = new THREE.Vector3();
    this._aimPoint = new THREE.Vector3();
    this._shoulderForward = new THREE.Vector3();
    this._viewLeft = new THREE.Vector3();
    this._viewRight = new THREE.Vector3();
    this._worldUp = new THREE.Vector3(0, 1, 0);
    this._traceDir = new THREE.Vector3();
    this._onWheel = this._onWheel.bind(this);
    this._onDown = this._onDown.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);

    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('mousedown', this._onDown);
    window.addEventListener('mouseup', this._onUp);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('blur', () => {
      this.lmbHeld = false;
    });

    this._loadModels();
    this._notifyAmmo();
  }

  _loadModels() {
    const loader = new GLTFLoader();
    let pending = 3;
    const done = () => {
      pending -= 1;
      if (pending <= 0) {
        this.ready = true;
        this._applyVisibility();
        this._loadMachinegunModel();
        this._loadSniperModel();
        this.onArmsReady?.();
      }
    };

    loader.load('assets/flamethrower.glb', (gltf) => {
      const model = gltf.scene;
      fitWeaponModel(model, 0.55);
      model.rotation.set(0.15, Math.PI / 2, 0.05);
      model.position.set(0.05, 0, 0);
      this.slots.flamethrower.add(model);

      const nozzle = new THREE.Object3D();
      nozzle.position.set(0.32, 0.06, 0);
      this.slots.flamethrower.add(nozzle);
      this.flameNozzle = nozzle;
      done();
    }, undefined, done);

    loader.load('assets/melee.glb', (gltf) => {
      const model = gltf.scene;
      fitWeaponModel(model, 0.7);
      model.rotation.set(0.2, Math.PI / 2, -0.35);
      model.position.set(0.05, 0.05, 0);
      this.slots.melee.add(model);
      this.meleeModel = this.slots.melee;
      done();
    }, undefined, done);

    loader.load('assets/grenade.glb', (gltf) => {
      const model = gltf.scene;
      fitWeaponModel(model, 0.28);
      model.rotation.set(0.2, Math.PI / 2, 0.1);
      model.position.set(0.08, 0.02, 0);
      this.slots.grenade.add(model);
      this.grenadePrototype = model;
      this.grenadeLoaded = true;
      done();
    }, undefined, done);

    // Procedural props (no glb)
    const shotgun = createShotgunProp();
    fitWeaponModel(shotgun, 0.85);
    shotgun.rotation.set(0.08, Math.PI / 2, 0);
    shotgun.position.set(0.08, 0.02, 0);
    this.slots.shotgun.add(shotgun);
    const sgMuzzle = new THREE.Object3D();
    sgMuzzle.position.set(0.5, 0.05, 0);
    this.slots.shotgun.add(sgMuzzle);
    this.shotgunMuzzle = sgMuzzle;
    this.shotgunLoaded = true;

    const smokeProp = createSmokeCanisterProp();
    fitWeaponModel(smokeProp, 0.26);
    smokeProp.rotation.set(0.2, Math.PI / 2, 0.1);
    smokeProp.position.set(0.08, 0.02, 0);
    this.slots.smoke.add(smokeProp);
    this.smokePrototype = smokeProp;
    this.smokeLoaded = true;
  }

  _loadMachinegunModel() {
    if (this.machinegunLoaded || this.machinegunLoading) return;
    this.machinegunLoading = true;

    const loader = new GLTFLoader();
    loader.load(
      'assets/machinegun.glb',
      (gltf) => {
        const model = gltf.scene;
        stripMachinegunAttachments(model);
        fitWeaponModel(model, 0.95);
        model.rotation.set(0.05, Math.PI / 2, 0);
        model.position.set(0.08, 0.02, 0);
        this.slots.machinegun.add(model);

        const muzzle = new THREE.Object3D();
        muzzle.position.set(0.48, 0.06, 0);
        this.slots.machinegun.add(muzzle);
        this.machinegunMuzzle = muzzle;

        this.machinegunLoaded = true;
        this.machinegunLoading = false;
        this._applyVisibility();
        this.onArmsReady?.();
      },
      undefined,
      (error) => {
        console.error('Failed to load machinegun model', error);
        this.machinegunLoading = false;
      },
    );
  }

  _loadSniperModel() {
    if (this.sniperLoaded || this.sniperLoading) return;
    this.sniperLoading = true;

    const loader = new GLTFLoader();
    loader.load(
      'assets/sniper.glb',
      (gltf) => {
        const model = gltf.scene;
        fitWeaponModel(model, 1.15);
        model.rotation.set(0.05, Math.PI / 2, 0);
        model.position.set(0.1, 0.02, 0);
        this.slots.sniper.add(model);

        const muzzle = new THREE.Object3D();
        muzzle.position.set(0.58, 0.05, 0);
        this.slots.sniper.add(muzzle);
        this.sniperMuzzle = muzzle;

        this.sniperLoaded = true;
        this.sniperLoading = false;
        this._applyVisibility();
        this.onArmsReady?.();
      },
      undefined,
      (error) => {
        console.error('Failed to load sniper model', error);
        this.sniperLoading = false;
      },
    );
  }

  /** Cloned hand weapons for remote / spectate ghosts. */
  createGhostArms() {
    if (!this.ready) return null;
    const root = new THREE.Group();
    root.position.copy(HAND_POS);
    const slots = {};
    for (const id of WEAPON_IDS) {
      const slot = this.slots[id].clone(true);
      slot.visible = false;
      root.add(slot);
      slots[id] = slot;
    }
    let swingT = 0;
    let swinging = false;
    return {
      root,
      slots,
      setWeapon(id) {
        for (const [k, s] of Object.entries(slots)) s.visible = k === id;
        if (id !== 'melee') {
          swinging = false;
          swingT = 0;
          slots.melee.rotation.set(0, 0, 0);
        }
      },
      startSwing() {
        swinging = true;
        swingT = 0;
      },
      update(delta) {
        if (!swinging || !slots.melee) return;
        swingT += delta;
        const dur = 0.32;
        const t = Math.min(1, swingT / dur);
        const arc = t < 0.45
          ? THREE.MathUtils.smoothstep(t / 0.45, 0, 1)
          : 1 - THREE.MathUtils.smoothstep((t - 0.45) / 0.55, 0, 1);
        slots.melee.rotation.x = -arc * 1.35;
        slots.melee.rotation.y = arc * 0.55;
        slots.melee.rotation.z = -arc * 0.9;
        if (t >= 1) {
          swinging = false;
          swingT = 0;
          slots.melee.rotation.set(0, 0, 0);
        }
      },
      dispose() {
        root.parent?.remove(root);
      },
    };
  }

  /**
   * Full remote shot FX for every ballistic weapon (MG / sniper / shotgun).
   * Same path for local observers and Space spectate — not flamethrower-only.
   */
  playRemoteFire(origin, dir, weaponId = 'machinegun', { scoped = false } = {}) {
    if (!origin || !dir) return;
    const from = origin.clone ? origin.clone() : new THREE.Vector3(origin.x, origin.y, origin.z);
    const d = dir.clone ? dir.clone() : new THREE.Vector3(dir.x, dir.y, dir.z);
    d.normalize();
    const hitPoint = this.impacts.raycastBullet(from, d, FIRE_AIM_POINT_DIST);
    const to = hitPoint
      ? hitPoint.clone()
      : from.clone().addScaledVector(d, Math.min(FIRE_AIM_POINT_DIST, 80));

    // Always offset tracers for remote viewers (camera-coaxial = invisible).
    let life = 0.12;
    let radius = 0.03;
    if (weaponId === 'sniper') {
      life = 0.32;
      radius = 0.05;
    } else if (weaponId === 'shotgun') {
      life = 0.14;
      radius = 0.022;
    } else if (weaponId === 'machinegun') {
      life = 0.14;
      radius = 0.032;
    }
    this._spawnScopedVisibleTracer(from, d, to, true, life, radius);
    this._pulseRemoteMuzzle(from, weaponId);

    this._ensureAudio();
    try {
      if (weaponId === 'sniper') this.audio.playSniperShot?.();
      else if (weaponId === 'shotgun') this.audio.playShotgunShot?.();
      else if (weaponId === 'machinegun') this.audio.playMachinegunShot?.();
    } catch (err) {
      console.error(err);
    }
  }

  /** Same PointLight values as local `_updateMuzzleLight` / muzzleFlashT — no sprite mesh. */
  _pulseRemoteMuzzle(origin, weaponId = 'machinegun') {
    if (!this.muzzleLight || !origin) return;
    this.muzzleLight.position.copy(origin);
    const sniper = weaponId === 'sniper';
    const shotgun = weaponId === 'shotgun';
    this.muzzleLight.color.setHex(0xffcc66);
    this.muzzleLight.intensity = sniper ? 5 : 3.5;
    this.muzzleLight.distance = 5;
    // Match local muzzleFlashT durations exactly.
    this._remoteMuzzleT = sniper ? 0.09 : shotgun ? 0.1 : 0.05;
  }

  /** Wipe tracer meshes (stuck lines after paused/broken updates). */
  clearTracers() {
    for (const tr of this.tracers) {
      this.scene.remove(tr.mesh);
      tr.mesh?.geometry?.dispose?.();
      if (tr.mesh?.material && tr.muzzleSprite) tr.mesh.material.dispose?.();
    }
    this.tracers.length = 0;
  }

  /**
   * Enable local shooting for a live match. Safe to call on match start AND every respawn
   * so a late model load / spectate pause can't leave the player gunless for the rest of the game.
   */
  armForPlay(net = null) {
    this.paused = false;
    if (net) this.net = net;
    this.lmbHeld = false;
    this.actionCooldown = 0;
    this.muzzleFlashT = 0;
    this.swinging = false;
    this.swingT = 0;
    this._meleeHitSent = false;
    if (this.reloading) {
      this.reloading = null;
      this.reloadTimer = 0;
    }
    this.clearTracers();
    if (this.muzzleLight) this.muzzleLight.intensity = 0;
  }

  isReloading(weaponId = this.currentId) {
    return !!this.reloading && (!weaponId || this.reloading === weaponId);
  }

  /** True only while the local flamethrower is actually emitting (not reload / empty). */
  isFlamethrowerFiring() {
    return this.currentId === 'flamethrower' && !!this._flameWasFiring && !this.reloading;
  }

  /**
   * Any weapon that is genuinely shooting right now (not LMB-held during reload/empty).
   * Spectate must match this — holding fire while reloading is NOT firing.
   */
  isActivelyFiring() {
    if (this.paused || this.reloading) return false;
    if (this.currentId === 'flamethrower') return this.isFlamethrowerFiring();
    if (this.currentId === 'machinegun' || this.currentId === 'shotgun') {
      return !!this.lmbHeld && this._pointerLocked() && this._canUseAmmo(this.currentId);
    }
    // Semi-auto: muzzle flash window = a real shot just happened
    return this.muzzleFlashT > 0;
  }

  /**
   * Keep remote flamethrower cone lit between flame packets / state ticks.
   * Scorches only when `scorch` (network flame packets), not every render frame.
   */
  playRemoteFlame(username, origin, dir, { scorch = false } = {}) {
    if (!username || !origin || !dir) return;
    let entry = this.remoteFlames.get(username);
    if (!entry) {
      entry = {
        cone: new FlameCone(this.scene, { remote: true }),
        origin: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        until: 0,
      };
      this.remoteFlames.set(username, entry);
    }
    entry.origin.set(origin[0] ?? origin.x, origin[1] ?? origin.y, origin[2] ?? origin.z);
    entry.dir.set(dir[0] ?? dir.x, dir[1] ?? dir.y, dir[2] ?? dir.z).normalize();
    entry.until = performance.now() + 280;
    entry.cone.setFiring(true);
    // Update immediately so the first spectate frame isn't an empty tip blob.
    entry.cone.update(1 / 60, entry.origin, entry.dir);
    if (scorch) {
      this.impacts.applyFlame(entry.origin, entry.dir, FLAME_RANGE, FLAME_HALF_ANGLE);
    }
  }

  stopRemoteFlame(username) {
    const entry = this.remoteFlames.get(username);
    if (!entry) return;
    entry.until = 0;
    entry.cone.setFiring(false);
  }

  _updateRemoteFlames(delta) {
    const now = performance.now();
    for (const [, entry] of this.remoteFlames) {
      if (now > entry.until) {
        entry.cone.setFiring(false);
        continue;
      }
      entry.cone.setFiring(true);
      entry.cone.update(delta, entry.origin, entry.dir);
    }
  }

  setImpactMeshes(meshes) {
    this.impacts.setMeshes(meshes);
  }

  async initAudio() {
    try {
      await this.audio.init();
    } catch (err) {
      console.error('Weapon audio init failed', err);
    }
  }

  _ensureAudio() {
    if (!this.audio?.ready) {
      void this.initAudio();
    }
  }

  get currentId() {
    return WEAPON_IDS[this.index];
  }

  get currentLabel() {
    return WEAPON_LABELS[this.currentId];
  }

  canScope(weaponId = this.currentId) {
    return !!WEAPON_FLAGS[weaponId]?.canScope;
  }

  /** Absolute camera FOV while scoped for the current (or given) weapon. */
  getScopeFov(hipFov = 70, weaponId = this.currentId) {
    if (weaponId === 'sniper') return SNIPER_SCOPE_FOV;
    if (weaponId === 'machinegun') return MACHINEGUN_SCOPE_FOV;
    return hipFov;
  }

  requiresScopeToFire(weaponId = this.currentId) {
    return !!WEAPON_FLAGS[weaponId]?.requireScopeToFire;
  }

  setScoping(active) {
    this.scoping = !!active && this.canScope();
    return this.scoping;
  }

  getAmmoDisplay(weaponId = this.currentId) {
    const cfg = AMMO_CONFIG[weaponId];
    if (cfg?.infinite) return `${INFINITY}-${INFINITY}`;
    const state = this.ammo[weaponId];
    if (this.reloading === weaponId) {
      return `REL-${Math.floor(state.reserve)}`;
    }
    return `${Math.floor(state.mag)}-${Math.floor(state.reserve)}`;
  }

  _notifyAmmo() {
    if (this.onAmmoChange) this.onAmmoChange(this.getAmmoDisplay());
  }

  /**
   * Origin: view-left shoulder (screen-left from camera), slightly in front of the body.
   * Direction: from that origin toward the world point under the screen crosshair.
   */
  _computeFireToCrosshair(cameraPos, aimDir, player) {
    const yaw = player ? player.cameraYaw : this.character.rotation.y;
    this._shoulderForward.set(Math.sin(yaw), 0, Math.cos(yaw));

    // Screen-left relative to look direction (not character model left).
    const look = aimDir || (player ? player.getAimDirection(this._traceDir) : this._shoulderForward);
    this._viewRight.crossVectors(look, this._worldUp);
    if (this._viewRight.lengthSq() < 1e-6) {
      this._viewRight.set(1, 0, 0);
    } else {
      this._viewRight.normalize();
    }
    this._viewLeft.copy(this._viewRight).multiplyScalar(-1);

    this._muzzleWorld
      .copy(this.character.position)
      .addScaledVector(this._shoulderForward, FIRE_SHOULDER_FORWARD)
      .addScaledVector(this._viewLeft, FIRE_VIEW_LEFT);
    this._muzzleWorld.y = this.character.position.y + FIRE_SHOULDER_Y;

    if (cameraPos && look) {
      this._aimPoint.copy(cameraPos).addScaledVector(look, FIRE_AIM_POINT_DIST);
    } else {
      this._aimPoint
        .copy(this._muzzleWorld)
        .addScaledVector(this._shoulderForward, FIRE_AIM_POINT_DIST);
    }

    this._forward.subVectors(this._aimPoint, this._muzzleWorld);
    if (this._forward.lengthSq() < 1e-6) {
      this._forward.copy(this._shoulderForward);
    } else {
      this._forward.normalize();
    }
  }

  _updateMuzzleLight(active, colorHex, intensity) {
    this.muzzleLight.color.setHex(colorHex);
    this.muzzleLight.intensity = active ? intensity : 0;
    if (active) {
      this.muzzleLight.position.copy(this._muzzleWorld);
    }
  }

  _canUseAmmo(weaponId) {
    const cfg = AMMO_CONFIG[weaponId];
    if (cfg?.infinite) return true;
    if (this.reloading === weaponId) return false;
    return this.ammo[weaponId].mag > 0;
  }

  _consumeRound(weaponId) {
    const state = this.ammo[weaponId];
    if (!state || state.mag <= 0) return false;
    state.mag -= 1;
    this._notifyAmmo();
    if (state.mag <= 0) this._startReload(weaponId, true);
    return true;
  }

  _consumeFlame(delta) {
    const state = this.ammo.flamethrower;
    if (state.mag <= 0) return false;
    const use = FLAME_USE_PER_SEC * delta;
    state.mag = Math.max(0, state.mag - use);
    this._notifyAmmo();
    if (state.mag <= 0) this._startReload('flamethrower', true);
    return true;
  }

  _startReload(weaponId, auto = false) {
    const cfg = AMMO_CONFIG[weaponId];
    if (!cfg || cfg.infinite) return false;
    if (this.reloading) return false;

    const state = this.ammo[weaponId];
    if (state.mag >= cfg.magSize) return false;
    if (state.reserve <= 0) return false;

    this.reloading = weaponId;
    this.reloadTimer = cfg.reloadTime;
    if (!auto && this.onWeaponChange) this.onWeaponChange(this.currentId);
    this._notifyAmmo();
    return true;
  }

  _finishReload() {
    const weaponId = this.reloading;
    if (!weaponId) return;

    const cfg = AMMO_CONFIG[weaponId];
    const state = this.ammo[weaponId];
    const needed = cfg.magSize - state.mag;
    const transfer = Math.min(needed, state.reserve);
    state.mag += transfer;
    state.reserve -= transfer;

    this.reloading = null;
    this.reloadTimer = 0;
    if (this.onWeaponChange) this.onWeaponChange(this.currentId);
    this._notifyAmmo();
  }

  requestReload() {
    if (!this._pointerLocked()) return;
    const id = this.currentId;
    if (AMMO_CONFIG[id]?.infinite) return;
    this._startReload(id, false);
  }

  _applyVisibility() {
    for (const id of WEAPON_IDS) {
      this.slots[id].visible = id === this.currentId;
    }
    if (this.currentId !== 'flamethrower') {
      this.flame.setFiring(false);
    }
  }

  cycle(dir) {
    const n = WEAPON_IDS.length;
    this.index = (this.index + dir + n) % n;
    this.swinging = false;
    this.swingT = 0;
    this.slots.melee.rotation.set(0, 0, 0);
    this.lmbHeld = this.lmbHeld && (
      this.currentId === 'flamethrower'
      || this.currentId === 'machinegun'
      || this.currentId === 'shotgun'
    );
    if (this._flameWasFiring) {
      this.audio.setFlamethrowerFiring(false);
      this._flameWasFiring = false;
    }
    if (!this.canScope()) this.scoping = false;
    if (this.currentId === 'machinegun') this._loadMachinegunModel();
    if (this.currentId === 'sniper') this._loadSniperModel();
    this._applyVisibility();
    if (this.onWeaponChange) this.onWeaponChange(this.currentId);
    this._notifyAmmo();
  }

  _onKeyDown(event) {
    if (this.paused) return;
    if (event.code !== 'KeyR' || event.repeat) return;
    if (!this._pointerLocked()) return;
    event.preventDefault();
    this.requestReload();
  }

  _pointerLocked() {
    return document.pointerLockElement === this.domElement;
  }

  _onWheel(event) {
    if (this.paused) return;
    if (!this._pointerLocked()) return;
    event.preventDefault();
    if (event.deltaY < 0) this.cycle(1); // scroll up → clockwise
    else if (event.deltaY > 0) this.cycle(-1); // scroll down → anticlockwise
  }

  _canShootNow() {
    if (this.paused || !this._pointerLocked()) return false;
    // Dead until respawn — no local fire / tracer spam.
    if (this.net?.combat && this.net.combat.alive === false) return false;
    return true;
  }

  _onDown(event) {
    if (!this._canShootNow()) return;
    if (event.button !== 0) return;
    this.lmbHeld = true;
    if (this.currentId === 'melee') this._startSwing();
    if (this.currentId === 'machinegun') this._fireMachinegun(this._playerRef, this._cameraPos);
    if (this.currentId === 'shotgun') this._fireShotgun(this._playerRef, this._cameraPos);
    if (this.currentId === 'sniper') this._fireSniper(this._playerRef, this._cameraPos);
    if (this.currentId === 'grenade') this._throwThrowable(this._playerRef, this._cameraPos, 'he');
    if (this.currentId === 'smoke') this._throwThrowable(this._playerRef, this._cameraPos, 'smoke');
  }

  _onUp(event) {
    if (event.button !== 0) return;
    this.lmbHeld = false;
  }

  _startSwing() {
    if (this.swinging) return;
    this.swinging = true;
    this.swingT = 0;
    this._meleeHitSent = false;
    this._ensureAudio();
    if (typeof this.audio.playMeleeSwing === 'function') this.audio.playMeleeSwing();
  }

  _applyBallisticRecoil(player, { movingDeg, scopedDeg, stillDeg, scopedOnly = false }) {
    if (!player) return;
    let coneDeg = stillDeg;
    if (this.scoping && this.canScope()) {
      coneDeg = scopedDeg;
    } else if (!scopedOnly && player.isMoving()) {
      coneDeg = movingDeg;
    }
    if (coneDeg <= 0) return;
    const half = THREE.MathUtils.degToRad(coneDeg * 0.5);
    const r = Math.sqrt(Math.random()) * half;
    const theta = Math.random() * Math.PI * 2;
    player.applyRecoil(Math.cos(theta) * r, Math.sin(theta) * r);
  }

  /** Offset a unit direction inside a cone (degrees full-width). */
  _applyConeToDirection(dir, coneDeg) {
    if (!dir || coneDeg <= 0) return;
    const half = THREE.MathUtils.degToRad(coneDeg * 0.5);
    const r = Math.sqrt(Math.random()) * half;
    const theta = Math.random() * Math.PI * 2;
    this._viewRight.crossVectors(dir, this._worldUp);
    if (this._viewRight.lengthSq() < 1e-8) this._viewRight.set(1, 0, 0);
    else this._viewRight.normalize();
    this._viewLeft.crossVectors(this._viewRight, dir).normalize();
    dir
      .addScaledVector(this._viewRight, Math.cos(theta) * Math.tan(r))
      .addScaledVector(this._viewLeft, Math.sin(theta) * Math.tan(r))
      .normalize();
  }

  _spawnTracer(from, to, life = 0.06, radius = 0.01) {
    const geo = new THREE.CylinderGeometry(radius, radius * 0.65, 1, 6);
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, this._tracerMat);
    const mid = from.clone().lerp(to, 0.5);
    mesh.position.copy(mid);
    mesh.scale.z = Math.max(0.01, from.distanceTo(to));
    mesh.lookAt(to);
    this.scene.add(mesh);
    this.tracers.push({ mesh, life });
  }

  _fireBallistic(player, cameraPos, {
    weaponId,
    loaded,
    ensureLoaded,
    interval,
    recoil,
    playShot,
    requireScope = false,
  }) {
    if (!loaded) {
      ensureLoaded();
      return;
    }
    if (requireScope && !this.scoping) return;
    if (this.reloading === weaponId) return;
    if (this.actionCooldown > 0) return;
    if (!this._canUseAmmo(weaponId)) {
      this._startReload(weaponId, true);
      return;
    }

    this.actionCooldown = interval;
    this.muzzleFlashT = weaponId === 'sniper' ? 0.09 : 0.05;
    if (!this._consumeRound(weaponId)) return;

    const aim = player ? player.getAimDirection(this._traceDir) : this._aimDirRef;
    const cam = cameraPos || this._cameraPos;
    // Scoped MG + sniper: true FOV/crosshair ray (not shoulder parallax).
    const useCameraRay = this.scoping && this.canScope() && cam && aim
      && (weaponId === 'sniper' || weaponId === 'machinegun');

    if (useCameraRay) {
      this._muzzleWorld.copy(cam);
      this._forward.copy(aim).normalize();
      if (weaponId === 'sniper') {
        if (player?.isMoving?.()) {
          this._applyConeToDirection(this._forward, SNIPER_SCOPED_MOVING_DEG);
        }
      }
      // MG scoped: bullet is FOV-perfect; heavy recoil applied after the shot.
    } else {
      this._applyBallisticRecoil(player, recoil);
      this._computeFireToCrosshair(cam, player ? player.getAimDirection(this._traceDir) : aim, player);
    }

    this._ensureAudio();
    try {
      playShot();
    } catch (err) {
      console.error(err);
    }

    const hitPoint = this.impacts.raycastBullet(
      this._muzzleWorld,
      this._forward,
      FIRE_AIM_POINT_DIST,
    );
    if (hitPoint) this._aimEnd.copy(hitPoint);
    else this._aimEnd.copy(this._muzzleWorld).addScaledVector(this._forward, FIRE_AIM_POINT_DIST);

    this._spawnScopedVisibleTracer(
      this._muzzleWorld,
      this._forward,
      this._aimEnd,
      useCameraRay,
      weaponId === 'sniper' ? 0.16 : 0.08,
      weaponId === 'sniper' ? 0.035 : 0.022,
    );

    if (this.net?.inMatch) {
      this.net.tryHitscan(weaponId, this._muzzleWorld, this._forward, { scoped: useCameraRay });
    }

    // Post-shot kick for scoped MG (balance) — after the accurate FOV bullet.
    if (useCameraRay && weaponId === 'machinegun') {
      this._applyBallisticRecoil(player, recoil);
    }
  }

  /**
   * Camera-coaxial tracers are invisible. Offset visual origin in view-space;
   * hitscan origin/dir stay unchanged.
   */
  _spawnScopedVisibleTracer(origin, dir, aimEnd, useCameraRay, life, radius) {
    let tracerFrom = origin;
    let tracerLife = life;
    let tracerRadius = radius;
    if (useCameraRay) {
      this._viewRight.crossVectors(dir, this._worldUp);
      if (this._viewRight.lengthSq() < 1e-8) this._viewRight.set(1, 0, 0);
      else this._viewRight.normalize();
      this._viewLeft.crossVectors(this._viewRight, dir).normalize();
      tracerFrom = origin.clone()
        .addScaledVector(dir, 0.85)
        .addScaledVector(this._viewLeft, -0.045)
        .addScaledVector(this._viewRight, 0.02);
      tracerLife = Math.max(life, 0.12);
      tracerRadius = Math.max(radius, 0.028);
    }
    this._spawnTracer(tracerFrom, aimEnd, tracerLife, tracerRadius);
  }

  _fireMachinegun(player, cameraPos) {
    this._fireBallistic(player, cameraPos, {
      weaponId: 'machinegun',
      loaded: this.machinegunLoaded,
      ensureLoaded: () => this._loadMachinegunModel(),
      interval: MACHINEGUN_FIRE_INTERVAL,
      recoil: {
        movingDeg: MACHINEGUN_RECOIL_MOVING_DEG,
        scopedDeg: MACHINEGUN_RECOIL_SCOPED_DEG,
        stillDeg: MACHINEGUN_RECOIL_STILL_DEG,
      },
      playShot: () => this.audio.playMachinegunShot(),
    });
  }

  _fireSniper(player, cameraPos) {
    this._fireBallistic(player, cameraPos, {
      weaponId: 'sniper',
      loaded: this.sniperLoaded,
      ensureLoaded: () => this._loadSniperModel(),
      interval: SNIPER_FIRE_INTERVAL,
      requireScope: true,
      recoil: {
        movingDeg: SNIPER_SCOPED_MOVING_DEG,
        scopedDeg: SNIPER_SCOPED_STILL_DEG,
        stillDeg: SNIPER_SCOPED_STILL_DEG,
        scopedOnly: true,
      },
      playShot: () => this.audio.playSniperShot(),
    });
  }

  _fireShotgun(player, cameraPos) {
    if (!this.shotgunLoaded) return;
    if (this.reloading === 'shotgun') return;
    if (this.actionCooldown > 0) return;
    if (!this._canUseAmmo('shotgun')) {
      this._startReload('shotgun', true);
      return;
    }

    this.actionCooldown = SHOTGUN_FIRE_INTERVAL;
    this.muzzleFlashT = 0.1;
    if (!this._consumeRound('shotgun')) return;

    const aim = player ? player.getAimDirection(this._traceDir) : this._aimDirRef;
    const cam = cameraPos || this._cameraPos;
    this._computeFireToCrosshair(cam, aim, player);

    this._ensureAudio();
    try {
      if (typeof this.audio.playShotgunShot === 'function') this.audio.playShotgunShot();
      else this.audio.playSniperShot();
    } catch (err) {
      console.error(err);
    }

    const pellets = SHOTGUN_PELLETS_MIN
      + Math.floor(Math.random() * (SHOTGUN_PELLETS_MAX - SHOTGUN_PELLETS_MIN + 1));
    const origin = this._muzzleWorld.clone();

    for (let i = 0; i < pellets; i += 1) {
      this._pelletDir.copy(this._forward);
      this._applyConeToDirection(this._pelletDir, SHOTGUN_SPREAD_DEG);
      const hitPoint = this.impacts.raycastBullet(origin, this._pelletDir, FIRE_AIM_POINT_DIST);
      if (hitPoint) this._aimEnd.copy(hitPoint);
      else this._aimEnd.copy(origin).addScaledVector(this._pelletDir, TRACER_LENGTH);
      this._spawnTracer(origin, this._aimEnd, 0.07, 0.012);
      if (this.net?.inMatch) {
        this.net.tryHitscan('shotgun', origin, this._pelletDir, { scoped: false });
      }
    }

    this._applyBallisticRecoil(player, {
      movingDeg: SHOTGUN_RECOIL_MOVING_DEG,
      scopedDeg: SHOTGUN_RECOIL_STILL_DEG,
      stillDeg: SHOTGUN_RECOIL_STILL_DEG,
    });
  }

  _throwThrowable(player, cameraPos, kind = 'he') {
    const weaponId = kind === 'smoke' ? 'smoke' : 'grenade';
    const loaded = kind === 'smoke' ? this.smokeLoaded : this.grenadeLoaded;
    if (!loaded) return;
    if (this.reloading === weaponId) return;
    if (this.actionCooldown > 0) return;
    if (!this._canUseAmmo(weaponId)) {
      this._startReload(weaponId, true);
      return;
    }

    this.actionCooldown = GRENADE_THROW_INTERVAL;
    if (!this._consumeRound(weaponId)) return;
    this._ensureAudio();

    const aim = player ? player.getAimDirection(this._traceDir) : this._aimDirRef;
    this._computeFireToCrosshair(cameraPos || this._cameraPos, aim, player);

    const root = new THREE.Group();
    if (kind === 'smoke' && this.smokePrototype) {
      const body = this.smokePrototype.clone(true);
      body.position.set(0, 0, 0);
      body.rotation.set(0, 0, 0);
      root.add(body);
    } else if (kind === 'he' && this.grenadePrototype) {
      const body = this.grenadePrototype.clone(true);
      body.position.set(0, 0, 0);
      body.rotation.set(0, 0, 0);
      body.scale.multiplyScalar(1.05);
      root.add(body);
    } else {
      root.add(new THREE.Mesh(
        new THREE.CylinderGeometry(0.028, 0.032, 0.16, 10),
        new THREE.MeshStandardMaterial({
          color: kind === 'smoke' ? 0x6a7a88 : 0x3f4f32,
          metalness: 0.45,
          roughness: 0.5,
        }),
      ));
    }

    let fuseTip = null;
    let fuseLight = null;
    let sparks = null;
    let sparkPos = null;
    let sparkAge = null;

    if (kind === 'he') {
      fuseTip = new THREE.Mesh(
        new THREE.SphereGeometry(0.012, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffaa33 }),
      );
      fuseTip.position.set(0, 0.14, 0);
      root.add(fuseTip);

      fuseLight = new THREE.PointLight(0xff6622, 0.7, 1.6, 2);
      fuseLight.position.copy(fuseTip.position);
      root.add(fuseLight);

      const sparkGeo = new THREE.BufferGeometry();
      const sparkCount = 12;
      sparkPos = new Float32Array(sparkCount * 3);
      sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
      sparks = new THREE.Points(
        sparkGeo,
        new THREE.PointsMaterial({
          color: 0xffcc66,
          size: 0.028,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      sparks.frustumCulled = false;
      root.add(sparks);
      sparkAge = new Float32Array(sparkCount);
    }

    root.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });
    root.position.copy(this._muzzleWorld);
    this.scene.add(root);

    const vel = this._forward.clone().multiplyScalar(GRENADE_THROW_SPEED);
    vel.y += 3.5;

    this.liveGrenades.push({
      mesh: root,
      vel,
      fuse: GRENADE_FUSE,
      settled: false,
      kind,
      fuseTip,
      fuseLight,
      sparks,
      sparkPos,
      sparkAge,
      fromRemote: false,
    });

    if (this.net?.inMatch) {
      this.net.notifyGrenadeThrow(root.position, vel, GRENADE_FUSE, kind);
    }
  }

  /** Spawn a visual-only throwable from a remote throw message. */
  spawnRemoteGrenade(origin, vel, fuse = GRENADE_FUSE, kind = 'he') {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.032, 0.16, 10),
      new THREE.MeshStandardMaterial({
        color: kind === 'smoke' ? 0x6a7a88 : 0x3f4f32,
        metalness: 0.45,
        roughness: 0.5,
      }),
    ));
    root.position.set(origin[0], origin[1], origin[2]);
    this.scene.add(root);
    this.liveGrenades.push({
      mesh: root,
      vel: new THREE.Vector3(vel[0], vel[1], vel[2]),
      fuse,
      settled: false,
      kind,
      fromRemote: true,
    });
  }

  _spawnSmokeCloud(pos, _fromRemote = false, radius = SMOKE_RADIUS) {
    const origin = pos.clone ? pos.clone() : new THREE.Vector3(pos.x, pos.y, pos.z);
    this.liveSmokes.push(new SmokeCloud(this.scene, origin, radius));

    this._ensureAudio();
    try {
      if (typeof this.audio.playSmokePop === 'function') this.audio.playSmokePop();
    } catch (err) {
      console.error(err);
    }
  }

  /** Optional explicit deploy (peers normally simulate from smoke throw fuse). */
  spawnRemoteSmoke(pos, radius = SMOKE_RADIUS) {
    const p = Array.isArray(pos)
      ? new THREE.Vector3(pos[0], pos[1], pos[2])
      : pos.clone();
    this._spawnSmokeCloud(p, true, radius);
  }

  _updateSmokes(delta, camera = null) {
    for (let i = this.liveSmokes.length - 1; i >= 0; i -= 1) {
      if (!this.liveSmokes[i].update(delta, camera)) {
        this.liveSmokes.splice(i, 1);
      }
    }
  }

  _updateGrenades(delta) {
    for (let i = this.liveGrenades.length - 1; i >= 0; i -= 1) {
      const g = this.liveGrenades[i];
      g.fuse -= delta;

      // Animate fuse sparks around the tip
      if (g.sparks && g.sparkPos) {
        const arr = g.sparkPos;
        const n = arr.length / 3;
        for (let s = 0; s < n; s += 1) {
          g.sparkAge[s] = (g.sparkAge[s] || Math.random()) + delta * (2.5 + Math.random() * 2);
          if (g.sparkAge[s] > 1) g.sparkAge[s] -= 1;
          const t = g.sparkAge[s];
          const a = s * 1.7 + t * 8;
          arr[s * 3] = Math.cos(a) * 0.02 * t;
          arr[s * 3 + 1] = 0.14 + t * 0.06;
          arr[s * 3 + 2] = Math.sin(a) * 0.02 * t;
        }
        g.sparks.geometry.attributes.position.needsUpdate = true;
        g.fuseLight.intensity = 0.45 + Math.random() * 0.45;
        g.fuseTip.material.color.setHex(Math.random() > 0.5 ? 0xffaa33 : 0xff6622);
      }

      if (!g.settled) {
        g.vel.y -= GRENADE_GRAVITY * delta;
        this._grenadeNext.copy(g.mesh.position).addScaledVector(g.vel, delta);

        const speed = g.vel.length();
        let hitPoint = null;
        if (speed > 1e-4 && this.impacts.meshes.length) {
          this._traceDir.copy(g.vel).normalize();
          const dist = Math.max(0.05, g.mesh.position.distanceTo(this._grenadeNext) + 0.05);
          this.impacts.raycaster.set(g.mesh.position, this._traceDir);
          this.impacts.raycaster.far = dist;
          const hits = this.impacts.raycaster.intersectObjects(this.impacts.meshes, false);
          hitPoint = hits[0] || null;
        }

        if (hitPoint) {
          const n = hitPoint.face
            ? hitPoint.face.normal.clone().transformDirection(hitPoint.object.matrixWorld).normalize()
            : new THREE.Vector3(0, 1, 0);
          g.mesh.position.copy(hitPoint.point).addScaledVector(n, 0.06);
          const impactSpeed = g.vel.length();
          if (n.y > 0.55 || impactSpeed < 3.5) {
            g.vel.set(0, 0, 0);
            g.settled = true;
          } else {
            const vn = n.clone().multiplyScalar(g.vel.dot(n));
            g.vel.sub(vn).addScaledVector(n, -vn.length() * 0.25);
            g.vel.multiplyScalar(0.55);
          }
        } else {
          g.mesh.position.copy(this._grenadeNext);
        }
        g.mesh.rotation.x += delta * 8;
        g.mesh.rotation.z += delta * 5;
      }

      if (g.fuse <= 0) {
        const boomPos = g.mesh.position.clone();
        if (g.kind === 'smoke') {
          this._spawnSmokeCloud(boomPos, !!g.fromRemote);
        } else {
          try {
            this._ensureAudio();
            if (typeof this.audio.playExplosion === 'function') {
              this.audio.playExplosion();
            }
          } catch (err) {
            console.error(err);
          }
          try {
            this.impacts.explodeAt(boomPos, 4.0);
          } catch (err) {
            console.error(err);
          }
          if (!g.fromRemote && this.net?.inMatch) {
            this.net.resolveGrenadeExplosion(boomPos);
          }
        }
        this.scene.remove(g.mesh);
        g.mesh.traverse((c) => {
          if (c.geometry) c.geometry.dispose?.();
          if (c.material) {
            if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose?.());
            else c.material.dispose?.();
          }
        });
        this.liveGrenades.splice(i, 1);
      }
    }
  }

  update(delta, player, aimDir, cameraPos, camera = null) {
    this._playerRef = player || null;
    this._camera = camera || this._camera || null;

    // Tracer cleanup always runs (even before models ready / while paused) so lines
    // never freeze on screen for the rest of a match.
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      tr.life -= delta;
      if (tr.muzzleSprite && tr.mesh?.material) {
        tr.mesh.material.opacity = Math.max(0, tr.life * 12);
        tr.mesh.scale.multiplyScalar(1 + delta * 8);
      }
      if (!Number.isFinite(tr.life) || tr.life <= 0) {
        this.scene.remove(tr.mesh);
        tr.mesh.geometry.dispose();
        if (tr.mesh.material && tr.muzzleSprite) tr.mesh.material.dispose();
        this.tracers.splice(i, 1);
      }
    }

    if (!this.ready) return;

    if (this.reloading) {
      this.reloadTimer -= delta;
      if (this.reloadTimer <= 0) this._finishReload();
    }

    this.actionCooldown = Math.max(0, this.actionCooldown - delta);
    this.muzzleFlashT = Math.max(0, this.muzzleFlashT - delta);
    if (this._remoteMuzzleT > 0) {
      this._remoteMuzzleT = Math.max(0, this._remoteMuzzleT - delta);
      if (this._remoteMuzzleT <= 0 && this.muzzleLight) {
        this.muzzleLight.intensity = 0;
      }
    }

    this._aimDirRef = aimDir || null;
    this._cameraPos = cameraPos || null;
    if (!this.paused) {
      this._computeFireToCrosshair(cameraPos, aimDir, player);
    }
    this.impacts.update(performance.now() * 0.001, delta);
    this._updateGrenades(delta);
    this._updateSmokes(delta, this._camera);
    this._updateRemoteFlames(delta);

    if (this.paused) return;

    if (this.currentId === 'machinegun' && this.lmbHeld && this._canShootNow() && !this.reloading) {
      this._fireMachinegun(player, cameraPos);
    }
    if (this.currentId === 'shotgun' && this.lmbHeld && this._canShootNow() && !this.reloading) {
      this._fireShotgun(player, cameraPos);
    }

    if (this.currentId === 'flamethrower') {
      const wantsFire = this.lmbHeld && this._canShootNow() && !this.reloading;
      const canFire = wantsFire && this._canUseAmmo('flamethrower');
      if (wantsFire && !canFire) this._startReload('flamethrower', true);

      const firing = wantsFire && canFire;
      if (firing) {
        this._consumeFlame(delta);
        this.impacts.applyFlame(
          this._muzzleWorld,
          this._forward,
          FLAME_RANGE,
          FLAME_HALF_ANGLE,
        );
        if (this.net?.inMatch) {
          this.net.tryFlameTick(this._muzzleWorld, this._forward, delta);
        }
      }

      if (firing !== this._flameWasFiring) {
        this._ensureAudio();
        this.audio.setFlamethrowerFiring(firing);
        this._flameWasFiring = firing;
      }

      this.flame.setFiring(firing);
      this.flame.update(delta, this._muzzleWorld, this._forward);
      this._updateMuzzleLight(firing, 0xff7722, 2.2 + Math.random());
    } else {
      if (this._flameWasFiring) {
        this.audio.setFlamethrowerFiring(false);
        this._flameWasFiring = false;
      }
      if (this.currentId === 'machinegun' || this.currentId === 'sniper' || this.currentId === 'shotgun') {
        this.flame.setFiring(false);
        this._updateMuzzleLight(
          this.muzzleFlashT > 0,
          0xffcc66,
          this.currentId === 'sniper' ? 5 : 3.5,
        );
      } else {
        this.flame.setFiring(false);
        this._updateMuzzleLight(false, 0xffcc66, 0);
      }
    }

    if (this.currentId === 'melee' && this.swinging) {
      this.swingT += delta;
      const dur = 0.32;
      const t = Math.min(1, this.swingT / dur);
      const arc = t < 0.45
        ? THREE.MathUtils.smoothstep(t / 0.45, 0, 1)
        : 1 - THREE.MathUtils.smoothstep((t - 0.45) / 0.55, 0, 1);
      this.slots.melee.rotation.x = -arc * 1.35;
      this.slots.melee.rotation.y = arc * 0.55;
      this.slots.melee.rotation.z = -arc * 0.9;
      if (!this._meleeHitSent && t >= 0.4 && this.net?.inMatch) {
        this._meleeHitSent = true;
        this.net.tryMelee(this._muzzleWorld, this._forward);
      }
      if (t >= 1) {
        this.swinging = false;
        this.swingT = 0;
        this.slots.melee.rotation.set(0, 0, 0);
      }
    }
  }

  dispose() {
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('mousedown', this._onDown);
    window.removeEventListener('mouseup', this._onUp);
    window.removeEventListener('keydown', this._onKeyDown);
    this.audio.stopAll();
    this.scene.remove(this.muzzleLight);
    this.flame.dispose();
    for (const [, e] of this.remoteFlames) e.cone.dispose();
    this.remoteFlames.clear();
  }
}

export { WEAPON_LABELS, WEAPON_FLAGS };
