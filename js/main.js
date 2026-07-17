import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PlayerController } from './controls.js';
import { InteractableManager } from './interactables.js';
import { setupMapCollision, dropSpawnFromCorner, CollisionWorld, PLAYER_HEIGHT } from './collision.js';
import { WeatherSystem } from './weather.js';
import { Minimap, collectMapMeshes } from './minimap.js?v=10';
import { WeaponSystem } from './weapons.js?v=9';
import { GameMenu } from './ui-menu.js';
import { NetClient, SPAWN_OFFSETS } from './net.js';

const DAMAGE_VIGNETTE_SEC = 2;

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
const hpHud = document.getElementById('hp-hud');
const hpValue = document.getElementById('hp-value');
const damageVignette = document.getElementById('damage-vignette');
const playerHud = document.getElementById('player-hud');
const playerAvatar = document.getElementById('player-avatar');
const playerName = document.getElementById('player-name');
const crosshair = document.getElementById('crosshair');
const menuRoot = document.getElementById('menu-root');

let lastHp = 100;
let damageVignetteT = 0;

function formatHp(hp) {
  const n = Math.max(0, Math.min(100, Math.ceil(hp)));
  return String(n).padStart(3, '0');
}

function setHpHud(hp, alive) {
  const el = hpValue || hpHud;
  if (!el) return;
  if (hpValue) hpValue.textContent = alive ? formatHp(hp) : '000';
  else hpHud.textContent = alive ? formatHp(hp) : '000';
  if (hpHud) hpHud.classList.toggle('dead', !alive);
}

function pulseDamageVignette() {
  damageVignetteT = DAMAGE_VIGNETTE_SEC;
  if (damageVignette) damageVignette.style.opacity = '1';
}

function updateDamageVignette(delta) {
  if (damageVignetteT <= 0) return;
  damageVignetteT = Math.max(0, damageVignetteT - delta);
  if (damageVignette) {
    damageVignette.style.opacity = String(damageVignetteT / DAMAGE_VIGNETTE_SEC);
  }
}

function setPlayerIdentityHud({ username, avatarUrl }) {
  if (!playerHud) return;
  if (!username) {
    playerHud.hidden = true;
    return;
  }
  playerHud.hidden = false;
  if (playerName) playerName.textContent = username;
  if (playerAvatar) {
    if (avatarUrl) {
      playerAvatar.hidden = false;
      playerAvatar.src = avatarUrl;
      playerAvatar.onerror = () => {
        playerAvatar.hidden = true;
      };
    } else {
      playerAvatar.hidden = true;
    }
  }
}

function setStatus(text) {
  if (footerText) footerText.textContent = text;
}

let bootComplete = false;
let gameplayActive = false;
let baseSpawn = new THREE.Vector3();

