import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
const GUN_RECOIL_STILL_DEG = 3;

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
    this.lmbHeld = false;
    this.swingT = 0;
    this.swinging = false;
    this.gunCooldown = 0;
    this.muzzleFlashT = 0;

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
    this.muzzleLight = new THREE.PointLight(0xffcc66, 0, 4, 2);
    this.root.add(this.muzzleLight);

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
    this._onWheel = this._onWheel.bind(this);
    this._onDown = this._onDown.bind(this);
    this._onUp = this._onUp.bind(this);

    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('mousedown', this._onDown);
    window.addEventListener('mouseup', this._onUp);
    window.addEventListener('blur', () => {
      this.lmbHeld = false;
    });

    this._loadModels();
  }

  _loadModels() {
    const loader = new GLTFLoader();
    const gun = createProceduralGun();
    this.slots.gun.add(gun);
    this.gunMuzzle = gun.userData.muzzle;

    let pending = 2;
    const done = () => {
      pending -= 1;
      if (pending <= 0) {
        this.ready = true;
        this._applyVisibility();
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

  get currentId() {
    return WEAPON_IDS[this.index];
  }

  get currentLabel() {
    return WEAPON_LABELS[this.currentId];
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
    this._applyVisibility();
    if (this.onWeaponChange) this.onWeaponChange(this.currentLabel);
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
    if (this.currentId === 'gun') this._fireGun();
  }

  _onUp(event) {
    if (event.button !== 0) return;
    this.lmbHeld = false;
  }

  _startSwing() {
    if (this.swinging) return;
    this.swinging = true;
    this.swingT = 0;
  }

  _fireGun() {
    if (this.gunCooldown > 0) return;
    this.gunCooldown = 0.22;
    this.muzzleFlashT = 0.07;

    const yaw = this.character.rotation.y;
    this._forward.set(Math.sin(yaw), 0, Math.cos(yaw));

    const muzzle = this.gunMuzzle || this.root;
    muzzle.getWorldPosition(this._muzzleWorld);
    this._aimEnd.copy(this._muzzleWorld).addScaledVector(this._forward, 18);

    const geo = new THREE.CylinderGeometry(0.012, 0.012, 1, 5);
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, this._tracerMat);
    const mid = this._muzzleWorld.clone().lerp(this._aimEnd, 0.5);
    mesh.position.copy(mid);
    mesh.scale.z = this._muzzleWorld.distanceTo(this._aimEnd);
    mesh.lookAt(this._aimEnd);
    this.scene.add(mesh);
    this.tracers.push({ mesh, life: 0.08 });
  }

  update(delta, characterYaw) {
    if (!this.ready) return;

    this.gunCooldown = Math.max(0, this.gunCooldown - delta);
    this.muzzleFlashT = Math.max(0, this.muzzleFlashT - delta);

    this._forward.set(Math.sin(characterYaw), 0, Math.cos(characterYaw));

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      tr.life -= delta;
      if (tr.life <= 0) {
        this.scene.remove(tr.mesh);
        tr.mesh.geometry.dispose();
        this.tracers.splice(i, 1);
      }
    }

    if (this.currentId === 'flamethrower') {
      const firing = this.lmbHeld && this._pointerLocked();
      this.flame.setFiring(firing);
      const nozzle = this.flameNozzle || this.root;
      nozzle.getWorldPosition(this._muzzleWorld);
      this.flame.update(delta, this._muzzleWorld, this._forward);
      this.muzzleLight.position.set(0.2, 0.05, 0);
      this.muzzleLight.intensity = firing ? 2.2 + Math.random() : 0;
      this.muzzleLight.color.setHex(0xff7722);
    } else if (this.currentId === 'gun') {
      this.flame.setFiring(false);
      this.muzzleLight.position.set(0.22, 0.05, 0);
      this.muzzleLight.color.setHex(0xffcc66);
      this.muzzleLight.intensity = this.muzzleFlashT > 0 ? 3.5 : 0;
    } else {
      this.flame.setFiring(false);
      this.muzzleLight.intensity = 0;
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
    this.flame.dispose();
  }
}

export { WEAPON_LABELS };
