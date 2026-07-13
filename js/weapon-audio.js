/** Procedural weapon SFX with correct continuous-fire behavior (one-shot pool, not a single loop). */

function createNoiseBuffer(ctx, duration, { decay = true, band = null } = {}) {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(duration * rate));
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    let n = Math.random() * 2 - 1;
    if (band === 'low') {
      // crude low-pass via running average
      n = i === 0 ? n : data[i - 1] * 0.85 + n * 0.15;
    }
    const env = decay ? 1 - i / length : 1;
    data[i] = n * env * env;
  }
  return buffer;
}

function createGunShotBuffer(ctx) {
  const rate = ctx.sampleRate;
  const length = Math.floor(0.14 * rate);
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  let low = 0;
  for (let i = 0; i < length; i += 1) {
    const t = i / rate;
    const env = Math.exp(-t * 28);
    const click = Math.exp(-t * 120) * (Math.random() * 2 - 1);
    low = low * 0.92 + (Math.random() * 2 - 1) * 0.08;
    const body = Math.sin(2 * Math.PI * (90 + t * 40) * t) * Math.exp(-t * 18);
    data[i] = (click * 0.55 + low * 0.7 + body * 0.45) * env;
  }
  return buffer;
}

function createMeleeBuffer(ctx) {
  const rate = ctx.sampleRate;
  const length = Math.floor(0.22 * rate);
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    const t = i / rate;
    const whoosh = (Math.random() * 2 - 1) * Math.exp(-t * 9) * (t < 0.12 ? 1 : 0.35);
    const clang =
      Math.sin(2 * Math.PI * 920 * t) * Math.exp(-t * 22) * 0.35 +
      Math.sin(2 * Math.PI * 1480 * t) * Math.exp(-t * 30) * 0.2;
    data[i] = whoosh * 0.55 + clang;
  }
  return buffer;
}

function createFlameLoopBuffer(ctx) {
  const rate = ctx.sampleRate;
  const length = Math.floor(0.6 * rate);
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  let a = 0;
  let b = 0;
  for (let i = 0; i < length; i += 1) {
    const white = Math.random() * 2 - 1;
    a = a * 0.95 + white * 0.05;
    b = b * 0.8 + white * 0.2;
    const t = i / length;
    // Seamless-ish loop edge fade
    const edge = Math.min(t * 20, (1 - t) * 20, 1);
    data[i] = (a * 0.65 + b * 0.45) * edge * 0.9;
  }
  return buffer;
}

export class WeaponAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.master = null;
    this.buffers = {};
    this.flameSource = null;
    this.flameGain = null;
    this.flameActive = false;
  }

  async init() {
    if (this.ready) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;

    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);

    this.buffers.gun = createGunShotBuffer(this.ctx);
    this.buffers.melee = createMeleeBuffer(this.ctx);
    this.buffers.flame = createFlameLoopBuffer(this.ctx);
    this.ready = true;
  }

  _playBuffer(buffer, { volume = 1, playbackRate = 1 } = {}) {
    if (!this.ready || !buffer) return;
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = buffer;
    src.playbackRate.value = playbackRate;
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(this.master);
    src.start();
  }

  /** One discrete shot per call — stack/overlap for automatic fire. */
  playGunShot() {
    if (!this.ready) return;
    const rate = 0.92 + Math.random() * 0.16;
    this._playBuffer(this.buffers.gun, { volume: 0.85, playbackRate: rate });
  }

  playMeleeSwing() {
    if (!this.ready) return;
    const rate = 0.9 + Math.random() * 0.2;
    this._playBuffer(this.buffers.melee, { volume: 0.7, playbackRate: rate });
  }

  setFlamethrowerFiring(on) {
    if (!this.ready) return;

    if (on) {
      if (this.flameActive) return;
      this.flameActive = true;

      const gain = this.ctx.createGain();
      gain.gain.value = 0.0001;
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffers.flame;
      src.loop = true;
      src.connect(gain);
      gain.connect(this.master);
      src.start();
      gain.gain.exponentialRampToValueAtTime(0.45, this.ctx.currentTime + 0.08);

      this.flameSource = src;
      this.flameGain = gain;
      return;
    }

    if (!this.flameActive) return;
    this.flameActive = false;
    const gain = this.flameGain;
    const src = this.flameSource;
    this.flameGain = null;
    this.flameSource = null;
    if (!gain || !src) return;

    const now = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.001), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    try {
      src.stop(now + 0.14);
    } catch {
      // already stopped
    }
  }

  stopAll() {
    this.setFlamethrowerFiring(false);
  }
}
