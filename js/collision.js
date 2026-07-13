import * as THREE from 'three';

export const PLAYER_HEIGHT = 1.31;
export const PLAYER_RADIUS = 0.235;
/** Keep soles slightly above walkable surfaces so ankle rays don't dig into floors. */
const GROUND_SKIN = 0.04;
const GROUND_SNAP = 0.14;
const MIN_WALKABLE_NORMAL_Y = 0.45;
const DROP_HEIGHT = 45;
const SPAWN_INSET_X = 22;
const SPAWN_INSET_Z = 20;
const BOUNDS_INSET = 1.2;
const BOUNDS_WALL_THICKNESS = 1.5;
/** Lowest body probe — above typical floor bumps so flats don't register as walls. */
const BODY_PROBE_MIN_Y = 0.42;

const HORIZONTAL_DIRS = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(0.707, 0, 0.707),
  new THREE.Vector3(-0.707, 0, 0.707),
  new THREE.Vector3(0.707, 0, -0.707),
  new THREE.Vector3(-0.707, 0, -0.707),
];

function getHitWorldNormal(hit, target = new THREE.Vector3()) {
  if (!hit.face) return target.set(0, 1, 0);
  return target.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
}

function isWalkableHit(hit) {
  return getHitWorldNormal(hit).y >= MIN_WALKABLE_NORMAL_Y;
}

export function setupMapCollision(mapRoot) {
  mapRoot.updateMatrixWorld(true);

  const meshes = [];
  mapRoot.traverse((child) => {
    if (!child.isMesh) return;
    if (!child.geometry?.isBufferGeometry) return;
    if (!child.geometry.getAttribute('position')?.count) return;
    meshes.push(child);
  });

  if (meshes.length === 0) {
    throw new Error('No mesh geometry found in map');
  }

  const boundsMeshes = createInvisibleBounds(mapRoot);
  meshes.push(...boundsMeshes);

  return meshes;
}

function createInvisibleBounds(mapRoot) {
  const box = new THREE.Box3().setFromObject(mapRoot);
  const wallHeight = box.max.y - box.min.y + 30;
  const centerY = box.min.y + wallHeight * 0.5;
  const material = new THREE.MeshBasicMaterial({ visible: false });
  const walls = [];

  const configs = [
    {
      size: [BOUNDS_WALL_THICKNESS, wallHeight, box.max.z - box.min.z + BOUNDS_WALL_THICKNESS * 2],
      pos: [box.min.x + BOUNDS_INSET, centerY, (box.min.z + box.max.z) * 0.5],
    },
    {
      size: [BOUNDS_WALL_THICKNESS, wallHeight, box.max.z - box.min.z + BOUNDS_WALL_THICKNESS * 2],
      pos: [box.max.x - BOUNDS_INSET, centerY, (box.min.z + box.max.z) * 0.5],
    },
    {
      size: [box.max.x - box.min.x + BOUNDS_WALL_THICKNESS * 2, wallHeight, BOUNDS_WALL_THICKNESS],
      pos: [(box.min.x + box.max.x) * 0.5, centerY, box.min.z + BOUNDS_INSET],
    },
    {
      size: [box.max.x - box.min.x + BOUNDS_WALL_THICKNESS * 2, wallHeight, BOUNDS_WALL_THICKNESS],
      pos: [(box.min.x + box.max.x) * 0.5, centerY, box.max.z - BOUNDS_INSET],
    },
  ];

  for (const cfg of configs) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...cfg.size), material);
    mesh.position.set(...cfg.pos);
    mesh.updateMatrixWorld(true);
    walls.push(mesh);
  }

  return walls;
}

export function dropSpawnFromCorner(mapRoot, collisionWorld) {
  const box = new THREE.Box3().setFromObject(mapRoot);
  const candidates = [
    [box.min.x + SPAWN_INSET_X, box.min.z + SPAWN_INSET_Z],
    [box.min.x + SPAWN_INSET_X + 4, box.min.z + SPAWN_INSET_Z + 2],
    [box.min.x + SPAWN_INSET_X + 2, box.min.z + SPAWN_INSET_Z + 6],
    [box.min.x + SPAWN_INSET_X + 8, box.min.z + SPAWN_INSET_Z + 4],
  ];

  let best = null;
  let lowestY = Infinity;

  for (const [x, z] of candidates) {
    const feet = collisionWorld.dropToGround(x, z, box);
    if (feet.y < lowestY) {
      lowestY = feet.y;
      best = feet;
    }
  }

  return best ?? collisionWorld.dropToGround(
    box.min.x + SPAWN_INSET_X,
    box.min.z + SPAWN_INSET_Z,
    box,
  );
}

export class CollisionWorld {
  constructor(meshes) {
    this.meshes = meshes;
    this.raycaster = new THREE.Raycaster();
    this.down = new THREE.Vector3(0, -1, 0);
    this.origin = new THREE.Vector3();
    this.bounds = null;
  }

  setBounds(box) {
    this.bounds = {
      minX: box.min.x + BOUNDS_INSET + PLAYER_RADIUS,
      maxX: box.max.x - BOUNDS_INSET - PLAYER_RADIUS,
      minZ: box.min.z + BOUNDS_INSET + PLAYER_RADIUS,
      maxZ: box.max.z - BOUNDS_INSET - PLAYER_RADIUS,
    };
  }

