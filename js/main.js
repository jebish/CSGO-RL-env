import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PlayerController } from './controls.js?v=2';
import { InteractableManager } from './interactables.js';
import { setupMapCollision, dropSpawnFromCorner, CollisionWorld, PLAYER_HEIGHT } from './collision.js?v=4';
import { WeatherSystem } from './weather.js';
import { Minimap, collectMapMeshes } from './minimap.js?v=10';
import { WeaponSystem } from './weapons.js?v=29';
import { GameMenu } from './ui-menu.js?v=35';
import { NetClient, SPAWN_OFFSETS } from './net.js?v=36';
import { SpectatorController } from './spectator.js?v=35';

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
const spectateBar = document.getElementById('spectate-bar');
const specAvatar = document.getElementById('spec-avatar');
const specName = document.getElementById('spec-name');
const specPrev = document.getElementById('spec-prev');
const specNext = document.getElementById('spec-next');
const crosshair = document.getElementById('crosshair');
const menuRoot = document.getElementById('menu-root');

let lastHp = 100;
let damageVignetteT = 0;
let spectateScoped = false;
let specLastHp = 100;
let specLastName = null;

function formatHp(hp) {
  const n = Math.max(0, Math.min(100, Math.ceil(hp)));
  return String(n).padStart(3, '0');
}

function setHpHud(hp, alive) {
  const el = hpValue || hpHud;
  if (!el) return;
  if (hpHud) hpHud.hidden = false;
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
  if (!username || net?.spectating || spectator?.active) {
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

function setSpectateIdentity(username, ghost) {
  if (!spectateBar) return;
  if (!username) {
    spectateBar.hidden = true;
    return;
  }
  spectateBar.hidden = false;
  if (specName) specName.textContent = username;
  const url = ghost?.avatarUrl
    || `https://huggingface.co/avatars/${encodeURIComponent(username)}`;
  if (specAvatar) {
    specAvatar.hidden = false;
    specAvatar.src = url;
    specAvatar.onerror = () => {
      specAvatar.hidden = true;
    };
  }
}

function updateSpectateHud(ghost, username) {
  if (!ghost) {
    setSpectateIdentity(null, null);
    setHpHud(0, false);
    if (weaponHud) weaponHud.hidden = true;
    if (ammoHud) ammoHud.hidden = true;
    if (minimapWrap) minimapWrap.hidden = true;
    setCrosshairVisible(false);
    spectateScoped = false;
    specLastHp = 100;
    specLastName = null;
    return;
  }
  const hp = ghost.hp ?? 100;
  const alive = ghost.alive !== false;
  // Mirror player damage vignette when the followed player's HP drops.
  if (username !== specLastName) {
    specLastName = username;
    specLastHp = hp;
  } else if (alive && hp < specLastHp) {
    pulseDamageVignette();
    specLastHp = hp;
  } else {
    specLastHp = hp;
  }
  setSpectateIdentity(username, ghost);
  setHpHud(hp, alive);
  if (weaponHud) {
    weaponHud.hidden = false;
    weaponHud.dataset.weapon = ghost.weapon || 'machinegun';
  }
  if (ammoHud) {
    ammoHud.hidden = false;
    ammoHud.textContent = ghost.ammo || '—';
  }
  if (minimapWrap) minimapWrap.hidden = false;
  const wantScope = !!ghost.scope && !!weapons?.canScope(ghost.weapon);
  spectateScoped = wantScope;
  if (crosshair) {
    if (wantScope) crosshair.classList.add('scoped');
    else crosshair.classList.remove('scoped');
  }
  setCrosshairVisible(wantScope);
  if (weapons) weapons.setScoping(wantScope);
}

function setStatus(text) {
  if (footerText) footerText.textContent = text;
}

let bootComplete = false;
let gameplayActive = false;
let baseSpawn = new THREE.Vector3();
/** Full map AABB — needed so spawn offsets can drop-to-ground at new XZ. */
let mapBoundsBox = new THREE.Box3();
/** Precomputed on-floor spawns (opposite corners etc). Index 0 = T-ish, 1 = CT-ish. */
let spawnPoints = [];

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
renderer.domElement.id = 'game-canvas';
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
  onMatchConnectionLost: () => {
    exitGameplayToMenu();
    setStatus('Match connection lost — lobby seats were freed. Rejoin.');
  },
});

