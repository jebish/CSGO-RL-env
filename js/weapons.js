import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WeaponAudio } from './weapon-audio.js?v=6';
import { ImpactSystem } from './impacts.js?v=5';

const WEAPON_IDS = ['machinegun', 'sniper', 'flamethrower', 'grenade', 'melee'];
const WEAPON_LABELS = {
  machinegun: 'PU-21',
  sniper: 'Bolt Rifle',
  flamethrower: 'Flamethrower',
  grenade: 'Stick Grenade',
  melee: 'Pipe Wrench',
};

const HAND_POS = new THREE.Vector3(0.28, 0.72, 0.22);
const FLAME_RANGE = 5.2;
const FLAME_HALF_ANGLE = THREE.MathUtils.degToRad(18);
const FLAME_PARTICLES = 220;

const MACHINEGUN_FIRE_INTERVAL = 1 / 8;
const SNIPER_FIRE_INTERVAL = 2;
const GRENADE_THROW_INTERVAL = 2;
const GRENADE_FUSE = 2.5;
const GRENADE_THROW_SPEED = 14;
const GRENADE_GRAVITY = 18;

const MACHINEGUN_RECOIL_MOVING_DEG = 6;
const MACHINEGUN_RECOIL_SCOPED_DEG = 4;
const MACHINEGUN_RECOIL_STILL_DEG = 3;
const SNIPER_RECOIL_SCOPED_DEG = 5;
/** Hip FOV / scope FOV ≈ zoom. Sniper zoom = 2.5× machinegun zoom. */
const MACHINEGUN_SCOPE_FOV = 48;
const SNIPER_SCOPE_FOV = MACHINEGUN_SCOPE_FOV / 2.5;
const FLAME_USE_PER_SEC = 30;
/** View-left shoulder origin (screen-left), fire toward crosshair aim point. */
const FIRE_SHOULDER_Y = 1.18;
const FIRE_SHOULDER_FORWARD = 0.28;
const FIRE_VIEW_LEFT = 0.28;
const FIRE_AIM_POINT_DIST = 80;
const TRACER_LENGTH = 16;

const AMMO_CONFIG = {
  machinegun: { magSize: 80, reserve: 1000, reloadTime: 2 },
  sniper: { magSize: 5, reserve: 40, reloadTime: 2.5 },
  flamethrower: { magSize: 200, reserve: 2500, reloadTime: 4 },
  grenade: { magSize: 3, reserve: 12, reloadTime: 1.5 },
  melee: { infinite: true },
};

