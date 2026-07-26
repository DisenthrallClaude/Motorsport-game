import * as THREE from 'three';
import { Engine, LAYER } from './core/engine.js';
import { Input } from './core/input.js';
import { AudioEngine } from './core/audio.js';
import { ChaseCamera, CAM_MODES } from './core/camera.js';
import { clamp, lerp, damp, formatTime, makeRNG, TAU } from './core/math.js';
import { World } from './world/world.js';
import { TrafficSystem } from './world/traffic.js';
import { Car, CAR_PRESETS } from './vehicle/car.js';
import { CarFX, RainSystem } from './vehicle/fx.js';
import { AIDriver } from './ai/driver.js';
import { updateRoadMaterials } from './render/materials.js';
import { HUD } from './ui/hud.js';
import { Menu } from './ui/menu.js';
import { THEMES } from './data/themes.js';

const RIVAL_NAMES = [
  'K. VOSS', 'M. ARAKI', 'L. DUBOIS', 'R. OKONKWO', 'S. LINDQVIST',
  'A. MORENO', 'D. HALVORSEN', 'T. NAKAMURA', 'J. ROSSI', 'C. BAPTISTE',
];

class Game {
  constructor() {
    this.canvas = document.getElementById('stage');
    this.state = 'boot';        // boot | menu | loading | countdown | racing | finished | paused
    this.quality = 'high';
    this.raceTime = 0;
    this.clock = new THREE.Clock();
    this.frame = 0;

    this.boot = document.getElementById('boot');
    this.bootFill = document.getElementById('bootFill');
    this.bootStatus = document.getElementById('bootStatus');
    this.fpsEl = document.getElementById('fps');
    this.photoHint = document.getElementById('photoHint');

    this._tmp = new THREE.Vector3();
    this._diag = {};
    this.showFps = false;
  }