window.addEventListener('error', (event) => {
  console.error(event.error || event.message);
  const prefix = bootComplete ? 'Runtime error' : 'Failed to start';
  setStatus(`${prefix} — ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error(event.reason);
  const msg = event.reason?.message || String(event.reason);
  const prefix = bootComplete ? 'Runtime error' : 'Failed to start';
  setStatus(`${prefix} — ${msg}`);
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

const net = new NetClient({
  scene,
  onStatus: setStatus,
  onMatchStart: (info) => enterGameplay(info),
  onMatchEnd: (msg) => {
    setStatus(`Match over — winner: ${msg.winner || msg.winnerUser || '?'}`);
  },
  onLobbyUpdate: (board, mode, error = null) => {
    menu.renderBoard(board, mode, error);
  },
});

net.combat.onHpChange = (hp, alive) => {
  if (alive && hp < lastHp) pulseDamageVignette();
  lastHp = hp;
  setHpHud(hp, alive);
};

net.combat.onRespawn = () => {
  if (!player) return;
  applySpawn(net._spawnIndex || 0);
};

net.onRemoteFire = (msg) => {
  if (!weapons || !msg.origin || !msg.dir) return;
  const from = new THREE.Vector3(msg.origin[0], msg.origin[1], msg.origin[2]);
  const dir = new THREE.Vector3(msg.dir[0], msg.dir[1], msg.dir[2]).normalize();
  const to = from.clone().addScaledVector(dir, 16);
  weapons._spawnTracer(from, to, msg.weapon === 'sniper' ? 0.1 : 0.06);
};

net.onRemoteGrenadeThrow = (msg) => {
  if (weapons && msg.origin && msg.vel) {
    weapons.spawnRemoteGrenade(msg.origin, msg.vel, msg.fuse);
  }
};

net.onRemoteGrenadeExplode = (msg) => {
  if (!weapons || !msg.pos) return;
  try {
    weapons.impacts.explodeAt(new THREE.Vector3(msg.pos[0], msg.pos[1], msg.pos[2]), msg.radius || 4);
    weapons._ensureAudio?.();
    weapons.audio?.playExplosion?.();
  } catch (err) {
    console.error(err);
  }
};

const menu = new GameMenu({
  root: menuRoot,
  onOpenMode: (mode) => {
    net.startLobbyPoll(mode);
  },
  onBack: async () => {
    net.stopLobbyPoll();
    await net.leaveLobby();
    exitGameplayToMenu();
  },
  onClaim: async (mode, lobbyId, seat) => {
    const data = await net.claim(mode, lobbyId, seat);
    setStatus(`Seated ${seat} in ${lobbyId}`);
    // Connect WS immediately; sandbox starts right away, others wait for fill rules
    net.connectMatch();
    return data;
  },
  onLeaveSeat: async () => {
    await net.leaveLobby();
    setStatus('Left seat');
  },
  onEnterMatch: () => {
    if (!net.lobbyId) {
      setStatus('Claim a seat first');
      return;
    }
    net.connectMatch();
  },
});

async function bootIdentity() {
  const res = await net.initLocal();
  menu.setIdentity({
    username: net.username,
    spaceUrl: net.spaceUrl,
    authError: res.ok ? null : res.error,
  });
  setPlayerIdentityHud({
    username: net.username,
    avatarUrl: net.avatarUrl,
  });
  setHpHud(net.combat.hp, net.combat.alive);
  lastHp = net.combat.hp;
  if (!res.ok) setStatus(res.error);
  else setStatus(`Online as ${net.username}`);
}

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
  weapons.net = net;
  weapons.paused = true;
  weapons.onWeaponChange = (weaponId) => {
    if (weaponHud) weaponHud.dataset.weapon = weaponId;
    if (!weapons.canScope()) setScoping(false);
  };
  weapons.onAmmoChange = (text) => {
    if (ammoHud) ammoHud.textContent = text;
  };
  if (weaponHud) weaponHud.dataset.weapon = weapons.currentId;
  if (ammoHud) ammoHud.textContent = weapons.getAmmoDisplay();
}

function applySpawn(spawnIndex) {
  if (!player) return;
  const off = SPAWN_OFFSETS[spawnIndex % SPAWN_OFFSETS.length];
  player.setPosition(baseSpawn.x + off.x, baseSpawn.y, baseSpawn.z + off.z);
}

function enterGameplay(info) {
  if (!player || !mapLoaded) return;
  gameplayActive = true;
  menu.hide();
  if (hud) hud.hidden = false;
  applySpawn(info.spawnIndex ?? 0);
  player.enable();
  if (weapons) {
    weapons.paused = false;
    weapons.net = net;
  }
  net.combat.reset();
  setCrosshairVisible(true);
  if (minimapWrap) {
    minimap._pinBottomLeft();
    minimapWrap.hidden = false;
  }
  setStatus(CONTROLS_LINE);
  document.exitPointerLock?.();
}

function exitGameplayToMenu() {
  gameplayActive = false;
  if (player) {
    player.disable();
    document.exitPointerLock?.();
  }
  if (weapons) {
    weapons.paused = true;
    weapons.lmbHeld = false;
  }
  setScoping(false);
  setCrosshairVisible(false);
  if (hud) hud.hidden = true;
  if (minimapWrap) minimapWrap.hidden = true;
  net.disconnectMatch();
  menu.show();
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
      baseSpawn.set(spawn.x, spawn.y, spawn.z);
      mapHitMeshes = collectMapMeshes(mapRoot);

      setStatus('Building minimap…');
      minimap.bake(collectMapMeshes(mapRoot), mapBox);

      player = new PlayerController(renderer.domElement, collisionWorld);
      player.setPosition(spawn.x, spawn.y, spawn.z);
      // Do not enable until match / menu chooses play

      interactables = new InteractableManager(scene, mapRoot);
      interactables.group.position.copy(mapRoot.position);
      interactables.group.scale.copy(mapRoot.scale);
      interactables.build();

      mapLoaded = true;
      bootComplete = true;
      initWeapons();
      setCrosshairVisible(false);
      menu.show();
      void bootIdentity();
      setStatus('Choose a mode to play');
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

  cameraPivot.set(feet.x, feet.y + CAMERA_HEAD_Y, feet.z);
  cameraHorizBack.set(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));

  const targetDist = scoping ? SCOPE_DISTANCE : CAMERA_DISTANCE;
  const targetFov = scoping ? (weapons?.getScopeFov?.(CAMERA_FOV) ?? CAMERA_FOV) : CAMERA_FOV;
  cameraFov += (targetFov - cameraFov) * Math.min(1, delta * 12);
  camera.fov = cameraFov;
  camera.updateProjectionMatrix();

  camera.position
    .copy(cameraPivot)
    .addScaledVector(cameraHorizBack, targetDist);
  camera.position.y += CAMERA_LIFT;

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
  if (gameplayActive) setCrosshairVisible(true);
}

renderer.domElement.addEventListener('click', () => {
  if (!gameplayActive) return;
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
  const allowed = !!weapons?.canScope() && gameplayActive;
  scoping = !!active && allowed;
  if (crosshair) {
    if (scoping) crosshair.classList.add('scoped');
    else crosshair.classList.remove('scoped');
  }
  if (weapons) weapons.setScoping(scoping);
  return scoping;
}

window.addEventListener('mousedown', (event) => {
  if (event.button === 2 && gameplayActive && player?.pointerLocked && panel.hidden) {
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
  if (!gameplayActive) return;
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
  updateDamageVignette(delta);

  if (player && mapLoaded && gameplayActive) {
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

    net.update(delta, player, weapons?.currentId || 'machinegun');

    const mouseLookActive = player.pointerLocked && !player.isMouseIdle();
    minimap.draw(feet.x, feet.z, player.cameraYaw, player.characterYaw, mouseLookActive);

    const nearest = interactables.update(feet, elapsed);
    prompt.hidden = !nearest || !panel.hidden;
  } else if (player && mapLoaded) {
    // Menu: keep a static third-person look at spawn
    const feet = player.getFeetPosition(new THREE.Vector3());
    character.position.copy(feet);
    updateThirdPersonCamera(feet, player.cameraYaw, player.cameraPitch, delta);
  }

  renderer.render(scene, camera);
}

animate();
