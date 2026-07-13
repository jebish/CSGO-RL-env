import * as THREE from 'three';

const MAX_BULLET_HOLES = 120;
const MAX_SCORCHES = 64;
const MAX_EXPLOSION_MARKS = 40;
const SCORCH_FADE_SEC = 8;
const SCORCH_MERGE_DIST = 0.55;
const SCORCH_RADIUS = 0.42;
const HOLE_SIZE = 0.07;
const EXPLOSION_MARK_RADIUS = 1.35;

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

function createExplosionMarkTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  const g = ctx.createRadialGradient(size / 2, size / 2, 8, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(6, 4, 3, 0.95)');
  g.addColorStop(0.25, 'rgba(18, 10, 6, 0.85)');
  g.addColorStop(0.55, 'rgba(35, 22, 12, 0.45)');
  g.addColorStop(0.8, 'rgba(50, 35, 20, 0.18)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 10; i += 1) {
    const a = (i / 10) * Math.PI * 2 + Math.random() * 0.3;
    const len = 40 + Math.random() * 55;
    ctx.beginPath();
    ctx.moveTo(size / 2, size / 2);
    ctx.lineTo(size / 2 + Math.cos(a) * len, size / 2 + Math.sin(a) * len);
    ctx.stroke();
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
    this.explosionMarkTex = createExplosionMarkTexture();
    this.holeMat = new THREE.MeshBasicMaterial({
      map: this.holeTex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.scorchGeo = new THREE.CircleGeometry(SCORCH_RADIUS, 20);
    this.explosionMarkGeo = new THREE.CircleGeometry(EXPLOSION_MARK_RADIUS, 24);

    this.holes = [];
    this.holeCursor = 0;
    this.scorches = [];
    this.explosionMarks = [];
    this.explosionMarkCursor = 0;
    this.explosions = [];

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

  _addExplosionMark(point, normal) {
    let entry = this.explosionMarks[this.explosionMarkCursor];
    if (!entry) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.explosionMarkTex,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(this.explosionMarkGeo, mat);
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      entry = { mesh };
      this.explosionMarks[this.explosionMarkCursor] = entry;
    }
    this.explosionMarkCursor = (this.explosionMarkCursor + 1) % MAX_EXPLOSION_MARKS;
    entry.mesh.visible = true;
    entry.mesh.material.opacity = 0.92;
    this._orientDecal(entry.mesh, point, normal);
    entry.mesh.scale.setScalar(0.85 + Math.random() * 0.4);
  }

  /**
   * Visual explosion burst + lasting crater mark on nearby ground.
   * Returns ground point used for the leftover mark (or explosion center).
   */
  explodeAt(center, radius = 2.8) {
    const root = new THREE.Group();
    root.position.copy(center);
    this.scene.add(root);

    // Bright core fireball
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xfff2c8,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 16), coreMat);
    root.add(core);

    // Hot outer fire shell
    const fireMat = new THREE.MeshBasicMaterial({
      color: 0xff6a1a,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const fire = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 16), fireMat);
    root.add(fire);

    // Shockwave ring (flat disc that expands)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffcc88,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.55, 32), ringMat);
    ring.rotation.x = -Math.PI / 2;
    root.add(ring);

    const light = new THREE.PointLight(0xff8a2a, 22, radius * 4.5, 1.6);
    root.add(light);

    // Flying embers / debris sparks
    const emberCount = 48;
    const emberPos = new Float32Array(emberCount * 3);
    const emberVel = [];
    for (let i = 0; i < emberCount; i += 1) {
      emberPos[i * 3] = 0;
      emberPos[i * 3 + 1] = 0;
      emberPos[i * 3 + 2] = 0;
      const dir = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() * 0.85 + 0.15,
        Math.random() - 0.5,
      ).normalize();
      emberVel.push(dir.multiplyScalar(4 + Math.random() * 9));
    }
    const emberGeo = new THREE.BufferGeometry();
    emberGeo.setAttribute('position', new THREE.BufferAttribute(emberPos, 3));
    const embers = new THREE.Points(
      emberGeo,
      new THREE.PointsMaterial({
        color: 0xffaa44,
        size: 0.12,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 1,
      }),
    );
    embers.frustumCulled = false;
    root.add(embers);

    // Thick smoke columns
    const smokeMat = new THREE.MeshBasicMaterial({
      color: 0x2c2824,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    const smokes = [];
    for (let i = 0; i < 12; i += 1) {
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(0.35 + Math.random() * 0.45, 10, 10),
        smokeMat.clone(),
      );
      puff.position.set(
        (Math.random() - 0.5) * 1.1,
        Math.random() * 0.35,
        (Math.random() - 0.5) * 1.1,
      );
      root.add(puff);
      smokes.push({
        mesh: puff,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 1.6,
          1.8 + Math.random() * 2.4,
          (Math.random() - 0.5) * 1.6,
        ),
      });
    }

    this.explosions.push({
      root,
      core,
      fire,
      ring,
      light,
      embers,
      emberPos,
      emberVel,
      smokes,
      age: 0,
      life: 1.15,
      radius,
    });

    // Ground leftover mark
    this.origin.copy(center).y += 4;
    this.raycaster.set(this.origin, new THREE.Vector3(0, -1, 0));
    this.raycaster.far = 12;
    const hits = this.meshes.length
      ? this.raycaster.intersectObjects(this.meshes, false)
      : [];
    if (hits.length) {
      const hit = hits[0];
      if (hit.face) {
        this.normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
      } else {
        this.normal.set(0, 1, 0);
      }
      this._addExplosionMark(hit.point, this.normal);
      return hit.point;
    }

    this.normal.set(0, 1, 0);
    const fallback = center.clone();
    fallback.y -= 0.05;
    this._addExplosionMark(fallback, this.normal);
    return fallback;
  }

  update(now = performance.now() * 0.001, delta = 1 / 60) {
    for (const s of this.scorches) {
      const age = now - s.lastBurn;
      if (age >= SCORCH_FADE_SEC) {
        s.mesh.visible = false;
        s.mesh.material.opacity = 0;
        continue;
      }
      const t = age / SCORCH_FADE_SEC;
      s.mesh.visible = true;
      s.mesh.material.opacity = 0.9 * (1 - t) * (1 - t);
    }

    for (let i = this.explosions.length - 1; i >= 0; i -= 1) {
      const ex = this.explosions[i];
      ex.age += delta;
      const t = Math.min(1, ex.age / ex.life);
      const early = Math.min(1, ex.age / 0.18);

      // Fireball expands fast then fades
      const fireScale = 1 + early * 3.2 + t * 2.4;
      ex.core.scale.setScalar(fireScale * 0.85);
      ex.fire.scale.setScalar(fireScale * 1.15);
      ex.core.material.opacity = (1 - t) * (1 - t);
      ex.fire.material.opacity = 0.9 * (1 - t) * (1 - early * 0.35);

      // Shock ring races outward
      const ringR = 0.4 + t * ex.radius * 1.35;
      ex.ring.scale.set(ringR, ringR, 1);
      ex.ring.material.opacity = 0.7 * (1 - t) * (1 - t);

      ex.light.intensity = 22 * (1 - t) * (1 - t * 0.4);

      // Embers
      const arr = ex.emberPos;
      for (let e = 0; e < ex.emberVel.length; e += 1) {
        const v = ex.emberVel[e];
        v.y -= 14 * delta;
        arr[e * 3] += v.x * delta;
        arr[e * 3 + 1] += v.y * delta;
        arr[e * 3 + 2] += v.z * delta;
      }
      ex.embers.geometry.attributes.position.needsUpdate = true;
      ex.embers.material.opacity = Math.max(0, 1 - t * 1.35);
      ex.embers.material.size = 0.12 * (1 - t * 0.6);

      for (const smoke of ex.smokes) {
        smoke.mesh.position.addScaledVector(smoke.vel, delta);
        smoke.vel.y -= 1.4 * delta;
        smoke.mesh.scale.multiplyScalar(1 + delta * 1.6);
        smoke.mesh.material.opacity = 0.72 * (1 - t);
      }

      if (t >= 1) {
        this.scene.remove(ex.root);
        ex.root.traverse((c) => {
          if (c.geometry) c.geometry.dispose?.();
          if (c.material) {
            if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose?.());
            else c.material.dispose?.();
          }
        });
        this.explosions.splice(i, 1);
      }
    }
  }
}
