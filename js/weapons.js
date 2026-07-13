import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WeaponAudio } from './weapon-audio.js';
import { ImpactSystem } from './impacts.js';

const WEAPON_IDS = ['gun', 'flamethrower', 'melee'];
const WEAPON_LABELS = {
  gun: 'PU-21',
  flamethrower: 'Flamethrower',
  melee: 'Pipe Wrench',
};

const HAND_POS = new THREE.Vector3(0.28, 0.72, 0.22);
const FLAME_RANGE = 5.2;
const FLAME_HALF_ANGLE = THREE.MathUtils.degToRad(18);
const FLAME_PARTICLES = 220;

const GUN_FIRE_INTERVAL = 1 / 8; // 8 rounds per second
const GUN_RECOIL_MOVING_DEG = 6;
const GUN_RECOIL_SCOPED_DEG = 4; // between stationary and moving (placeholder)
const GUN_RECOIL_STILL_DEG = 3;
const FLAME_USE_PER_SEC = 30;
/** View-left shoulder origin (screen-left), fire toward crosshair aim point. */
const FIRE_SHOULDER_Y = 1.18;
const FIRE_SHOULDER_FORWARD = 0.28;
const FIRE_VIEW_LEFT = 0.28;
const FIRE_AIM_POINT_DIST = 80;
const GUN_TRACER_LENGTH = 16;

const AMMO_CONFIG = {
  gun: { magSize: 80, reserve: 1000, reloadTime: 2 },
  flamethrower: { magSize: 200, reserve: 2500, reloadTime: 4 },
  melee: { infinite: true },
};

/** Per-weapon capability flags. */
const WEAPON_FLAGS = {
  gun: { canScope: true },
  flamethrower: { canScope: false },
  melee: { canScope: false },
};

const INFINITY = '∞';

