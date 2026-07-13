import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PlayerController } from './controls.js';
import { InteractableManager } from './interactables.js';
import { setupMapCollision, dropSpawnFromCorner, CollisionWorld, PLAYER_HEIGHT } from './collision.js';
import { WeatherSystem } from './weather.js';
import { Minimap, collectMapMeshes } from './minimap.js';
import { WeaponSystem } from './weapons.js';

const hud = document.getElementById('hud');
const minimapWrap = document.getElementById('minimap-wrap');
const minimapCanvas = document.getElementById('minimap-canvas');
const prompt = document.getElementById('prompt');
const panel = document.getElementById('panel');
const panelTitle = document.getElementById('panel-title');
const panelBody = document.getElementById('panel-body');
const panelClose = document.getElementById('panel-close');
const footerText = document.getElementById('footer-text');
const weaponHud = document.getElementById('weapon-hud');
const ammoHud = document.getElementById('ammo-hud');
const crosshair = document.getElementById('crosshair');

function setStatus(text) {
  if (footerText) footerText.textContent = text;
}

window.addEventListener('error', (event) => {
  console.error(event.error || event.message);
  setStatus(`Failed to start — ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error(event.reason);
  const msg = event.reason?.message || String(event.reason);
  setStatus(`Failed to start — ${msg}`);
});

setStatus('Starting engine…');

const CONTROLS_LINE =
  'WASD move · Space jump · Shift sprint · Mouse look · Scroll weapons · LMB fire/swing · RMB scope · R reload · E interact · Click game to capture mouse · Esc release';

const CHARACTER_MODEL_YAW = -Math.PI / 2;
const CHARACTER_WIDTH_SCALE = 0.93;
const CAMERA_DISTANCE = 1.28;
const CAMERA_HEAD_Y = 1.22;
const CAMERA_LIFT = 0.12;
const AIM_LOOK_DISTANCE = 48;
const CAMERA_FOV = 70;
const SCOPE_FOV = 36;
const SCOPE_DISTANCE = 0.42;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(CAMERA_FOV, window.innerWidth / window.innerHeight, 0.05, 500);
camera.rotation.order = 'YXZ';
let cameraFov = CAMERA_FOV;
let scoping = false;

const hemi = new THREE.HemisphereLight(0xb8c9dc, 0x5a6348, 0.35);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xf4f6ff, 1.65);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 160;
sun.shadow.camera.left = -60;
sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60;
sun.shadow.camera.bottom = -60;
sun.shadow.bias = -0.0004;
scene.add(sun);

const fill = new THREE.DirectionalLight(0xc8d4e8, 0.25);
fill.position.set(-20, 30, -10);
scene.add(fill);

const weather = new WeatherSystem(scene, renderer, sun);
const minimap = new Minimap(minimapWrap, minimapCanvas);

const character = new THREE.Group();
scene.add(character);

const cameraPivot = new THREE.Vector3();
const cameraAimDir = new THREE.Vector3();
const cameraLookTarget = new THREE.Vector3();
const cameraHorizBack = new THREE.Vector3();
const worldAimDir = new THREE.Vector3();

let mapRoot = new THREE.Group();
let collisionWorld = null;
let mapHitMeshes = [];
let player = null;
let interactables = null;
let weapons = null;
let mapLoaded = false;
let characterReady = false;
const clock = new THREE.Clock();
const mapLoader = new GLTFLoader();
const characterLoader = new GLTFLoader();

function fitCharacterModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = PLAYER_HEIGHT / Math.max(size.y, 0.001);
  model.scale.set(scale * CHARACTER_WIDTH_SCALE, scale, scale * CHARACTER_WIDTH_SCALE);
  box.setFromObject(model);
  model.position.y = -box.min.y;
  model.rotation.y = CHARACTER_MODEL_YAW;
  model.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

function initWeapons() {
  if (weapons || !characterReady || !mapLoaded) return;
  weapons = new WeaponSystem(scene, character, renderer.domElement);
  weapons.setImpactMeshes(mapHitMeshes);
  weapons.onWeaponChange = (label) => {
    if (weaponHud) weaponHud.textContent = label;
    if (!weapons.canScope()) setScoping(false);
  };
  weapons.onAmmoChange = (text) => {
    if (ammoHud) ammoHud.textContent = text;
  };
  if (weaponHud) weaponHud.textContent = weapons.currentLabel;
  if (ammoHud) ammoHud.textContent = weapons.getAmmoDisplay();
}

setStatus('Loading character…');
characterLoader.load(
  'assets/character.glb',
  (gltf) => {
    const model = gltf.scene;
    fitCharacterModel(model);
    character.add(model);
    characterReady = true;
    initWeapons();
  },
  undefined,
  (error) => {
    console.error(error);
    setStatus('Failed to load character — check console');
  },
);

setStatus('Loading map…');
mapLoader.load(
  'assets/map.glb',
  (gltf) => {
    try {
      setStatus('Processing map…');
      mapRoot = gltf.scene;
      mapRoot.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          if (child.material) {
            child.material.side = THREE.FrontSide;
          }
        }
      });

      const box = new THREE.Box3().setFromObject(mapRoot);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());

      mapRoot.position.sub(center);
      mapRoot.position.y -= box.min.y - center.y;

      const maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim > 120) {
        const scale = 80 / maxDim;
        mapRoot.scale.setScalar(scale);
      }

      mapRoot.updateMatrixWorld(true);
      scene.add(mapRoot);

      const mapBox = new THREE.Box3().setFromObject(mapRoot);
      const collisionMeshes = setupMapCollision(mapRoot);
      collisionWorld = new CollisionWorld(collisionMeshes);
      collisionWorld.setBounds(mapBox);
      const spawn = dropSpawnFromCorner(mapRoot, collisionWorld);
      mapHitMeshes = collectMapMeshes(mapRoot);

      setStatus('Building minimap…');
      minimap.bake(collectMapMeshes(mapRoot), mapBox);

      player = new PlayerController(renderer.domElement, collisionWorld);
      player.setPosition(spawn.x, spawn.y, spawn.z);
      player.enable();

      interactables = new InteractableManager(scene, mapRoot);
      interactables.group.position.copy(mapRoot.position);
      interactables.group.scale.copy(mapRoot.scale);
      interactables.build();

      mapLoaded = true;
      initWeapons();
      setCrosshairVisible(true);
      setStatus(CONTROLS_LINE);
    } catch (err) {
      console.error(err);
      setStatus(`Failed to start — ${err.message}`);
    }
  },
  (progress) => {
    if (progress.total > 0) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      setStatus(`Loading map… ${pct}%`);
    } else {
      setStatus('Loading map…');
    }
  },
  (error) => {
    console.error(error);
    setStatus('Failed to load map — check console');
  },
);

function updateThirdPersonCamera(feet, cameraYaw, pitch, delta) {
  const cosPitch = Math.cos(pitch);
  cameraAimDir.set(
    Math.sin(cameraYaw) * cosPitch,
    Math.sin(pitch),
    Math.cos(cameraYaw) * cosPitch,
  );

  // Pivot near head so the view clears the ground and the body sits lower in frame.
  cameraPivot.set(feet.x, feet.y + CAMERA_HEAD_Y, feet.z);
  cameraHorizBack.set(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));

  const targetDist = scoping ? SCOPE_DISTANCE : CAMERA_DISTANCE;
  const targetFov = scoping ? SCOPE_FOV : CAMERA_FOV;
  cameraFov += (targetFov - cameraFov) * Math.min(1, delta * 12);
  camera.fov = cameraFov;
  camera.updateProjectionMatrix();

  camera.position
    .copy(cameraPivot)
    .addScaledVector(cameraHorizBack, targetDist);
  camera.position.y += CAMERA_LIFT;

  // Look along aim from a point slightly ahead of the head so the crosshair clears the helmet.
  cameraLookTarget
    .copy(cameraPivot)
    .addScaledVector(cameraAimDir, 0.55)
    .addScaledVector(cameraAimDir, AIM_LOOK_DISTANCE);
  camera.lookAt(cameraLookTarget);

  if (characterReady) {
    character.visible = !scoping;
  }
}

function setCrosshairVisible(visible) {
  if (crosshair) crosshair.hidden = !visible;
}

function showPanel(item) {
  panelTitle.textContent = item.data.title;
  panelBody.textContent = item.data.body;
  panel.hidden = false;
  setCrosshairVisible(false);
  document.exitPointerLock();
}

function hidePanel() {
  panel.hidden = true;
  if (mapLoaded) setCrosshairVisible(true);
}

renderer.domElement.addEventListener('click', () => {
  if (player && mapLoaded && panel.hidden) {
    weather.startRainAudio();
    if (weapons) weapons.initAudio();
    player.requestPointerLock();
  }
});

renderer.domElement.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});

function setScoping(active) {
  const allowed = !!weapons?.canScope();
  scoping = !!active && allowed;
  if (crosshair) {
    if (scoping) crosshair.classList.add('scoped');
    else crosshair.classList.remove('scoped');
  }
  if (weapons) weapons.setScoping(scoping);
  return scoping;
}

window.addEventListener('mousedown', (event) => {
  if (event.button === 2 && player?.pointerLocked && panel.hidden) {
    setScoping(true);
  }
});

window.addEventListener('mouseup', (event) => {
  if (event.button === 2) {
    setScoping(false);
  }
});

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== renderer.domElement) {
    setScoping(false);
  }
});

window.addEventListener('blur', () => {
  setScoping(false);
});

panelClose.addEventListener('click', hidePanel);

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyE' && interactables && panel.hidden) {
    const nearest = interactables.getNearest();
    if (nearest) showPanel(nearest);
  }
  if (event.code === 'Escape' && !panel.hidden) {
    hidePanel();
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  const elapsed = clock.elapsedTime;

  weather.update(delta, camera.position);

  if (player && mapLoaded) {
    player.update(delta);

    const feet = player.getFeetPosition(new THREE.Vector3());
    character.position.copy(feet);
    character.rotation.y = player.characterYaw;

    updateThirdPersonCamera(feet, player.cameraYaw, player.cameraPitch, delta);
    camera.getWorldDirection(worldAimDir);

    if (weapons) {
      if (scoping && !weapons.canScope()) setScoping(false);
      weapons.update(delta, player, worldAimDir, camera.position);
    }

    const mouseLookActive = player.pointerLocked && !player.isMouseIdle();
    minimap.draw(feet.x, feet.z, player.cameraYaw, player.characterYaw, mouseLookActive);

    const nearest = interactables.update(feet, elapsed);
    prompt.hidden = !nearest || !panel.hidden;
  }

  renderer.render(scene, camera);
}

animate();
