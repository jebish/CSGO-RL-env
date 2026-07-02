import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PlayerController } from './controls.js';
import { InteractableManager } from './interactables.js';
import { setupMapCollision, dropSpawnFromCorner, CollisionWorld, PLAYER_HEIGHT } from './collision.js';
import { WeatherSystem } from './weather.js';
import { Minimap, collectMapMeshes } from './minimap.js';

const hud = document.getElementById('hud');
const minimapWrap = document.getElementById('minimap-wrap');
const minimapCanvas = document.getElementById('minimap-canvas');
const prompt = document.getElementById('prompt');
const panel = document.getElementById('panel');
const panelTitle = document.getElementById('panel-title');
const panelBody = document.getElementById('panel-body');
const panelClose = document.getElementById('panel-close');
const footerText = document.getElementById('footer-text');

const CONTROLS_LINE =
  'WASD move · Space jump · Shift sprint · Mouse look · E interact · Click game to capture mouse · Esc release';

const CHARACTER_MODEL_YAW = -Math.PI / 2;
const CHARACTER_WIDTH_SCALE = 0.93;
const CAMERA_DISTANCE = 1.68;

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

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 500);
camera.rotation.order = 'YXZ';

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

const cameraOffset = new THREE.Vector3();
const cameraPivot = new THREE.Vector3();

let mapRoot = new THREE.Group();
let collisionWorld = null;
let player = null;
let interactables = null;
let mapLoaded = false;
let characterReady = false;
const clock = new THREE.Clock();
const loader = new GLTFLoader();

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

loader.load('assets/character.glb', (gltf) => {
  const model = gltf.scene;
  fitCharacterModel(model);
  character.add(model);
  characterReady = true;
});

loader.load(
  'assets/map.glb',
  (gltf) => {
    try {
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

      footerText.textContent = 'Building minimap…';
      minimap.bake(collectMapMeshes(mapRoot), mapBox);
      footerText.textContent = CONTROLS_LINE;

      player = new PlayerController(renderer.domElement, collisionWorld);
      player.setPosition(spawn.x, spawn.y, spawn.z);
      player.enable();

      interactables = new InteractableManager(scene, mapRoot);
      interactables.group.position.copy(mapRoot.position);
      interactables.group.scale.copy(mapRoot.scale);
      interactables.build();

      mapLoaded = true;
    } catch (err) {
      console.error(err);
      footerText.textContent = `Failed to start — ${err.message}`;
    }
  },
  (progress) => {
    if (progress.total > 0) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      footerText.textContent = `Loading map… ${pct}%`;
    }
  },
  (error) => {
    console.error(error);
    footerText.textContent = 'Failed to load map — check console';
  },
);

function updateThirdPersonCamera(feet, cameraYaw, pitch) {
  cameraPivot.set(feet.x, feet.y + 1.05, feet.z);

  cameraOffset.set(0, 0, -CAMERA_DISTANCE);
  cameraOffset.applyAxisAngle(new THREE.Vector3(1, 0, 0), -pitch);
  cameraOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), cameraYaw);

  camera.position.copy(cameraPivot).add(cameraOffset);
  camera.lookAt(cameraPivot);
}

function showPanel(item) {
  panelTitle.textContent = item.data.title;
  panelBody.textContent = item.data.body;
  panel.hidden = false;
  document.exitPointerLock();
}

function hidePanel() {
  panel.hidden = true;
}

renderer.domElement.addEventListener('click', () => {
  if (player && mapLoaded && panel.hidden) {
    weather.startRainAudio();
    player.requestPointerLock();
  }
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
    character.visible = characterReady;

    updateThirdPersonCamera(feet, player.cameraYaw, player.cameraPitch);

    const mouseLookActive = player.pointerLocked && !player.isMouseIdle();
    minimap.draw(feet.x, feet.z, player.cameraYaw, player.characterYaw, mouseLookActive);

    const nearest = interactables.update(feet, elapsed);
    prompt.hidden = !nearest || !panel.hidden;
  }

  renderer.render(scene, camera);
}

animate();