const spectator = new SpectatorController({
  ghosts: net.ghosts,
  onStatus: setStatus,
  onExit: () => {
    exitSpectate();
  },
  onTargetChange: (name, ghost) => {
    if (spectator?.active || net?.spectating) updateSpectateHud(ghost, name);
  },
});

specPrev?.addEventListener('click', (e) => {
  e.preventDefault();
  if (spectator.active) spectator.cycle(-1);
});
specNext?.addEventListener('click', (e) => {
  e.preventDefault();
  if (spectator.active) spectator.cycle(1);
});

net.combat.onHpChange = (hp, alive) => {
  if (net.spectating || spectator.active) return;
  if (alive && hp < lastHp) pulseDamageVignette();
  lastHp = hp;
  setHpHud(hp, alive);
};

net.onSpectateHit = (msg) => {
  if (!spectator.active && !net.spectating) return;
  const name = spectator.currentName();
  if (!name || msg.target !== name) return;
  pulseDamageVignette();
};

net.combat.onRespawn = () => {
  if (!player) return;
  applySpawn(net._spawnIndex || 0);
};

net.onRemoteFire = (msg) => {
  if (!weapons || !msg.origin || !msg.dir) return;
  const g = net.ghosts.ghosts.get(msg.from);
  if (g?.reloading || g?.alive === false) return;
  const from = new THREE.Vector3(msg.origin[0], msg.origin[1], msg.origin[2]);
  const dir = new THREE.Vector3(msg.dir[0], msg.dir[1], msg.dir[2]).normalize();
  const scoped = !!msg.scoped || !!g?.scope || msg.weapon === 'sniper';
  weapons.playRemoteFire(from, dir, msg.weapon || 'machinegun', { scoped });
};

net.onRemoteFlame = (msg) => {
  if (!weapons || !msg.origin || !msg.dir) return;
  weapons.playRemoteFlame(msg.from, msg.origin, msg.dir, { scorch: true });
};

net.onRemoteMelee = (msg) => {
  if (!msg?.from) return;
  net.ghosts.queueSwing(msg.from);
  if (weapons) {
    weapons._ensureAudio?.();
    try {
      weapons.audio?.playMeleeSwing?.();
    } catch (err) {
      console.error(err);
    }
  }
};

net.onRemoteGrenadeThrow = (msg) => {
  if (weapons && msg.origin && msg.vel) {
    weapons.spawnRemoteGrenade(msg.origin, msg.vel, msg.fuse, msg.kind || 'he');
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
  onSpectate: (mode, lobbyId) => {
    net.connectSpectate(mode, lobbyId);
    setStatus(`Spectating ${lobbyId}…`);
  },
});

let _identityReady = null;
async function bootIdentity() {
  if (_identityReady) return _identityReady;
  _identityReady = (async () => {
    const res = await net.initLocal();
    menu.setIdentity({
      username: net.username,
      spaceUrl: net.spaceUrl,
      authError: res.ok ? null : res.error,
      playAllowed: net.playAllowed,
    });
    setPlayerIdentityHud({
      username: net.username,
      avatarUrl: net.avatarUrl,
    });
    setHpHud(net.combat.hp, net.combat.alive);
    lastHp = net.combat.hp;
    if (!res.ok) {
      setStatus(res.error);
      return res;
    }
    setStatus(net.playAllowed ? `Online as ${net.username}` : `Spectator · ${net.username}`);
    // Deep link: /?spectate=1&mode=sandbox&lobby=0A
    try {
      const q = new URLSearchParams(window.location.search);
      if (q.get('spectate') === '1' && q.get('lobby')) {
        const lobby = q.get('lobby');
        const m = q.get('mode') || 'sandbox';
        net.spectating = true;
        // Wait for map, then lock into spectate UI immediately (no play controls).
        const startSpec = () => {
          if (!mapLoaded || !player) {
            requestAnimationFrame(startSpec);
            return;
          }
          enterSpectateMode();
          net.connectSpectate(m, lobby);
          setStatus(`Spectating ${lobby}…`);
        };
        startSpec();
        history.replaceState({}, '', window.location.pathname);
      }
    } catch (err) {
      console.warn(err);
    }
    return res;
  })();
  return _identityReady;
}