  async init() {
    this._setBoot(0.08, 'STARTING RENDERER');
    this.engine = new Engine(this.canvas, this.quality);
    if (!this.engine.capabilities.webgl2) {
      this._setBoot(1, 'WEBGL2 UNAVAILABLE');
    }
    this.camera = new ChaseCamera(this.engine.camera);
    this.input = new Input(window);
    this.audio = new AudioEngine();
    this.hud = new HUD();

    await frame();
    this._setBoot(0.4, 'BUILDING INTERFACE');
    this.menu = new Menu((theme, opts) => this.startRace(theme, opts));

    this.input.onKey = (code, e) => this._onKey(code, e);
    if (matchMedia('(pointer: coarse)').matches) {
      this.input.attachTouch(document.body);
      this.input.showTouch(false);
    }

    // Photo-mode mouse orbit
    let dragging = false, lx = 0, ly = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.camera.photo) return;
      dragging = true; lx = e.clientX; ly = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.camera.orbitPhoto(e.clientX - lx, e.clientY - ly);
      lx = e.clientX; ly = e.clientY;
    });
    this.canvas.addEventListener('pointerup', () => { dragging = false; });
    this.canvas.addEventListener('wheel', (e) => {
      if (this.camera.photo) { this.camera.zoomPhoto(e.deltaY); e.preventDefault(); }
    }, { passive: false });

    document.getElementById('resRetry').addEventListener('click', () => this.restart());
    document.getElementById('resMenu').addEventListener('click', () => this.toMenu());
    document.getElementById('pResume').addEventListener('click', () => this.setPaused(false));
    document.getElementById('pRestart').addEventListener('click', () => this.restart());
    document.getElementById('pQuit').addEventListener('click', () => this.toMenu());

    const kick = () => { this.audio.start(); window.removeEventListener('pointerdown', kick); window.removeEventListener('keydown', kick); };
    window.addEventListener('pointerdown', kick);
    window.addEventListener('keydown', kick);

    this._setBoot(0.85, 'READY');
    await frame();
    await sleep(180);
    this._setBoot(1, 'READY');
    this.boot.classList.add('out');
    setTimeout(() => this.boot.classList.add('hidden'), 620);
    this.state = 'menu';
    this.menu.show(true);

    this.loop();
  }

  _setBoot(p, text) {
    if (this.bootFill) this.bootFill.style.width = `${Math.round(p * 100)}%`;
    if (text && this.bootStatus) this.bootStatus.textContent = text;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RACE SETUP
  // ════════════════════════════════════════════════════════════════════════
  async startRace(theme, opts) {
    if (this.state === 'loading') return;
    this.state = 'loading';
    this.lastOpts = opts;
    this.lastTheme = theme;

    this.menu.show(false);
    this.hud.show(false);
    document.getElementById('results').classList.add('hidden');
    this.boot.classList.remove('hidden', 'out');
    this._setBoot(0.02, `LOADING ${theme.name}`);
    await frame();

    if (opts.quality !== this.quality) {
      this.quality = opts.quality;
      this.engine.setQuality(opts.quality);
    }

    this._teardownRace();

    // ── World ─────────────────────────────────────────────────────────────
    this.engine.applyTheme(theme);
    this.world = new World(theme, (p, t) => {
      this._setBoot(0.05 + p * 0.72, t);
    });
    await this.world.build();
    this.engine.scene.add(this.world.group);
    this.track = this.world.track;

    this._setBoot(0.80, 'SPAWNING GRID');
    await frame();

    // ── Cars ──────────────────────────────────────────────────────────────
    const rivalCount = clamp(opts.rivals ?? 5, 0, 7);
    const fieldSize = rivalCount + 1;
    const startS = (theme.track.startS ?? 0) * this.track.length;
    const slots = this.track.gridSlots(fieldSize, startS);
    const rng = makeRNG(1234);

    this.cars = [];
    this.ais = [];

    // Player starts at the back so there's something to race for.
    const playerSlot = slots[Math.min(fieldSize - 1, slots.length - 1)];
    this.player = new Car({
      preset: CAR_PRESETS[0], isPlayer: true, track: this.track,
      name: 'YOU', night: theme.night,
    });
    this.player.physics.assists = opts.assists !== false;
    this.player.reset(playerSlot.pos, playerSlot.heading);
    this.player.setHeadlights(theme.night || (theme.rain ?? 0) > 0.5);
    this.engine.scene.add(this.player.object);
    this.cars.push(this.player);

    for (let i = 0; i < rivalCount; i++) {
      const preset = CAR_PRESETS[1 + (i % (CAR_PRESETS.length - 1))];
      const car = new Car({
        preset, isPlayer: false, track: this.track,
        name: RIVAL_NAMES[i % RIVAL_NAMES.length], night: theme.night,
      });
      const slot = slots[i];
      car.reset(slot.pos, slot.heading);
      car.setHeadlights(theme.night || (theme.rain ?? 0) > 0.5);
      this.engine.scene.add(car.object);
      this.cars.push(car);
      this.ais.push(new AIDriver(car, this.world, {
        skill: 0.66 + (i / Math.max(1, rivalCount)) * 0.30 + rng() * 0.06,
        seed: 100 + i * 17,
      }));
    }

    // ── Systems ───────────────────────────────────────────────────────────
    this.fx = new CarFX(this.engine.scene, theme);
    this.traffic = new TrafficSystem(this.engine.scene, this.track, theme, { seed: 4242 });
    this.rainAmount = theme.rain ?? 0;
    if (this.rainAmount > 0.08) {
      this.rain = new RainSystem(this.engine.scene, this.quality === 'low' ? 900 : 2400, {
        opacity: 0.34 + this.rainAmount * 0.2,
        color: theme.night ? 0xbfd4f0 : 0xd8e6ff,
        speed: 22 + this.rainAmount * 14,
      });
      this.rain.intensity = this.rainAmount;
    }

    // ── Race parameters ───────────────────────────────────────────────────
    this.laps = opts.laps ?? 2;
    this.fieldSize = fieldSize;
    // Target times scale with circuit length; tuned so 3 stars needs a clean run.
    const parSpeed = 30.5;   // m/s average for a 3-star lap
    this.starTime = (this.track.length / parSpeed) * this.laps;
    this.limitTime = this.starTime * 1.34;
    this.raceTime = 0;
    this.countdown = 3.6;
    this.finishedCars = [];

    for (const c of this.cars) {
      const q = this.track.nearest(c.physics.pos);
      c.trackS = q.s;
      c.lateral = q.lateral;
      c._startS = q.s;
      c._lastLapS = q.s;
      c.lap = 1;
      c.lapStart = 0;
      c.lapTimes = [];
      c.bestLap = Infinity;
      c.finished = false;
      c.totalProgress = 0;
      c._wrapCount = 0;
    }

    this.hud.setTrack(this.track);
    this.hud.setDriverName('APEX');
    this.hud.show(true);
    this.hud.update(0.016, this._hudState());
    this.camera.setMode(0);
    this.camera.snap();
    this.engine.postfx.grade.focus = 22;

    this._setBoot(1, 'GO');
    await frame();
    await sleep(140);
    this.boot.classList.add('out');
    setTimeout(() => this.boot.classList.add('hidden'), 620);

    this.input.showTouch(true);
    this.state = 'countdown';
    this.hud.notice('', 1);
    this.clock.getDelta();
  }

  _teardownRace() {
    if (this.world) {
      this.engine.scene.remove(this.world.group);
      this.world.dispose();
      this.world = null;
    }
    if (this.cars) {
      for (const c of this.cars) { this.engine.scene.remove(c.object); c.dispose(); }
      this.cars = null;
    }
    if (this.fx) { this.fx.dispose(); this.fx = null; }
    if (this.traffic) { this.traffic.dispose(); this.traffic = null; }
    if (this.rain) { this.rain.dispose(); this.rain = null; }
    this.ais = [];
    this.player = null;
  }

  restart() {
    document.getElementById('results').classList.add('hidden');
    document.getElementById('pause').classList.add('hidden');
    this.startRace(this.lastTheme, this.lastOpts);
  }

  toMenu() {
    document.getElementById('results').classList.add('hidden');
    document.getElementById('pause').classList.add('hidden');
    this.hud.show(false);
    this.input.showTouch(false);
    this._teardownRace();
    this.state = 'menu';
    this.menu.show(true);
  }

  setPaused(v) {
    if (this.state === 'racing' && v) {
      this.state = 'paused';
      document.getElementById('pause').classList.remove('hidden');
      this.audio.suspend();
    } else if (this.state === 'paused' && !v) {
      this.state = 'racing';
      document.getElementById('pause').classList.add('hidden');
      this.audio.resume();
      this.clock.getDelta();
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  INPUT
  // ════════════════════════════════════════════════════════════════════════
  _onKey(code) {
    if (code === 'KeyC' && this.player) {
      this.camera.cycle();
      this.hud.notice(CAM_MODES[this.camera.modeIndex].name, 900);
    }
    if (code === 'KeyR' && this.player && this.state === 'racing') this._resetToTrack();
    if (code === 'KeyP' && this.player) {
      if (this.camera.photo) {
        this.camera.exitPhoto();
        this.photoHint.classList.add('hidden');
        this.hud.fade(false);
        if (this.state === 'photo') this.state = 'racing';
      } else {
        this.camera.enterPhoto();
        this.photoHint.classList.remove('hidden');
        this.hud.fade(true);
        if (this.state === 'racing') this.state = 'photo';
      }
    }
    if (code === 'Escape' || code === 'KeyEscape') {
      if (this.state === 'racing') this.setPaused(true);
      else if (this.state === 'paused') this.setPaused(false);
    }
    if (code === 'KeyH') { this.hud.fade(!this.hud.root.classList.contains('fade')); }
    if (code === 'KeyF') { this.showFps = !this.showFps; this.fpsEl.classList.toggle('hidden', !this.showFps); }
    if (code === 'KeyM') { this.audio.mute(this.audio.enabled); }
  }

  _resetToTrack() {
    const p = this.player;
    const q = this.track.nearest(p.physics.pos, p.trackS);
    const a = this.track.at(q.s - 4);
    p.reset(a.pos.clone().addScaledVector(a.right, 0), a.heading);
    this.camera.snap();
    this.hud.notice('RESET', 700);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  LOOP
  // ════════════════════════════════════════════════════════════════════════
  loop() {
    requestAnimationFrame(() => this.loop());
    let dt = this.clock.getDelta();
    if (!isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = Math.min(dt, 1 / 20);
    this.frame++;

    const input = this.input.update(dt);

    if (this.state === 'menu' || this.state === 'boot' || this.state === 'loading') {
      this._renderIdle(dt);
      return;
    }

    const racing = this.state === 'racing';
    const countdown = this.state === 'countdown';
    const photo = this.state === 'photo';
    const active = racing || countdown || photo || this.state === 'finished';

    if (this.state === 'paused') {
      this.engine.render(0.0001, this.player.physics.pos, this.player.physics.groundY);
      return;
    }

    if (countdown) {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown - 0.6);
      if (n !== this._lastCount) {
        this._lastCount = n;
        if (n > 0) { this.hud.countdown(String(n)); this.audio.beep(false); }
        else if (n === 0) { this.hud.countdown('GO', true); this.audio.beep(true); }
      }
      if (this.countdown <= 0.6) {
        this.state = 'racing';
        this.raceTime = 0;
      }
    }

    // ── Simulate ──────────────────────────────────────────────────────────
    const sim = racing || this.state === 'finished';
    const playerInput = sim && !photo ? input : ZERO_INPUT;

    if (active) {
      if (sim) this.raceTime += dt;

      this.player.update(dt, this.player.finished ? AI_COAST : playerInput);
      for (const ai of this.ais) {
        if (sim) ai.update(dt, this.cars);
        else ai.car.update(dt, ZERO_INPUT);
      }
      if (!sim) {
        // Hold everyone on the grid during the countdown.
        for (const c of this.cars) {
          c.physics.vz *= 0.86; c.physics.vx *= 0.86; c.physics.yawRate *= 0.7;
        }
      }

      this._updateProgress(dt);
      this.traffic.update(dt, this.player);
      this._trafficCollisions(dt);
      this.fx.update(dt, this.player, this.rainAmount);
      if (this.rain) {
        this._tmp.set(
          Math.sin(this.player.physics.yaw) * this.player.physics.vz,
          0,
          Math.cos(this.player.physics.yaw) * this.player.physics.vz
        );
        this.rain.update(dt, this.engine.camera, this._tmp);
      }
      this._skillTracking(dt);
    }

    // ── Camera ────────────────────────────────────────────────────────────
    this.camera.update(dt, this.player, this.player.physics.groundY);
    if (this.player.collisionImpulse > 0.25 && !this._lastImpact) {
      this.audio.thud(this.player.collisionImpulse);
      this.camera.addShake(this.player.collisionImpulse * 0.8);
    }
    this._lastImpact = this.player.collisionImpulse > 0.25;

    // ── Render ────────────────────────────────────────────────────────────
    const g = this.engine.postfx.grade;
    // Keep the car sharp and let the world fall away behind it.
    g.focus = damp(g.focus, this.camera.mode.dist < 0 ? 30 : this.camera.mode.dist + 4, 4, dt);
    this.engine.postfx.motionScale = photo ? 0 : 1;
    updateRoadMaterials(this.world.roadMaterials, this.engine.reflector, this.engine.time, this.rainAmount);

    this.engine.render(dt, this.player.physics.pos, this.player.physics.groundY);

    // ── Audio + HUD ───────────────────────────────────────────────────────
    this.audio.update(dt, this.player.physics, {
      interior: this.camera.mode.id === 'cockpit' || this.camera.mode.id === 'hood',
    });
    if (!photo) this.hud.update(dt, this._hudState());

    this._adaptQuality(dt);
    if (this.showFps) this._updateFpsReadout();
  }

  _renderIdle(dt) {
    // Slow orbit over the currently selected city's colours — cheap, but it
    // means the menu is never a dead black screen.
    const cam = this.engine.camera;
    const t = this.engine.time;
    if (!this._idleTheme || this._idleTheme !== THEMES[this.menu?.selected ?? 0]) {
      this._idleTheme = THEMES[this.menu?.selected ?? 0];
      this.engine.applyTheme(this._idleTheme);
    }
    cam.position.set(Math.sin(t * 0.08) * 40, 16 + Math.sin(t * 0.05) * 5, Math.cos(t * 0.08) * 40);
    cam.lookAt(0, 10, 0);
    this._tmp.set(0, 0, 0);
    this.engine.render(dt, this._tmp, 0);
  }

  // ── Race progress / positions / laps ────────────────────────────────────
  _updateProgress(dt) {
    const L = this.track.length;
    for (const c of this.cars) {
      const prev = c._prevS ?? c.trackS;
      const s = c.trackS;
      // Detect a wrap past the start/finish line.
      let d = s - prev;
      if (d < -L * 0.5) { c._wrapCount++; d += L; }
      else if (d > L * 0.5) { c._wrapCount--; d -= L; }
      c._prevS = s;
      c.totalProgress = c._wrapCount * L + s;

      if (!c.finished) {
        const lapsDone = Math.floor((c.totalProgress - c._startS) / L) + 1;
        if (lapsDone > c.lap) {
          const t = this.raceTime;
          const lapTime = t - c.lapStart;
          c.lapStart = t;
          c.lapTimes.push(lapTime);
          c.bestLap = Math.min(c.bestLap, lapTime);
          c.lap = lapsDone;
          if (c === this.player) {
            if (c.lap <= this.laps) {
              this.hud.notice(`LAP ${Math.min(c.lap, this.laps)} / ${this.laps}`, 1500);
              this.hud.skill('LAP ' + formatTime(lapTime), 0);
            }
          }
          if (c.lap > this.laps) {
            c.finished = true;
            c.finishTime = t;
            this.finishedCars.push(c);
            if (c === this.player) this._finishRace();
          }
        }
      }
    }

    // Positions
    const order = [...this.cars].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return b.totalProgress - a.totalProgress;
    });
    order.forEach((c, i) => { c.position = i + 1; });

    // Time limit
    if (this.state === 'racing' && this.raceTime > this.limitTime && !this.player.finished) {
      this.player.finished = true;
      this.player.finishTime = this.raceTime;
      this._finishRace(true);
    }
  }

  _trafficCollisions(dt) {
    const p = this.player;
    const pos = p.physics.pos;
    let nearMiss = false;
    this.traffic.forEachNear(pos, 9, (v, x, z) => {
      const dx = x - pos.x, dz = z - pos.z;
      const dist = Math.hypot(dx, dz);
      const rad = 2.4 + v.group.spec.width * 0.4;
      if (dist < rad) {
        // Shove the player aside and scrub speed.
        const nx = dx / (dist || 1), nz = dz / (dist || 1);
        const pen = rad - dist;
        p.physics.pos.x -= nx * pen * 0.9;
        p.physics.pos.z -= nz * pen * 0.9;
        const impact = clamp(p.physics.speed / 40, 0, 1);
        p.physics.vz *= 1 - 0.28 * impact;
        p.physics.vx -= (nx * Math.sin(p.physics.yaw) + nz * Math.cos(p.physics.yaw)) * 3;
        p.physics.yawRate += (Math.random() - 0.5) * 1.4 * impact;
        p.collisionImpulse = Math.max(p.collisionImpulse, impact);
        v.baseSpeed *= 0.7;
      } else if (dist < rad + 2.4 && p.physics.speed > 22) {
        nearMiss = true;
      }
    });
    this._nearMissCool = Math.max(0, (this._nearMissCool ?? 0) - dt);
    if (nearMiss && this._nearMissCool <= 0) {
      this._nearMissCool = 0.7;
      this.hud.skill('NEAR MISS', 40);
      this.score = (this.score ?? 0) + 40;
    }
  }

  _skillTracking(dt) {
    const ph = this.player.physics;
    // Drift
    if (ph.driftTime > 0.7) {
      this._driftAcc = (this._driftAcc ?? 0) + dt;
      if (this._driftAcc > 1.0) {
        this._driftAcc = 0;
        const pts = Math.round(30 + Math.abs(ph.driftAngle) * 220 + ph.speed);
        this.hud.skill('DRIFT', pts);
        this.score = (this.score ?? 0) + pts;
      }
    } else this._driftAcc = 0;

    // Air
    if (ph.airTime > 0.35 && !this._wasAir) { this._wasAir = true; this._airStart = ph.airTime; }
    if (this._wasAir && !ph.airborne) {
      this._wasAir = false;
      this.hud.skill('AIR', Math.round(120));
      this.score = (this.score ?? 0) + 120;
      this.camera.addShake(0.5);
    }

    // Speed milestone
    const mph = ph.speedMph;
    if (mph > 180 && !this._speed180) { this._speed180 = true; this.hud.skill('180 MPH', 150); }
    if (mph < 120) this._speed180 = false;
  }

  _finishRace(timeout = false) {
    this.state = 'finished';
    const p = this.player;
    const t = p.finishTime;
    const stars = timeout ? 0
      : t <= this.starTime ? 3
        : t <= this.starTime * 1.12 ? 2
          : t <= this.limitTime ? 1 : 0;

    document.getElementById('resHead').textContent = timeout ? 'TIME EXPIRED' : (p.position === 1 ? 'VICTORY' : 'RACE COMPLETE');
    document.getElementById('resTime').textContent = formatTime(t);
    const sEl = document.getElementById('resStars');
    sEl.innerHTML = [0, 1, 2].map((i) => (i < stars ? '<b>★</b>' : '★')).join(' ');

    const rows = document.getElementById('resRows');
    rows.innerHTML = '';
    const order = [...this.cars].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return b.totalProgress - a.totalProgress;
    });
    order.forEach((c, i) => {
      const tr = document.createElement('tr');
      if (c === p) tr.className = 'me';
      const best = c.bestLap < Infinity ? formatTime(c.bestLap) : '—';
      tr.innerHTML = `<td>${i + 1}</td><td>${c === p ? 'YOU' : c.name}</td><td>${c.finished ? formatTime(c.finishTime) : best}</td>`;
      rows.appendChild(tr);
    });

    setTimeout(() => {
      document.getElementById('results').classList.remove('hidden');
    }, 1400);
    this.hud.notice(p.position === 1 ? 'FINISH — P1' : `FINISH — P${p.position}`, 2600);
  }

  // ── HUD state ───────────────────────────────────────────────────────────
  _hudState() {
    const p = this.player;
    const ph = p.physics;
    const remaining = Math.max(0, this.limitTime - this.raceTime);
    const rivals = this.cars.map((c) => ({
      x: c.physics.pos.x, z: c.physics.pos.z, isPlayer: c === p,
    }));
    // Distance left in the race.
    const total = this.track.length * this.laps;
    const done = clamp(p.totalProgress - p._startS, 0, total);
    return {
      timeLeft: remaining,
      starTime: this.starTime,
      current: this.raceTime,
      objective: this.state === 'finished'
        ? 'Race complete'
        : (p.lap >= this.laps ? 'Final lap — hold your position' : 'Reach the destination'),
      lapText: `${clamp(p.lap, 1, this.laps)}/${this.laps}`,
      position: p.position ?? 1,
      fieldSize: this.fieldSize,
      distance: Math.max(0, total - done),
      mph: ph.speedMph,
      gear: ph.gear,
      reversing: ph.vz < -0.6,
      rpm: ph.rpm,
      redline: ph.p.redline,
      boost: ph.boost,
      boostMax: ph.p.boostMax,
      abs: ph.absActive, tcs: ph.tcsActive, stm: ph.stmActive,
      heading: ph.yaw,
      playerX: ph.pos.x, playerZ: ph.pos.z,
      trackS: p.trackS,
      mapRange: 380,
      rivals,
    };
  }

  // ── Adaptive quality ────────────────────────────────────────────────────
  _adaptQuality(dt) {
    this._perfAcc = (this._perfAcc ?? 0) + dt;
    if (this._perfAcc < 3) return;
    this._perfAcc = 0;
    const fps = this.engine.fps;
    const order = ['low', 'med', 'high', 'ultra'];
    const idx = order.indexOf(this.quality);
    if (fps < 34 && idx > 0 && !this._userQuality) {
      this.quality = order[idx - 1];
      this.engine.setQuality(this.quality);
      this.hud.notice(`QUALITY → ${this.quality.toUpperCase()}`, 1400);
    }
  }

  _updateFpsReadout() {
    if (this.frame % 12) return;
    const r = this.engine.renderer.info.render;
    this.fpsEl.textContent =
      `${this.engine.fps.toFixed(0)} FPS  ·  ${this.quality.toUpperCase()}  ·  ${this.engine.postfx.width}×${this.engine.postfx.height}`;
  }
}

