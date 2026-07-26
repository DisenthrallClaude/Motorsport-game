import { clamp, damp } from './math.js';

/**
 * Keyboard + gamepad + touch input, normalised into the shape the vehicle
 * physics expects.
 */
export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.state = {
      throttle: 0, brake: 0, steer: 0, handbrake: 0,
      boost: false, shiftUp: false, shiftDown: false, manual: false,
    };
    this.raw = { steer: 0 };
    this.gamepadIndex = null;
    this.usingGamepad = false;
    this.touch = { active: false, steer: 0, throttle: 0, brake: 0 };
    this.onKey = null;

    this._down = (e) => {
      if (e.repeat) return;
      const k = e.code;
      this.keys.add(k);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(k)) e.preventDefault();
      if (this.onKey) this.onKey(k, e);
    };
    this._up = (e) => this.keys.delete(e.code);
    this._blur = () => this.keys.clear();

    target.addEventListener('keydown', this._down, { passive: false });
    target.addEventListener('keyup', this._up);
    target.addEventListener('blur', this._blur);
    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; this.usingGamepad = false; });

    this._target = target;
  }

  has(...codes) { return codes.some((c) => this.keys.has(c)); }

  /** Bind on-screen controls for touch devices. */
  attachTouch(root) {
    const zone = document.createElement('div');
    zone.className = 'touch-controls';
    zone.innerHTML = `
      <div class="tc-steer"><i class="tc-knob"></i></div>
      <div class="tc-pedals">
        <button class="tc-brake">BRAKE</button>
        <button class="tc-gas">GAS</button>
      </div>`;
    root.appendChild(zone);
    this.touchRoot = zone;

    const steerEl = zone.querySelector('.tc-steer');
    const knob = zone.querySelector('.tc-knob');
    let steerId = null, originX = 0;

    const setSteer = (v) => {
      this.touch.steer = clamp(v, -1, 1);
      knob.style.transform = `translate(${this.touch.steer * 46}px, -50%)`;
    };
    steerEl.addEventListener('pointerdown', (e) => {
      steerId = e.pointerId; originX = e.clientX;
      steerEl.setPointerCapture(e.pointerId);
      this.touch.active = true;
    });
    steerEl.addEventListener('pointermove', (e) => {
      if (e.pointerId !== steerId) return;
      setSteer((e.clientX - originX) / 62);
    });
    const endSteer = (e) => { if (e.pointerId === steerId) { steerId = null; setSteer(0); } };
    steerEl.addEventListener('pointerup', endSteer);
    steerEl.addEventListener('pointercancel', endSteer);

    const bind = (sel, key) => {
      const el = zone.querySelector(sel);
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); this.touch[key] = 1; this.touch.active = true; el.classList.add('on'); });
      const off = () => { this.touch[key] = 0; el.classList.remove('on'); };
      el.addEventListener('pointerup', off);
      el.addEventListener('pointerleave', off);
      el.addEventListener('pointercancel', off);
    };
    bind('.tc-gas', 'throttle');
    bind('.tc-brake', 'brake');
    return zone;
  }

  showTouch(v) { if (this.touchRoot) this.touchRoot.style.display = v ? '' : 'none'; }

  update(dt) {
    const s = this.state;
    s.shiftUp = false;
    s.shiftDown = false;

    // ── Gamepad ───────────────────────────────────────────────────────────
    let pad = null;
    if (navigator.getGamepads) {
      const pads = navigator.getGamepads();
      pad = this.gamepadIndex !== null ? pads[this.gamepadIndex] : (pads[0] || null);
      if (pad && !pad.connected) pad = null;
    }

    let throttle = 0, brake = 0, steer = 0, handbrake = 0, boost = false;

    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      const ax = dz(pad.axes[0] ?? 0);
      if (rt > 0.02 || lt > 0.02 || Math.abs(ax) > 0.02) this.usingGamepad = true;
      throttle = Math.max(throttle, rt);
      brake = Math.max(brake, lt);
      steer += ax;
      if (pad.buttons[0]?.pressed) handbrake = 1;
      if (pad.buttons[1]?.pressed) boost = true;
      if (pad.buttons[5]?.pressed && !this._padRB) s.shiftUp = true;
      if (pad.buttons[4]?.pressed && !this._padLB) s.shiftDown = true;
      this._padRB = pad.buttons[5]?.pressed;
      this._padLB = pad.buttons[4]?.pressed;
    }

    // ── Keyboard ──────────────────────────────────────────────────────────
    if (this.has('KeyW', 'ArrowUp')) throttle = 1;
    if (this.has('KeyS', 'ArrowDown')) brake = 1;
    if (this.has('KeyA', 'ArrowLeft')) steer -= 1;
    if (this.has('KeyD', 'ArrowRight')) steer += 1;
    if (this.has('Space')) handbrake = 1;
    if (this.has('ShiftLeft', 'ShiftRight')) boost = true;

    // ── Touch ─────────────────────────────────────────────────────────────
    if (this.touch.active) {
      throttle = Math.max(throttle, this.touch.throttle);
      brake = Math.max(brake, this.touch.brake);
      steer += this.touch.steer;
    }

    // Smooth digital steering into something analogue-feeling.
    const targetSteer = clamp(steer, -1, 1);
    const rate = Math.abs(targetSteer) > Math.abs(this.raw.steer) ? 7.5 : 12;
    this.raw.steer = damp(this.raw.steer, targetSteer, rate, dt);

    s.throttle = clamp(throttle, 0, 1);
    s.brake = clamp(brake, 0, 1);
    s.steer = clamp(this.raw.steer, -1, 1);
    s.handbrake = handbrake;
    s.boost = boost;
    return s;
  }

  dispose() {
    this._target.removeEventListener('keydown', this._down);
    this._target.removeEventListener('keyup', this._up);
    this._target.removeEventListener('blur', this._blur);
    this.touchRoot?.remove();
  }
}