// Resolve identity immediately — do not wait for map (avoids "Checking HF login…" stall).
void bootIdentity();

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
  weapons.onArmsReady = () => {
    net.ghosts.setArmsFactory(() => weapons.createGhostArms());
  };
  if (weapons.ready) weapons.onArmsReady();
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

/** Drop-in height (meters) above floor before settle — same gravity path for every seat. */
const SPAWN_DROP_METERS = 12;

function applySpawn(spawnIndex) {
  if (!player || !collisionWorld) return;
  let x = baseSpawn.x;
  let z = baseSpawn.z;
  if (spawnPoints.length) {
    const i = ((spawnIndex % spawnPoints.length) + spawnPoints.length) % spawnPoints.length;
    x = spawnPoints[i].x;
    z = spawnPoints[i].z;
  }
  // Everyone: start SPAWN_DROP_METERS above ground at this XZ, then land with drop sim.
  const feet = collisionWorld.dropFromAbove(x, z, mapBoundsBox, SPAWN_DROP_METERS);
  player.position.set(feet.x, feet.y, feet.z);
  player.velocityY = 0;
  player.onGround = true;
}

function enterGameplay(info) {
  // Match can start before map/player boot finishes — wait instead of no-op (blank screen).
  if (!player || !mapLoaded) {
    requestAnimationFrame(() => enterGameplay(info));
    return;
  }
  const spectating = !!info.spectating || !net.playAllowed || net.host === 'space';
  net.spectating = spectating;

  // Space / spectate: follow-cam only — never enable the local player controller.
  if (spectating) {
    enterSpectateMode();
    return;
  }

  spectator.stop();
  gameplayActive = true;
  menu.hide();
  if (hud) hud.hidden = false;
  applySpawn(info.spawnIndex ?? 0);
  player.enable();
  if (weapons) {
    weapons.paused = false;
    weapons.net = net;
    weapons.lmbHeld = false;
  }
  net.combat.reset();
  setCrosshairVisible(true);
  if (weaponHud) weaponHud.hidden = false;
  if (ammoHud) ammoHud.hidden = false;
  if (hpHud) hpHud.hidden = false;
  if (playerHud) playerHud.hidden = false;
  if (minimapWrap) {
    minimap._pinBottomLeft();
    minimapWrap.hidden = false;
  }
  if (character) character.visible = true;
  setStatus(CONTROLS_LINE);
  document.exitPointerLock?.();
}

function enterSpectateMode() {
  gameplayActive = false; // blocks WASD / guns / pointer-lock play loop
  net.spectating = true;
  menu.hide();
  if (player) {
    player.disable();
    document.exitPointerLock?.();
  }
  if (weapons) {
    weapons.paused = true;
    weapons.net = null;
    weapons.lmbHeld = false;
    void weapons.initAudio();
    // Ensure ghost guns exist even if MG/sniper finished loading after match start.
    net.ghosts.setArmsFactory(() => weapons.createGhostArms());
  }
  setScoping(false);
  spectateScoped = false;
  if (playerHud) playerHud.hidden = true;
  if (hud) hud.hidden = false;
  if (hpHud) hpHud.hidden = false;
  if (weaponHud) weaponHud.hidden = false;
  if (ammoHud) ammoHud.hidden = false;
  if (minimapWrap) minimapWrap.hidden = false;
  if (character) character.visible = false;
  prompt.hidden = true;
  panel.hidden = true;
  spectator.start();
  updateSpectateHud(spectator.currentGhost(), spectator.currentName());
}

function exitSpectate() {
  spectator.stop();
  gameplayActive = false;
  net.spectating = false;
  spectateScoped = false;
  if (player) {
    player.disable();
    document.exitPointerLock?.();
  }
  if (weapons) {
    weapons.paused = true;
    weapons.net = null;
    weapons.lmbHeld = false;
    weapons.setScoping(false);
  }
  setScoping(false);
  setCrosshairVisible(false);
  if (spectateBar) spectateBar.hidden = true;
  if (hud) hud.hidden = true;
  if (minimapWrap) minimapWrap.hidden = true;
  if (character) character.visible = true;
  net.disconnectMatch();
  // On HF Space, leave spectate back to the public board.
  if (net.host === 'space') {
    window.location.href = '/board';
    return;
  }
  menu.show();
  setStatus('Spectate ended');
}