  clampToBounds(feet) {
    if (!this.bounds) return;
    feet.x = THREE.MathUtils.clamp(feet.x, this.bounds.minX, this.bounds.maxX);
    feet.z = THREE.MathUtils.clamp(feet.z, this.bounds.minZ, this.bounds.maxZ);
  }

  dropToGround(x, z, box) {
    const feet = new THREE.Vector3(x, box.max.y + DROP_HEIGHT, z);
    const state = { velocityY: 0, onGround: false };

    for (let i = 0; i < 1000; i += 1) {
      state.velocityY -= 28 * (1 / 60);
      this.moveVertical(feet, state.velocityY, 1 / 60, state);
      if (state.onGround) break;
    }

    if (!state.onGround) {
      const y = this.findWalkableGroundY(x, z, box.max.y + DROP_HEIGHT);
      feet.y = y ?? box.max.y;
      state.onGround = true;
    }

    this.snapToGroundSkin(feet);
    this.clampToBounds(feet);
    return feet;
  }

  findWalkableGroundY(x, z, fromY) {
    this.origin.set(x, fromY, z);
    this.raycaster.set(this.origin, this.down);
    this.raycaster.far = 250;
    const hits = this.raycaster.intersectObjects(this.meshes, false);

    // First walkable hit from above = standing surface (not underground shells).
    for (const hit of hits) {
      if (!isWalkableHit(hit)) continue;
      return hit.point.y + GROUND_SKIN;
    }

    return null;
  }

  snapToGroundSkin(feet) {
    const groundY = this.probeGround(feet);
    if (groundY !== null) {
      feet.y = Math.max(feet.y, groundY);
    }
    this.liftToClear(feet);
  }

  liftToClear(feet) {
    for (let i = 0; i < 40; i += 1) {
      if (!this.intersectsWalls(feet)) return;
      feet.y += 0.08;
    }
  }

  /**
   * Horizontal blocking only against walls/steep faces.
   * Walkable floors are ignored so bumpy open ground can't trap movement or cancel jumps.
   */
  intersectsWalls(feet) {
    const bodyHeights = [
      feet.y + BODY_PROBE_MIN_Y,
      feet.y + PLAYER_HEIGHT * 0.55,
      feet.y + PLAYER_HEIGHT - PLAYER_RADIUS,
    ];

    for (const y of bodyHeights) {
      for (const dir of HORIZONTAL_DIRS) {
        this.origin.set(feet.x, y, feet.z);
        this.raycaster.set(this.origin, dir);
        this.raycaster.far = PLAYER_RADIUS + 0.06;
        const hits = this.raycaster.intersectObjects(this.meshes, false);
        for (const hit of hits) {
          if (isWalkableHit(hit)) continue;
          return true;
        }
      }
    }

    return false;
  }

  moveAndSlide(feet, delta) {
    const tryX = feet.x + delta.x;
    const testX = new THREE.Vector3(tryX, feet.y, feet.z);
    if (!this.intersectsWalls(testX)) {
      feet.x = tryX;
    }

    const tryZ = feet.z + delta.z;
    const testZ = new THREE.Vector3(feet.x, feet.y, tryZ);
    if (!this.intersectsWalls(testZ)) {
      feet.z = tryZ;
    }

    // Keep a small air gap over flats after sliding.
    const groundY = this.probeGround(feet);
    if (groundY !== null && feet.y < groundY + GROUND_SNAP) {
      feet.y = groundY;
    }
    this.liftToClear(feet);
    this.clampToBounds(feet);
  }

  probeGround(feet) {
    this.origin.set(feet.x, feet.y + PLAYER_HEIGHT + 12, feet.z);
    this.raycaster.set(this.origin, this.down);
    this.raycaster.far = PLAYER_HEIGHT + 120;
    const hits = this.raycaster.intersectObjects(this.meshes, false);

    for (const hit of hits) {
      if (!isWalkableHit(hit)) continue;
      if (hit.point.y <= feet.y + 0.9) {
        return hit.point.y + GROUND_SKIN;
      }
    }

    return null;
  }

  moveVertical(feet, velocityY, delta, state) {
    const step = velocityY * delta;
    if (step === 0) return;

    const nextY = feet.y + step;
    const test = new THREE.Vector3(feet.x, nextY, feet.z);

    // Jumping: only cancel on real ceiling/wall hits, never on floors.
    if (step > 0) {
      if (this.intersectsWalls(test)) {
        state.velocityY = 0;
        state.onGround = false;
        return;
      }
      feet.y = nextY;
      state.onGround = false;
      this.clampToBounds(feet);
      return;
    }

    // Falling
    if (!this.intersectsWalls(test)) {
      feet.y = nextY;
      const groundY = this.probeGround(feet);
      if (groundY !== null && feet.y <= groundY + GROUND_SNAP) {
        feet.y = groundY;
        state.velocityY = 0;
        state.onGround = true;
      } else {
        state.onGround = false;
      }
      this.clampToBounds(feet);
      return;
    }

    const groundY = this.probeGround(feet);
    feet.y = groundY !== null ? groundY : feet.y;
    state.velocityY = 0;
    state.onGround = true;
    this.liftToClear(feet);
    this.clampToBounds(feet);
  }
}
