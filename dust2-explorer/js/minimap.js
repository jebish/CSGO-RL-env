import * as THREE from 'three';

const BAKE_RES = 128;
const MIN_WALKABLE_NORMAL_Y = 0.35;
const WALKABLE_COLOR = { r: 168, g: 148, b: 108 };
const VOID_COLOR = { r: 18, g: 18, b: 20 };
const WALL_COLOR = { r: 72, g: 64, b: 52 };
const VISIBLE_RADIUS = 38;

export function collectMapMeshes(mapRoot) {
  const meshes = [];
  mapRoot.traverse((child) => {
    if (!child.isMesh) return;
    if (!child.geometry?.isBufferGeometry) return;
    if (!child.geometry.getAttribute('position')?.count) return;
    meshes.push(child);
  });
  return meshes;
}

export class Minimap {
  constructor(container, canvas) {
    this.container = container;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.size = 148;
    this.canvas.width = this.size;
    this.canvas.height = this.size;
    this.baked = null;
    this.bounds = null;
    this.ready = false;
    this.frozenMapYaw = 0;
    this._normal = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._raycaster = new THREE.Raycaster();
  }

  _isWalkableHit(hit) {
    if (!hit.face) return true;
    this._normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    return this._normal.y >= MIN_WALKABLE_NORMAL_Y;
  }

  bake(meshes, box) {
    const minX = box.min.x;
    const maxX = box.max.x;
    const minZ = box.min.z;
    const maxZ = box.max.z;
    const worldW = maxX - minX;
    const worldH = maxZ - minZ;

    const baked = document.createElement('canvas');
    baked.width = BAKE_RES;
    baked.height = BAKE_RES;
    const bctx = baked.getContext('2d');
    const image = bctx.createImageData(BAKE_RES, BAKE_RES);
    const data = image.data;

    const down = new THREE.Vector3(0, -1, 0);
    const rayTop = box.max.y + 60;
    const raycaster = this._raycaster;
    const origin = this._origin;

    for (let py = 0; py < BAKE_RES; py += 1) {
      for (let px = 0; px < BAKE_RES; px += 1) {
        const wx = minX + (px + 0.5) / BAKE_RES * worldW;
        const wz = minZ + (py + 0.5) / BAKE_RES * worldH;
        origin.set(wx, rayTop, wz);
        raycaster.set(origin, down);
        raycaster.far = rayTop - box.min.y + 20;
        const hits = raycaster.intersectObjects(meshes, false);

        let lowestWalkable = null;
        let hasSolid = false;

        for (const hit of hits) {
          hasSolid = true;
          if (this._isWalkableHit(hit)) {
            if (lowestWalkable === null || hit.point.y < lowestWalkable) {
              lowestWalkable = hit.point.y;
            }
          }
        }

        const i = (py * BAKE_RES + px) * 4;
        let color;
        if (lowestWalkable !== null) {
          color = WALKABLE_COLOR;
        } else if (hasSolid) {
          color = WALL_COLOR;
        } else {
          color = VOID_COLOR;
        }

        data[i] = color.r;
        data[i + 1] = color.g;
        data[i + 2] = color.b;
        data[i + 3] = 255;
      }
    }

    bctx.putImageData(image, 0, 0);
    this.baked = baked;
    this.bounds = { minX, maxX, minZ, maxZ, worldW, worldH };
    this.ready = true;
    this.container.hidden = false;
  }

  _applyMapTransform(ctx, cx, cy, scale, playerX, playerZ, mapYaw) {
    const cos = Math.cos(mapYaw);
    const sin = Math.sin(mapYaw);
    ctx.setTransform(
      -scale * cos,
      -scale * sin,
      scale * sin,
      -scale * cos,
      cx + scale * (playerX * cos - playerZ * sin),
      cy + scale * (playerX * sin + playerZ * cos),
    );
  }

  _drawNorthBadge(ctx, scale) {
    const { minX, maxX, maxZ } = this.bounds;
    const northX = (minX + maxX) * 0.5;
    const northZ = maxZ - 1.5;
    const badgeR = 1.6;

    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(northX, northZ, badgeR, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.2 / scale;
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = `bold ${9 / scale}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', northX, northZ);
  }

  _drawPlayerTriangle(ctx, cx, cy, rotation) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(-5.5, 5);
    ctx.lineTo(5.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  draw(playerX, playerZ, cameraYaw, characterYaw, mouseLookActive) {
    if (!this.ready) return;

    if (mouseLookActive) {
      this.frozenMapYaw = cameraYaw;
    }

    const mapYaw = mouseLookActive ? cameraYaw : this.frozenMapYaw;
    const triangleRotation = mouseLookActive ? 0 : characterYaw - this.frozenMapYaw;

    const ctx = this.ctx;
    const size = this.size;
    const cx = size * 0.5;
    const cy = size * 0.5;
    const radius = size * 0.5 - 3;
    const { minX, minZ, worldW, worldH } = this.bounds;
    const scale = radius / VISIBLE_RADIUS;

    ctx.clearRect(0, 0, size, size);
    ctx.save();

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, size, size);

    this._applyMapTransform(ctx, cx, cy, scale, playerX, playerZ, mapYaw);
    ctx.drawImage(this.baked, minX, minZ, worldW, worldH);
    this._drawNorthBadge(ctx, scale);

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    this._drawPlayerTriangle(ctx, cx, cy, triangleRotation);

    ctx.restore();
  }
}