const ZERO_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: 0, boost: false, shiftUp: false, shiftDown: false };
const AI_COAST = { throttle: 0, brake: 0.35, steer: 0, handbrake: 0, boost: false, shiftUp: false, shiftDown: false };

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────────────────────
const game = new Game();
window.__game = game;
game.init().catch((e) => {
  console.error(e);
  const st = document.getElementById('bootStatus');
  if (st) st.textContent = `ERROR: ${e.message}`;
});

// Diagnostics hook used by the screenshot harness.
window.__diag = () => {
  const g = game;
  return {
    state: g.state,
    frame: g.frame,
    fps: g.engine ? +g.engine.fps.toFixed(1) : 0,
    quality: g.quality,
    webgl2: g.engine?.capabilities?.webgl2,
    rt: g.engine ? [g.engine.postfx.width, g.engine.postfx.height] : null,
    buildings: g.world?.buildingCount ?? 0,
    trackLength: g.track ? Math.round(g.track.length) : 0,
    cars: g.cars?.length ?? 0,
    traffic: g.traffic?.vehicles?.length ?? 0,
    speed: g.player ? +g.player.physics.speedMph.toFixed(1) : 0,
    pos: g.player ? [+g.player.physics.pos.x.toFixed(1), +g.player.physics.pos.z.toFixed(1)] : null,
    drawCalls: g.engine?.renderer.info.render.calls,
    triangles: g.engine?.renderer.info.render.triangles,
    programs: g.engine?.renderer.info.programs?.length,
    memory: g.engine?.renderer.info.memory,
  };
};