function exitGameplayToMenu() {
  if (spectator.active || net.spectating) {
    exitSpectate();
    return;
  }
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
    // Ghosts / spectate targets clone this fitted mesh (no blue capsules).
    net.ghosts.setPrototype(model);
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
      mapBoundsBox.copy(mapBox);
      const collisionMeshes = setupMapCollision(mapRoot);
      collisionWorld = new CollisionWorld(collisionMeshes);
      collisionWorld.setBounds(mapBox);
      const spawn = dropSpawnFromCorner(mapRoot, collisionWorld);
      baseSpawn.set(spawn.x, spawn.y, spawn.z);
      spawnPoints = collisionWorld.collectSpreadSpawns(mapBox, 8);
      if (!spawnPoints.length) {
        // Last resort: only keep corner drop if it passes interior clearance.
        const safe = collisionWorld.tryValidFeet(spawn.x, spawn.z, mapBox);
        spawnPoints = [safe || spawn.clone()];
      }
      baseSpawn.copy(spawnPoints[0]);
      mapHitMeshes = collectMapMeshes(mapRoot);

      setStatus('Building minimap…');
      minimap.bake(collectMapMeshes(mapRoot), mapBox);

      player = new PlayerController(renderer.domElement, collisionWorld);
      player.setPosition(spawnPoints[0].x, spawnPoints[0].y, spawnPoints[0].z);
      // Do not enable until match / menu chooses play

      interactables = new InteractableManager(scene, mapRoot);
      interactables.group.position.copy(mapRoot.position);
      interactables.group.scale.copy(mapRoot.scale);
      interactables.build();

      mapLoaded = true;
      bootComplete = true;
      initWeapons();
      if (net.spectating || !net.playAllowed) {
        if (weapons) {
          weapons.paused = true;
          weapons.net = null;
        }
      }
      setCrosshairVisible(false);
      menu.show();
      void bootIdentity().then((res) => {
        if (res?.ok && net.playAllowed && !net.spectating) {
          setStatus('Choose a mode to play');
        }
      });
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

function updateThirdPersonCamera(feet, cameraYaw, pitch, delta, opts = {}) {
  const cosPitch = Math.cos(pitch);
  cameraAimDir.set(
    Math.sin(cameraYaw) * cosPitch,
    Math.sin(pitch),
    Math.cos(cameraYaw) * cosPitch,
  );

  cameraPivot.set(feet.x, feet.y + CAMERA_HEAD_Y, feet.z);
  cameraHorizBack.set(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));

  const scoped = opts.scoped ?? scoping;
  const weaponId = opts.weaponId;
  const targetDist = scoped ? SCOPE_DISTANCE : CAMERA_DISTANCE;
  const targetFov = scoped
    ? (weapons?.getScopeFov?.(CAMERA_FOV, weaponId) ?? CAMERA_FOV)
    : CAMERA_FOV;
  // Spectate: snap FOV to the player's exact scope/hip FOV (no laggy lerp).
  if (spectator?.active || net?.spectating) {
    cameraFov = targetFov;
  } else {
    cameraFov += (targetFov - cameraFov) * Math.min(1, delta * 18);
  }
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

  if (characterReady && !spectator?.active && !net?.spectating) {
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
  if (!gameplayActive || net.spectating || spectator.active) return;
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
  const allowed = !!weapons?.canScope() && gameplayActive && !net.spectating && !spectator.active;
  scoping = !!active && allowed;
  if (crosshair) {
    if (scoping) crosshair.classList.add('scoped');
    else crosshair.classList.remove('scoped');
  }
  if (weapons) weapons.setScoping(scoping);
  return scoping;
}

window.addEventListener('mousedown', (event) => {
  if (net.spectating || spectator.active) return;
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
  if (net.spectating || spectator.active) return;
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

  // Spectate: mirror selected player's camera / scope / FX (← → switch).
  if (spectator.active || net.spectating) {
    if (character) character.visible = false;
    if (weapons) {
      weapons.paused = true;
      weapons.net = null;
      weapons.update(delta, null, null, null, camera);
    }
    net.ghosts.update(delta);
    const name = spectator.currentName();
    const g = spectator.currentGhost();
    if (g) {
      updateSpectateHud(g, name);
      // Unlock audio on Space (spectate never pointer-locks).
      if (weapons && !weapons.audio?.ready) void weapons.initAudio();
      // Continuous FX only while actually firing — never during reload (any weapon).
      if (weapons) {
        const lit = !g.reloading && (g.flame || (g.firing && g.weapon === 'flamethrower'));
        if (lit) {
          // Aim = camera look (not body yaw). Muzzle = same shoulder offset as local.
          const yaw = g.targetCamYaw ?? g.camYaw ?? g.yaw;
          const pitch = g.targetPitch ?? g.pitch ?? 0;
          const cosP = Math.cos(pitch);
          const fdir = new THREE.Vector3(
            Math.sin(yaw) * cosP,
            Math.sin(pitch),
            Math.cos(yaw) * cosP,
          ).normalize();
          const feet = g.target;
          const shoulderForward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
          const viewRight = new THREE.Vector3().crossVectors(
            new THREE.Vector3(0, 1, 0),
            fdir,
          );
          if (viewRight.lengthSq() < 1e-8) viewRight.set(1, 0, 0);
          else viewRight.normalize();
          const viewLeft = viewRight.clone().multiplyScalar(-1);
          const origin = [
            feet.x + shoulderForward.x * 0.28 + viewLeft.x * 0.28,
            feet.y + 1.18,
            feet.z + shoulderForward.z * 0.28 + viewLeft.z * 0.28,
          ];
          weapons.playRemoteFlame(name, origin, [fdir.x, fdir.y, fdir.z]);
        } else {
          weapons.stopRemoteFlame(name);
        }
      }
      // Camera = player's look; body on ghost uses characterYaw (synced separately).
      const camYaw = g.targetCamYaw ?? g.camYaw ?? g.targetYaw ?? g.yaw;
      const bodyYaw = g.targetYaw ?? g.yaw;
      updateThirdPersonCamera(
        g.target,
        camYaw,
        g.targetPitch ?? g.pitch ?? 0,
        delta,
        { scoped: spectateScoped, weaponId: g.weapon },
      );
      minimap.draw(g.target.x, g.target.z, camYaw, bodyYaw, true);
    } else if (player && mapLoaded) {
      updateSpectateHud(null, null);
      const feet = player.getFeetPosition(new THREE.Vector3());
      updateThirdPersonCamera(feet, player.cameraYaw, player.cameraPitch, delta);
    }
  } else if (player && mapLoaded && gameplayActive) {
    player.update(delta);

    const feet = player.getFeetPosition(new THREE.Vector3());
    character.position.copy(feet);
    character.rotation.y = player.characterYaw;
    if (character) character.visible = true;

    updateThirdPersonCamera(feet, player.cameraYaw, player.cameraPitch, delta);
    camera.getWorldDirection(worldAimDir);

    if (weapons) {
      if (scoping && !weapons.canScope()) setScoping(false);
      weapons.update(delta, player, worldAimDir, camera.position, camera);
    }

    net.update(delta, player, weapons?.currentId || 'machinegun', {
      scope: scoping,
      ammo: weapons?.getAmmoDisplay?.() || '',
      reloading: !!weapons?.isReloading?.(),
      // All weapons: real shooting only (LMB during reload/empty = false).
      firing: !!weapons?.isActivelyFiring?.(),
    });

    const mouseLookActive = player.pointerLocked && !player.isMouseIdle();
    minimap.draw(feet.x, feet.z, player.cameraYaw, player.characterYaw, mouseLookActive);

    const nearest = interactables.update(feet, elapsed);
    prompt.hidden = !nearest || !panel.hidden;
  } else if (player && mapLoaded) {
    // Menu: keep a static third-person look at spawn
    const feet = player.getFeetPosition(new THREE.Vector3());
    character.position.copy(feet);
    if (character) character.visible = true;
    updateThirdPersonCamera(feet, player.cameraYaw, player.cameraPitch, delta);
  }

  renderer.render(scene, camera);
}

animate();