/** Per-weapon capability flags. */
const WEAPON_FLAGS = {
  machinegun: { canScope: true, requireScopeToFire: false },
  sniper: { canScope: true, requireScopeToFire: true },
  flamethrower: { canScope: false, requireScopeToFire: false },
  grenade: { canScope: false, requireScopeToFire: false },
  melee: { canScope: false, requireScopeToFire: false },
};

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
  constructor(scene) {
    this.scene = scene;
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

    this.points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        map: createFlameTexture(),
        size: 0.55,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        color: 0xffaa44,
        sizeAttenuation: true,
        opacity: 0.95,
      }),
    );
    this.points.frustumCulled = false;
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
        opacity: 0.18,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    this.core.visible = false;
    scene.add(this.core);

    const tipGeo = new THREE.SphereGeometry(0.22, 12, 12);
    this.tip = new THREE.Mesh(
      tipGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffe08a,
        transparent: true,
        opacity: 0.55,
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
    this.tip.visible = on;
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
    this.points.material.size = 0.42 + 0.2 * pulse;
    this.core.material.opacity = 0.12 + 0.1 * pulse;
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

export class WeaponSystem {
  constructor(scene, character, domElement) {
    this.scene = scene;
    this.character = character;
    this.domElement = domElement;
    this.ready = false;
    this.index = 0;
    this.onWeaponChange = null;
    this.onAmmoChange = null;
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
    this.reloading = null;
    this.reloadTimer = 0;
    this._cameraPos = null;
    this._aimDirRef = null;
    this.scoping = false;
    this.liveGrenades = [];
    this._grenadeVel = new THREE.Vector3();
    this._grenadeNext = new THREE.Vector3();

    this.ammo = {
      machinegun: { mag: AMMO_CONFIG.machinegun.magSize, reserve: AMMO_CONFIG.machinegun.reserve },
      sniper: { mag: AMMO_CONFIG.sniper.magSize, reserve: AMMO_CONFIG.sniper.reserve },
      flamethrower: { mag: AMMO_CONFIG.flamethrower.magSize, reserve: AMMO_CONFIG.flamethrower.reserve },
      grenade: { mag: AMMO_CONFIG.grenade.magSize, reserve: AMMO_CONFIG.grenade.reserve },
    };

    this.root = new THREE.Group();
    this.root.position.copy(HAND_POS);
    character.add(this.root);

    this.slots = {
      machinegun: new THREE.Group(),
      sniper: new THREE.Group(),
      flamethrower: new THREE.Group(),
      grenade: new THREE.Group(),
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
      },
      undefined,
      (error) => {
        console.error('Failed to load sniper model', error);
        this.sniperLoading = false;
      },
    );
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
    this.lmbHeld = this.lmbHeld && this.currentId === 'flamethrower';
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
    if (event.code !== 'KeyR' || event.repeat) return;
    if (!this._pointerLocked()) return;
    event.preventDefault();
    this.requestReload();
  }

  _pointerLocked() {
    return document.pointerLockElement === this.domElement;
  }

  _onWheel(event) {
    if (!this._pointerLocked()) return;
    event.preventDefault();
    if (event.deltaY < 0) this.cycle(1); // scroll up → clockwise
    else if (event.deltaY > 0) this.cycle(-1); // scroll down → anticlockwise
  }

  _onDown(event) {
    if (event.button !== 0 || !this._pointerLocked()) return;
    this.lmbHeld = true;
    if (this.currentId === 'melee') this._startSwing();
    if (this.currentId === 'machinegun') this._fireMachinegun(this._playerRef, this._cameraPos);
    if (this.currentId === 'sniper') this._fireSniper(this._playerRef, this._cameraPos);
    if (this.currentId === 'grenade') this._throwGrenade(this._playerRef, this._cameraPos);
  }

  _onUp(event) {
    if (event.button !== 0) return;
    this.lmbHeld = false;
  }

  _startSwing() {
    if (this.swinging) return;
    this.swinging = true;
    this.swingT = 0;
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
    const half = THREE.MathUtils.degToRad(coneDeg * 0.5);
    const r = Math.sqrt(Math.random()) * half;
    const theta = Math.random() * Math.PI * 2;
    player.applyRecoil(Math.cos(theta) * r, Math.sin(theta) * r);
  }

  _spawnTracer(from, to, life = 0.06) {
    const geo = new THREE.CylinderGeometry(0.01, 0.01, 1, 5);
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
    this._applyBallisticRecoil(player, recoil);
    if (!this._consumeRound(weaponId)) return;

    const aim = player ? player.getAimDirection(this._traceDir) : this._aimDirRef;
    this._computeFireToCrosshair(cameraPos || this._cameraPos, aim, player);
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
    else this._aimEnd.copy(this._muzzleWorld).addScaledVector(this._forward, TRACER_LENGTH);
    this._spawnTracer(this._muzzleWorld, this._aimEnd, weaponId === 'sniper' ? 0.1 : 0.06);
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
        movingDeg: SNIPER_RECOIL_SCOPED_DEG,
        scopedDeg: SNIPER_RECOIL_SCOPED_DEG,
        stillDeg: SNIPER_RECOIL_SCOPED_DEG,
        scopedOnly: true,
      },
      playShot: () => this.audio.playSniperShot(),
    });
  }

  _throwGrenade(player, cameraPos) {
    if (!this.grenadeLoaded) return;
    if (this.reloading === 'grenade') return;
    if (this.actionCooldown > 0) return;
    if (!this._canUseAmmo('grenade')) {
      this._startReload('grenade', true);
      return;
    }

    this.actionCooldown = GRENADE_THROW_INTERVAL;
    if (!this._consumeRound('grenade')) return;
    this._ensureAudio();

    const aim = player ? player.getAimDirection(this._traceDir) : this._aimDirRef;
    this._computeFireToCrosshair(cameraPos || this._cameraPos, aim, player);

    const root = new THREE.Group();
    if (this.grenadePrototype) {
      const body = this.grenadePrototype.clone(true);
      body.position.set(0, 0, 0);
      body.rotation.set(0, 0, 0);
      body.scale.multiplyScalar(1.05);
      root.add(body);
    } else {
      root.add(new THREE.Mesh(
        new THREE.CylinderGeometry(0.028, 0.032, 0.16, 10),
        new THREE.MeshStandardMaterial({ color: 0x3f4f32, metalness: 0.45, roughness: 0.5 }),
      ));
    }

    // Lit fuse tip + spark emitter (small — stick grenade, not a torch)
    const fuseTip = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffaa33 }),
    );
    fuseTip.position.set(0, 0.14, 0);
    root.add(fuseTip);

    const fuseLight = new THREE.PointLight(0xff6622, 0.7, 1.6, 2);
    fuseLight.position.copy(fuseTip.position);
    root.add(fuseLight);

    const sparkGeo = new THREE.BufferGeometry();
    const sparkCount = 12;
    const sparkPos = new Float32Array(sparkCount * 3);
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
    const sparks = new THREE.Points(
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
      fuseTip,
      fuseLight,
      sparks,
      sparkPos,
      sparkAge: new Float32Array(sparkCount),
    });
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
        try {
          this._ensureAudio();
          if (typeof this.audio.playExplosion === 'function') {
            this.audio.playExplosion();
          }
        } catch (err) {
          console.error(err);
        }
        try {
          this.impacts.explodeAt(g.mesh.position.clone(), 4.0);
        } catch (err) {
          console.error(err);
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

  update(delta, player, aimDir, cameraPos) {
    if (!this.ready) return;
    this._playerRef = player || null;

    if (this.reloading) {
      this.reloadTimer -= delta;
      if (this.reloadTimer <= 0) this._finishReload();
    }

    this.actionCooldown = Math.max(0, this.actionCooldown - delta);
    this.muzzleFlashT = Math.max(0, this.muzzleFlashT - delta);

    this._aimDirRef = aimDir || null;
    this._cameraPos = cameraPos || null;
    this._computeFireToCrosshair(cameraPos, aimDir, player);
    this.impacts.update(performance.now() * 0.001, delta);
    this._updateGrenades(delta);

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      tr.life -= delta;
      if (tr.life <= 0) {
        this.scene.remove(tr.mesh);
        tr.mesh.geometry.dispose();
        this.tracers.splice(i, 1);
      }
    }

    if (this.currentId === 'machinegun' && this.lmbHeld && this._pointerLocked() && !this.reloading) {
      this._fireMachinegun(player, cameraPos);
    }

    if (this.currentId === 'flamethrower') {
      const wantsFire = this.lmbHeld && this._pointerLocked() && !this.reloading;
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
      if (this.currentId === 'machinegun' || this.currentId === 'sniper') {
        this.flame.setFiring(false);
        this._updateMuzzleLight(this.muzzleFlashT > 0, 0xffcc66, this.currentId === 'sniper' ? 5 : 3.5);
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
  }
}

export { WEAPON_LABELS, WEAPON_FLAGS };
