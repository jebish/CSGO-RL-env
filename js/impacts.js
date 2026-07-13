import * as THREE from 'three';

const MAX_BULLET_HOLES = 120;
const MAX_SCORCHES = 64;
const SCORCH_FADE_SEC = 8;
const SCORCH_MERGE_DIST = 0.55;
const SCORCH_RADIUS = 0.42;
const HOLE_SIZE = 0.07;

function createBulletHoleTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(12, 10, 8, 1)');
  g.addColorStop(0.35, 'rgba(28, 22, 18, 0.95)');
  g.addColorStop(0.7, 'rgba(40, 32, 28, 0.45)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // crack chips
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * Math.PI * 2 + Math.random() * 0.4;
    ctx.beginPath();
    ctx.moveTo(size / 2, size / 2);
    ctx.lineTo(size / 2 + Math.cos(a) * 18, size / 2 + Math.sin(a) * 18);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createScorchTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  const g = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(8, 6, 5, 0.92)');
  g.addColorStop(0.4, 'rgba(22, 14, 10, 0.75)');
  g.addColorStop(0.75, 'rgba(40, 28, 18, 0.35)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // soot speckles
  for (let i = 0; i < 40; i += 1) {
    const x = size * 0.2 + Math.random() * size * 0.6;
    const y = size * 0.2 + Math.random() * size * 0.6;
    const r = 1 + Math.random() * 3;
    ctx.fillStyle = `rgba(0,0,0,${0.15 + Math.random() * 0.25})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class ImpactSystem {
  constructor(scene) {
    this.scene = scene;
    this.meshes = [];
    this.raycaster = new THREE.Raycaster();
    this.origin = new THREE.Vector3();
    this.dir = new THREE.Vector3();
    this.normal = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.up = new THREE.Vector3(0, 0, 1);

    this.holeTex = createBulletHoleTexture();
    this.scorchTex = createScorchTexture();
    this.holeMat = new THREE.MeshBasicMaterial({
      map: this.holeTex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.scorchGeo = new THREE.CircleGeometry(SCORCH_RADIUS, 20);

    this.holes = [];
    this.holeCursor = 0;
    this.scorches = [];

    this._sampleDirs = [];
    for (let i = 0; i < 7; i += 1) {
      this._sampleDirs.push(new THREE.Vector3());
    }
  }

  setMeshes(meshes) {
    this.meshes = meshes || [];
  }

  _orientDecal(mesh, point, normal) {
    this.normal.copy(normal).normalize();
    mesh.position.copy(point).addScaledVector(this.normal, 0.012);
    this.quat.setFromUnitVectors(this.up, this.normal);
    mesh.quaternion.copy(this.quat);
  }

  addBulletHole(point, normal) {
    let entry = this.holes[this.holeCursor];
    if (!entry) {
      const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(HOLE_SIZE, 10),
        this.holeMat,
      );
      mesh.renderOrder = 2;
      this.scene.add(mesh);
      entry = { mesh };
      this.holes[this.holeCursor] = entry;
    }
    this.holeCursor = (this.holeCursor + 1) % MAX_BULLET_HOLES;
    entry.mesh.visible = true;
    this._orientDecal(entry.mesh, point, normal);
    const s = 0.85 + Math.random() * 0.4;
    entry.mesh.scale.setScalar(s);
  }

  /**
   * Raycast a shot and stamp a hole on the first map hit.
   * Returns hit point or null.
   */
  raycastBullet(origin, direction, maxDist = 80) {
    if (!this.meshes.length) return null;
    this.raycaster.set(origin, direction);
    this.raycaster.far = maxDist;
    const hits = this.raycaster.intersectObjects(this.meshes, false);
    if (!hits.length) return null;
    const hit = hits[0];
    if (hit.face) {
      this.normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
    } else {
      this.normal.set(0, 1, 0);
    }
    this.addBulletHole(hit.point, this.normal);
    return hit.point;
  }

  _refreshScorch(point, normal, now) {
    // Merge with nearby existing patch — resets the 8s clock from latest burn.
    for (const s of this.scorches) {
      if (s.mesh.position.distanceToSquared(point) <= SCORCH_MERGE_DIST * SCORCH_MERGE_DIST) {
        s.lastBurn = now;
        s.mesh.visible = true;
        s.mesh.material.opacity = 0.9;
        this._orientDecal(s.mesh, point, normal);
        return;
      }
    }

    if (this.scorches.length >= MAX_SCORCHES) {
      // Reuse oldest
      this.scorches.sort((a, b) => a.lastBurn - b.lastBurn);
      const oldest = this.scorches[0];
      oldest.lastBurn = now;
      oldest.mesh.visible = true;
      oldest.mesh.material.opacity = 0.9;
      this._orientDecal(oldest.mesh, point, normal);
      return;
    }

    const mat = new THREE.MeshBasicMaterial({
      map: this.scorchTex,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(this.scorchGeo, mat);
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    this._orientDecal(mesh, point, normal);
    this.scorches.push({ mesh, lastBurn: now });
  }

  /** Sample flame cone onto the map; scorches fade 8s after the *latest* burn. */
  applyFlame(origin, forward, range, halfAngle, now = performance.now() * 0.001) {
    if (!this.meshes.length) return;

    const samples = this._sampleDirs;
    samples[0].copy(forward);
    const right = this.tmp.crossVectors(forward, this.worldUp || (this.worldUp = new THREE.Vector3(0, 1, 0)));
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = this.dir.crossVectors(right, forward).normalize();

    const spread = Math.tan(halfAngle);
    for (let i = 1; i < samples.length; i += 1) {
      const a = (i / (samples.length - 1)) * Math.PI * 2;
      const r = spread * (0.35 + 0.65 * ((i % 3) / 2));
      samples[i]
        .copy(forward)
        .addScaledVector(right, Math.cos(a) * r)
        .addScaledVector(up, Math.sin(a) * r)
        .normalize();
    }

    for (const sample of samples) {
      this.raycaster.set(origin, sample);
      this.raycaster.far = range;
      const hits = this.raycaster.intersectObjects(this.meshes, false);
      if (!hits.length) continue;
      const hit = hits[0];
      if (hit.face) {
        this.normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
      } else {
        this.normal.set(0, 1, 0);
      }
      this._refreshScorch(hit.point, this.normal, now);
    }
  }

  update(now = performance.now() * 0.001) {
    for (const s of this.scorches) {
      const age = now - s.lastBurn;
      if (age >= SCORCH_FADE_SEC) {
        s.mesh.visible = false;
        s.mesh.material.opacity = 0;
        continue;
      }
      // Fade out over the full 8s window from latest burn.
      const t = age / SCORCH_FADE_SEC;
      s.mesh.visible = true;
      s.mesh.material.opacity = 0.9 * (1 - t) * (1 - t);
    }
  }
}
