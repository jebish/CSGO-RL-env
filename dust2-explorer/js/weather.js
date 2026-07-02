import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

function createCloudTexture(seed = 1) {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, size, size);

  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };

  for (let layer = 0; layer < 3; layer += 1) {
    const count = 55 + layer * 15;
    for (let i = 0; i < count; i += 1) {
      const x = rand() * size;
      const y = rand() * size * 0.55;
      const r = 50 + rand() * (120 - layer * 20);
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(245,248,252,${0.28 - layer * 0.06})`);
      grad.addColorStop(0.45, `rgba(220,228,236,${0.18 - layer * 0.04})`);
      grad.addColorStop(1, 'rgba(180,190,200,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

export class WeatherSystem {
  constructor(scene, renderer, sunLight) {
    this.scene = scene;
    this.renderer = renderer;
    this.sunLight = sunLight;
    this.elapsed = 0;

    this._setupSky();
    this._setupClouds();
    this._setupRain();
    this._setupRainAudio();
  }

  _setupSky() {
    const sky = new Sky();
    sky.scale.setScalar(450000);
    this.scene.add(sky);
    this.sky = sky;

    const uniforms = sky.material.uniforms;
    uniforms.turbidity.value = 18;
    uniforms.rayleigh.value = 1.4;
    uniforms.mieCoefficient.value = 0.002;
    uniforms.mieDirectionalG.value = 0.7;

    this.sunSpherical = new THREE.Spherical(1, THREE.MathUtils.degToRad(78), THREE.MathUtils.degToRad(210));
    this._updateSunPosition();

    this.scene.background = null;
    this.scene.fog = new THREE.Fog(0x8a9bab, 50, 210);
  }

  _updateSunPosition() {
    const sunPos = new THREE.Vector3().setFromSpherical(this.sunSpherical);
    this.sky.material.uniforms.sunPosition.value.copy(sunPos);
    this.sunLight.position.copy(sunPos).multiplyScalar(400);
    this.sunLight.intensity = 0.85;
  }

  _setupClouds() {
    this.cloudGroup = new THREE.Group();
    const texA = createCloudTexture(42);
    const texB = createCloudTexture(99);

    const cloudMat = (texture, opacity) => new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });

    const layers = [
      { y: 58, scale: 280, opacity: 0.55, tex: texA, speed: 0.4 },
      { y: 66, scale: 320, opacity: 0.42, tex: texB, speed: 0.25 },
      { y: 74, scale: 360, opacity: 0.32, tex: texA, speed: 0.15 },
    ];

    this.cloudLayers = [];
    for (const layer of layers) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(layer.scale, layer.scale * 0.45), cloudMat(layer.tex, layer.opacity));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = layer.y;
      mesh.renderOrder = -1;
      this.cloudGroup.add(mesh);
      this.cloudLayers.push({ mesh, speed: layer.speed });
    }

    this.scene.add(this.cloudGroup);
  }

  _setupRain() {
    const count = 2200;
    const streak = 0.55;
    const positions = new Float32Array(count * 6);
    const speeds = new Float32Array(count);

    for (let i = 0; i < count; i += 1) {
      const x = (Math.random() - 0.5) * 120;
      const y = Math.random() * 45 + 12;
      const z = (Math.random() - 0.5) * 120;
      const base = i * 6;
      positions[base] = x;
      positions[base + 1] = y;
      positions[base + 2] = z;
      positions[base + 3] = x + (Math.random() - 0.5) * 0.04;
      positions[base + 4] = y - streak;
      positions[base + 5] = z + (Math.random() - 0.5) * 0.04;
      speeds[i] = 32 + Math.random() * 28;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.LineBasicMaterial({
      color: 0x4a5f73,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });

    this.rain = new THREE.LineSegments(geometry, material);
    this.rainSpeeds = speeds;
    this.rainStreak = streak;
    this.scene.add(this.rain);
  }

  _setupRainAudio() {
    this.audioCtx = null;
    this.rainSource = null;
    this._audioStarted = false;
    this._audioLoading = false;
  }

  async startRainAudio() {
    if (this._audioStarted || this._audioLoading) return;
    this._audioLoading = true;

    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const response = await fetch('assets/rain.mp3');
      const arrayBuffer = await response.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arrayBuffer);

      const trimStart = 1;
      const trimEnd = 1;
      const sampleRate = decoded.sampleRate;
      const startSample = Math.min(Math.floor(trimStart * sampleRate), decoded.length - 1);
      const endSample = Math.max(
        startSample + 1,
        Math.floor((decoded.duration - trimEnd) * sampleRate),
      );
      const length = endSample - startSample;

      const trimmed = ctx.createBuffer(decoded.numberOfChannels, length, sampleRate);
      for (let ch = 0; ch < decoded.numberOfChannels; ch += 1) {
        const src = decoded.getChannelData(ch);
        const dst = trimmed.getChannelData(ch);
        for (let i = 0; i < length; i += 1) {
          dst[i] = src[startSample + i];
        }
      }

      const source = ctx.createBufferSource();
      source.buffer = trimmed;
      source.loop = true;

      const gain = ctx.createGain();
      gain.gain.value = 0.55;

      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(0);

      this.audioCtx = ctx;
      this.rainSource = source;
      this._audioStarted = true;
    } catch (err) {
      console.error('Rain audio failed:', err);
      this._audioLoading = false;
    }
  }

  update(delta, cameraPosition) {
    this.elapsed += delta;

    for (const layer of this.cloudLayers) {
      layer.mesh.position.x = Math.sin(this.elapsed * layer.speed * 0.04) * 18;
      layer.mesh.position.z = Math.cos(this.elapsed * layer.speed * 0.03) * 14;
    }

    const positions = this.rain.geometry.attributes.position.array;
    const streak = this.rainStreak;
    for (let i = 0; i < this.rainSpeeds.length; i += 1) {
      const base = i * 6;
      const speed = this.rainSpeeds[i] * delta;
      positions[base + 1] -= speed;
      positions[base + 4] -= speed;
      if (positions[base + 1] < 0) {
        const x = (Math.random() - 0.5) * 120;
        const z = (Math.random() - 0.5) * 120;
        const y = 35 + Math.random() * 25;
        positions[base] = x;
        positions[base + 1] = y;
        positions[base + 2] = z;
        positions[base + 3] = x + (Math.random() - 0.5) * 0.04;
        positions[base + 4] = y - streak;
        positions[base + 5] = z + (Math.random() - 0.5) * 0.04;
      }
    }
    this.rain.geometry.attributes.position.needsUpdate = true;
    this.rain.position.set(cameraPosition.x, 0, cameraPosition.z);
  }
}