// ── Deep links ─────────────────────────────────────────────────────────────
//   ?city=london&auto=1            boot straight into a race
//   &t=0.30&speed=38&cam=1         park the car at a point on the circuit for
//                                  a repeatable QA/marketing shot
const params = new URLSearchParams(location.search);
if (params.get('city')) {
  const wait = setInterval(() => {
    if (game.state !== 'menu') return;
    clearInterval(wait);
    const idx = THEMES.findIndex((t) => t.id === params.get('city'));
    if (idx < 0) return;
    game.menu.select(idx);
    if (params.get('auto') === '0') return;

    game.startRace(THEMES[idx], {
      laps: Number(params.get('laps') || 2),
      rivals: Number(params.get('rivals') ?? 5),
      quality: params.get('q') || 'high',
      assists: params.get('assists') !== '0',
    }).then(() => {
      if (params.get('cam') !== null) game.camera.setMode(Number(params.get('cam')));
      if (params.get('t') === null) return;
      // Freeze-frame mode: drop the car on the racing line at `t`, hold a
      // constant speed, and skip the countdown so shots are deterministic.
      const place = () => {
        const tk = game.track;
        const s = Number(params.get('t')) * tk.length;
        const a = tk.at(s);
        const off = game.world.racingLine
          ? game.world.racingLine[Math.floor(s / tk.spacing) % tk.count] : 0;
        game.player.reset(a.pos.clone().addScaledVector(a.right, off * 0.5), a.heading);
        const spd = Number(params.get('speed') ?? 30);
        game.player.physics.vz = spd;
        game.player.physics.rpm = 4200;
        game.player.physics.gear = 3;
        // Line the rivals up just ahead so the shot has traffic in it.
        game.cars.forEach((c, i) => {
          if (c === game.player) return;
          const b = tk.at(s + 18 + i * 13);
          c.reset(b.pos.clone().addScaledVector(b.right, ((i % 2) ? 3.2 : -3.2)), b.heading);
          c.physics.vz = spd * 0.98;
        });
        game.camera.snap();
        game.state = 'racing';
        game.countdown = 0;
        game.hud.show(true);
      };
      setTimeout(place, 400);
      if (params.get('freeze') === '1') {
        setTimeout(() => {
          game.cars.forEach((c) => { c.physics.vz = 0; c.physics.vx = 0; });
        }, 1200);
      }
    });
  }, 120);
}
