import { clamp, lerp } from './math.js';

/**
 * Fully synthesised audio — no asset downloads.
 * The engine is an additive stack of saw oscillators at the firing harmonics
 * plus filtered noise, which gives a convincing V12 wail across the rev range.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.masterVolume = 0.65;
    this._started = false;
  }

  /** Must be called from a user gesture. */
  async start() {
    if (this._started) return;
    this._started = true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this._build();
      this.ready = true;
    } catch (e) {
      this.ready = false;
    }
  }

  _noiseBuffer(seconds = 2) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      // Slight pink tint reads as "air" rather than hiss.
      last = 0.98 * last + 0.02 * white;
      d[i] = (white * 0.7 + last * 3.2) * 0.32;
    }
    return buf;
  }

  _build() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;

    // A gentle limiter keeps the mix from clipping when everything fires.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 22;
    this.comp.ratio.value = 8;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.16;
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    const noiseBuf = this._noiseBuffer(2.5);
    this._noiseBuf = noiseBuf;

    // ── ENGINE ────────────────────────────────────────────────────────────
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 0.9;
    this.engineGain.connect(this.engineFilter);
    this.engineFilter.connect(this.master);

    // Harmonic stack: sub, fundamental, and the upper orders that give it bite.
    this.oscs = [];
    const harmonics = [
      { mul: 0.5, gain: 0.30, type: 'sawtooth', detune: -6 },
      { mul: 1.0, gain: 0.42, type: 'sawtooth', detune: 0 },
      { mul: 1.5, gain: 0.16, type: 'square', detune: 5 },
      { mul: 2.0, gain: 0.22, type: 'sawtooth', detune: 9 },
      { mul: 3.0, gain: 0.10, type: 'sawtooth', detune: -11 },
      { mul: 4.0, gain: 0.06, type: 'sawtooth', detune: 14 },
    ];
    for (const h of harmonics) {
      const o = ctx.createOscillator();
      o.type = h.type;
      o.frequency.value = 80 * h.mul;
      o.detune.value = h.detune;
      const g = ctx.createGain();
      g.gain.value = h.gain;
      o.connect(g);
      g.connect(this.engineGain);
      o.start();
      this.oscs.push({ o, g, mul: h.mul, base: h.gain });
    }

    // Induction roar
    this.indNoise = ctx.createBufferSource();
    this.indNoise.buffer = noiseBuf;
    this.indNoise.loop = true;
    this.indFilter = ctx.createBiquadFilter();
    this.indFilter.type = 'bandpass';
    this.indFilter.frequency.value = 420;
    this.indFilter.Q.value = 1.1;
    this.indGain = ctx.createGain();
    this.indGain.gain.value = 0;
    this.indNoise.connect(this.indFilter);
    this.indFilter.connect(this.indGain);
    this.indGain.connect(this.master);
    this.indNoise.start();

    // ── TYRES ─────────────────────────────────────────────────────────────
    this.tyreNoise = ctx.createBufferSource();
    this.tyreNoise.buffer = noiseBuf;
    this.tyreNoise.loop = true;
    this.tyreFilter = ctx.createBiquadFilter();
    this.tyreFilter.type = 'bandpass';
    this.tyreFilter.frequency.value = 1900;
    this.tyreFilter.Q.value = 7.5;
    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0;
    this.tyreNoise.connect(this.tyreFilter);
    this.tyreFilter.connect(this.tyreGain);
    this.tyreGain.connect(this.master);
    this.tyreNoise.start();

    // ── ROAD / WIND ───────────────────────────────────────────────────────
    this.windNoise = ctx.createBufferSource();
    this.windNoise.buffer = noiseBuf;
    this.windNoise.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 700;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windNoise.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    this.windNoise.start();
  }

  /** Per-frame update from the player's physics state. */
  update(dt, ph, opts = {}) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const smooth = (param, value, t = 0.04) => {
      param.setTargetAtTime(value, now, t);
    };

    const rpm = ph.rpm;
    const load = clamp(ph.throttle * 0.85 + (ph.boostActive ? 0.2 : 0), 0, 1);
    // Firing frequency of a V12 at this crank speed.
    const f0 = clamp((rpm / 60) * 3.0, 26, 480);

    for (const h of this.oscs) {
      smooth(h.o.frequency, f0 * h.mul, 0.02);
      // Upper orders come in with load — that's what "opening up" sounds like.
      const lift = h.mul >= 2 ? lerp(0.35, 1.35, load) : lerp(0.9, 1.05, load);
      smooth(h.g.gain, h.base * lift, 0.05);
    }

    const rev = clamp(rpm / ph.p.redline, 0, 1.05);
    smooth(this.engineFilter.frequency, 380 + rev * 3400 + load * 2600, 0.05);
    smooth(this.engineFilter.Q, 0.7 + load * 1.6, 0.08);

    const shiftCut = ph.shiftTimer > 0 ? 0.25 : 1;
    smooth(this.engineGain.gain, (0.10 + load * 0.30 + rev * 0.10) * shiftCut, 0.03);

    smooth(this.indFilter.frequency, 260 + rev * 1500, 0.06);
    smooth(this.indGain.gain, (0.02 + load * 0.15 + rev * 0.06) * shiftCut, 0.05);

    // Tyres: squeal from slip, scrub from wheelspin.
    const slip = Math.max(Math.abs(ph.slipFront), Math.abs(ph.slipRear));
    const squeal = clamp((slip - 0.10) * 3.4, 0, 1) * clamp(ph.speed / 12, 0, 1);
    const spin = ph.wheelSpin * clamp(ph.speed / 6, 0, 1);
    smooth(this.tyreGain.gain, clamp(squeal * 0.16 + spin * 0.10, 0, 0.26), 0.05);
    smooth(this.tyreFilter.frequency, 1350 + squeal * 1400 + spin * 500, 0.06);

    // Wind + road roar.
    const spd = clamp(ph.speed / 90, 0, 1.3);
    smooth(this.windGain.gain, spd * 0.16 * (opts.interior ? 0.5 : 1), 0.1);
    smooth(this.windFilter.frequency, 340 + spd * 1500, 0.1);

    if (ph.gear !== this._lastGear) {
      if (this._lastGear !== undefined && ph.gear > this._lastGear) this.blip(0.08);
      this._lastGear = ph.gear;
    }
  }

  /** Short percussive click used for shifts and UI. */
  blip(vol = 0.1, freq = 180, dur = 0.09, type = 'square') {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, now);
    o.frequency.exponentialRampToValueAtTime(freq * 0.45, now + dur);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vol, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    o.connect(g); g.connect(this.master);
    o.start(now); o.stop(now + dur + 0.02);
  }

  /** Impact / collision thud. */
  thud(strength = 1) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(700, now);
    f.frequency.exponentialRampToValueAtTime(90, now + 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(clamp(strength, 0, 1) * 0.5, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(now); src.stop(now + 0.4);
  }

  /** Countdown / start beeps. */
  beep(high = false) {
    this.blip(high ? 0.20 : 0.14, high ? 880 : 440, high ? 0.42 : 0.16, 'sine');
  }

  setVolume(v) {
    this.masterVolume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.masterVolume;
  }

  mute(on) {
    this.enabled = !on;
    if (this.master) this.master.gain.value = on ? 0 : this.masterVolume;
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
}