/** Attachment / alt-part name fragments to strip from the PU-21 kit. */
const GUN_DROP_NAME_PARTS = [
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

function stripGunAttachments(root) {
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
    if (GUN_DROP_NAME_PARTS.some((p) => hay.includes(p))) {
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
    this.gunCooldown = 0;
    this.muzzleFlashT = 0;
    this._playerRef = null;
    this.gunLoaded = false;
    this.gunLoading = false;
    this.reloading = null;
    this.reloadTimer = 0;
    this._cameraPos = null;
    this._aimDirRef = null;
    this.scoping = false;

    this.ammo = {
      gun: { mag: AMMO_CONFIG.gun.magSize, reserve: AMMO_CONFIG.gun.reserve },
      flamethrower: { mag: AMMO_CONFIG.flamethrower.magSize, reserve: AMMO_CONFIG.flamethrower.reserve },
    };

    this.root = new THREE.Group();
    this.root.position.copy(HAND_POS);
    character.add(this.root);

    this.slots = {
      gun: new THREE.Group(),
      flamethrower: new THREE.Group(),
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
    let pending = 2;
    const done = () => {
      pending -= 1;
      if (pending <= 0) {
        this.ready = true;
        this._applyVisibility();
        // Load the heavy gun model after lighter weapons so map boot isn't blocked.
        this._loadGunModel();
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
  }

  _loadGunModel() {
    if (this.gunLoaded || this.gunLoading) return;
    this.gunLoading = true;

    const loader = new GLTFLoader();
    loader.load(
      'assets/gun.glb',
      (gltf) => {
        const model = gltf.scene;
        stripGunAttachments(model);
        fitWeaponModel(model, 0.95);
        model.rotation.set(0.05, Math.PI / 2, 0);
        model.position.set(0.08, 0.02, 0);
        this.slots.gun.add(model);

        const muzzle = new THREE.Object3D();
        muzzle.position.set(0.48, 0.06, 0);
        this.slots.gun.add(muzzle);
        this.gunMuzzle = muzzle;

        this.gunLoaded = true;
        this.gunLoading = false;
        this._applyVisibility();
      },
      undefined,
      (error) => {
        console.error('Failed to load gun model', error);
        this.gunLoading = false;
      },
    );
  }

  setImpactMeshes(meshes) {
    this.impacts.setMeshes(meshes);
  }

  async initAudio() {
    await this.audio.init();
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

  _consumeGunRound() {
    const state = this.ammo.gun;
    if (state.mag <= 0) return false;
    state.mag -= 1;
    this._notifyAmmo();
    if (state.mag <= 0) this._startReload('gun', true);
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
    if (!auto && this.onWeaponChange) this.onWeaponChange(`${WEAPON_LABELS[weaponId]} · reloading`);
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
    if (this.onWeaponChange) this.onWeaponChange(this.currentLabel);
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
    if (this.currentId === 'gun') this._loadGunModel();
    this._applyVisibility();
    if (this.onWeaponChange) this.onWeaponChange(this.currentLabel);
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
    if (this.currentId === 'gun') this._fireGun(this._playerRef, this._cameraPos);
  }

  _onUp(event) {
    if (event.button !== 0) return;
    this.lmbHeld = false;
  }

  _startSwing() {
    if (this.swinging) return;
    this.swinging = true;
    this.swingT = 0;
    this.audio.playMeleeSwing();
  }

  _applyGunRecoil(player) {
    if (!player) return;
    let coneDeg = GUN_RECOIL_STILL_DEG;
    if (this.scoping && this.canScope('gun')) {
      coneDeg = GUN_RECOIL_SCOPED_DEG;
    } else if (player.isMoving()) {
      coneDeg = GUN_RECOIL_MOVING_DEG;
    }
    const half = THREE.MathUtils.degToRad(coneDeg * 0.5);
    // Random kick inside a circular FOV cone (horizontal + vertical)
    const r = Math.sqrt(Math.random()) * half;
    const theta = Math.random() * Math.PI * 2;
    const yawKick = Math.cos(theta) * r;
    const pitchKick = Math.sin(theta) * r;
    player.applyRecoil(yawKick, pitchKick);
  }

  _fireGun(player, cameraPos) {
    if (!this.gunLoaded) {
      this._loadGunModel();
      return;
    }
    if (this.reloading === 'gun') return;
    if (this.gunCooldown > 0) return;
    if (!this._canUseAmmo('gun')) {
      this._startReload('gun', true);
      return;
    }

    this.gunCooldown = GUN_FIRE_INTERVAL;
    this.muzzleFlashT = 0.05;
    this._applyGunRecoil(player);
    if (!this._consumeGunRound()) return;

    // After recoil, rebuild chest→crosshair using the updated look angles.
    const aim = player
      ? player.getAimDirection(this._traceDir)
      : this._aimDirRef;
    this._computeFireToCrosshair(cameraPos || this._cameraPos, aim, player);
    this.audio.playGunShot();

    const hitPoint = this.impacts.raycastBullet(
      this._muzzleWorld,
      this._forward,
      FIRE_AIM_POINT_DIST,
    );
    if (hitPoint) {
      this._aimEnd.copy(hitPoint);
    } else {
      this._aimEnd.copy(this._muzzleWorld).addScaledVector(this._forward, GUN_TRACER_LENGTH);
    }

    const geo = new THREE.CylinderGeometry(0.01, 0.01, 1, 5);
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, this._tracerMat);
    const mid = this._muzzleWorld.clone().lerp(this._aimEnd, 0.5);
    mesh.position.copy(mid);
    mesh.scale.z = this._muzzleWorld.distanceTo(this._aimEnd);
    mesh.lookAt(this._aimEnd);
    this.scene.add(mesh);
    this.tracers.push({ mesh, life: 0.06 });
  }

  update(delta, player, aimDir, cameraPos) {
    if (!this.ready) return;
    this._playerRef = player || null;

    if (this.reloading) {
      this.reloadTimer -= delta;
      if (this.reloadTimer <= 0) this._finishReload();
    }

    this.gunCooldown = Math.max(0, this.gunCooldown - delta);
    this.muzzleFlashT = Math.max(0, this.muzzleFlashT - delta);

    this._aimDirRef = aimDir || null;
    this._cameraPos = cameraPos || null;
    this._computeFireToCrosshair(cameraPos, aimDir, player);
    this.impacts.update();

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      tr.life -= delta;
      if (tr.life <= 0) {
        this.scene.remove(tr.mesh);
        tr.mesh.geometry.dispose();
        this.tracers.splice(i, 1);
      }
    }

    if (this.currentId === 'gun' && this.lmbHeld && this._pointerLocked() && !this.reloading) {
      this._fireGun(player, cameraPos);
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
      if (this.currentId === 'gun') {
        this.flame.setFiring(false);
        this._updateMuzzleLight(this.muzzleFlashT > 0, 0xffcc66, 3.5);
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
