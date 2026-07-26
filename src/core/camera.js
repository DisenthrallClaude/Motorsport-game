import * as THREE from 'three';
import { clamp, lerp, damp, TAU, angleDelta, smoothstep } from './math.js';

/**
 * Chase camera rig.
 * The default preset is framed to match a classic open-world racer: low,
 * close, car sitting in the lower-centre third with the horizon just above
 * the mid-line.
 */
export const CAM_MODES = [
  { id: 'chase',    name: 'CHASE',    dist: 6.35, height: 2.05, look: 1.05, lookAhead: 9.5,  fov: 58, roll: 0.55, shake: 1.0 },
  { id: 'chasefar', name: 'WIDE',     dist: 9.20, height: 3.15, look: 1.20, lookAhead: 14.0, fov: 55, roll: 0.42, shake: 0.8 },
  { id: 'bumper',   name: 'BUMPER',   dist: -1.9, height: 0.72, look: 0.72, lookAhead: 22.0, fov: 68, roll: 0.30, shake: 1.4 },
  { id: 'hood',     name: 'HOOD',     dist: -0.4, height: 1.20, look: 1.05, lookAhead: 20.0, fov: 63, roll: 0.35, shake: 1.2 },
  { id: 'cockpit',  name: 'COCKPIT',  dist: 0.55, height: 1.16, look: 1.10, lookAhead: 18.0, fov: 66, roll: 0.75, shake: 1.3 },
];

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.modeIndex = 0;
    this.mode = CAM_MODES[0];

    this.pos = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);

    this._desired = new THREE.Vector3();
    this._lookPoint = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();

    this.yawSmooth = 0;
    this.rollSmooth = 0;
    this.fovSmooth = 58;
    this.shake = 0;
    this.shakeTime = 0;
    this.initialised = false;

    // Photo mode
    this.photo = false;
    this.photoYaw = 0.6;
    this.photoPitch = 0.22;
    this.photoDist = 9;
  }

  setMode(i) {
    this.modeIndex = ((i % CAM_MODES.length) + CAM_MODES.length) % CAM_MODES.length;
    this.mode = CAM_MODES[this.modeIndex];
    this.initialised = false;
  }
  cycle() { this.setMode(this.modeIndex + 1); }

  addShake(amount) { this.shake = Math.min(1.6, this.shake + amount); }

  snap() { this.initialised = false; }

  /**
   * @param {number} dt
   * @param {Car} car
   * @param {number} groundY   surface height near the car (keeps the cam level)
   */
  update(dt, car, groundY = 0) {
    const cam = this.camera;
    const ph = car.physics;
    const M = this.mode;
    const spd = ph.speed;

    if (this.photo) return this._updatePhoto(dt, car);

    // ── Where the camera wants to be ─────────────────────────────────────
    // Follow the car's heading, but lag it slightly through corners so you
    // can see where the car is pointing during a slide.
    const driftLead = clamp(ph.driftAngle * 0.55, -0.42, 0.42);
    const targetYaw = ph.yaw + driftLead;
    if (!this.initialised) {
      this.yawSmooth = targetYaw;
    } else {
      const d = angleDelta(this.yawSmooth, targetYaw);
      // Faster = tighter follow, so the camera never feels loose at speed.
      const follow = lerp(4.2, 9.0, clamp(spd / 55, 0, 1));
      this.yawSmooth += d * (1 - Math.exp(-follow * dt));
    }

    const s = Math.sin(this.yawSmooth), c = Math.cos(this.yawSmooth);
    // Pull back and drop slightly as speed rises.
    const speedT = clamp(spd / 78, 0, 1);
    const dist = M.dist * (1 + speedT * 0.16);
    const height = M.height + speedT * 0.10;

    this._desired.set(
      ph.pos.x - s * dist,
      ph.pos.y + height,
      ph.pos.z - c * dist
    );

    if (!this.initialised) {
      this.pos.copy(this._desired);
      this.fovSmooth = M.fov;
      this.initialised = true;
    } else {
      // Critically-damped spring; stiffer vertically so crests don't wobble.
      this.pos.x = damp(this.pos.x, this._desired.x, 11, dt);
      this.pos.z = damp(this.pos.z, this._desired.z, 11, dt);
      this.pos.y = damp(this.pos.y, this._desired.y, 7.5, dt);
    }

    // Never let the camera sink through the road.
    const floor = groundY + (M.dist < 0 ? 0.35 : 0.75);
    if (this.pos.y < floor) this.pos.y = floor;

    // ── Look target: ahead of the car along its velocity ─────────────────
    const lookAhead = M.lookAhead * (0.7 + speedT * 0.7);
    const fs = Math.sin(ph.yaw), fc = Math.cos(ph.yaw);
    this._lookPoint.set(
      ph.pos.x + fs * lookAhead,
      ph.pos.y + M.look + lookAhead * 0.012,
      ph.pos.z + fc * lookAhead
    );
    if (!this._target0) this._target0 = this._lookPoint.clone();
    this._target0.x = damp(this._target0.x, this._lookPoint.x, 13, dt);
    this._target0.y = damp(this._target0.y, this._lookPoint.y, 10, dt);
    this._target0.z = damp(this._target0.z, this._lookPoint.z, 13, dt);
    this.target.copy(this._target0);

    // ── FOV: opens up with speed and boost ───────────────────────────────
    const fovTarget = M.fov + speedT * 11 + (ph.boostActive ? 6 : 0);
    this.fovSmooth = damp(this.fovSmooth, fovTarget, 4.5, dt);

    // ── Roll: bank into the corner ───────────────────────────────────────
    const rollTarget = clamp(-ph.lateralG * 0.030 * M.roll - ph.driftAngle * 0.05 * M.roll, -0.10, 0.10);
    this.rollSmooth = damp(this.rollSmooth, rollTarget, 5, dt);

    // ── Shake: road noise, kerbs, impacts, wheelspin ─────────────────────
    this.shake = Math.max(0, this.shake - dt * 2.4);
    const baseShake = clamp(spd / 90, 0, 1) * 0.32
      + car.scrape * 0.7
      + ph.wheelSpin * 0.18
      + car.collisionImpulse * 1.4
      + (ph.boostActive ? 0.2 : 0);
    const shakeAmount = (this.shake + baseShake) * M.shake;
    this.shakeTime += dt * (14 + spd * 0.25);
    const sx = Math.sin(this.shakeTime * 1.7) * Math.sin(this.shakeTime * 0.71);
    const sy = Math.sin(this.shakeTime * 2.3 + 1.7) * Math.sin(this.shakeTime * 0.93);

    // ── Apply ────────────────────────────────────────────────────────────
    if (M.dist < 0 || M.id === 'cockpit') {
      // Interior cameras ride with the body, so use the car's own transform.
      this._v.set(M.id === 'cockpit' ? -0.38 : 0, M.height, -M.dist);
      this._v.applyAxisAngle(this.up, ph.yaw);
      cam.position.set(ph.pos.x + this._v.x, ph.pos.y + this._v.y, ph.pos.z + this._v.z);
      cam.position.y += Math.sin(this.shakeTime * 3.1) * shakeAmount * 0.012;
    } else {
      cam.position.copy(this.pos);
      cam.position.x += sx * shakeAmount * 0.055;
      cam.position.y += sy * shakeAmount * 0.045;
    }

    cam.up.set(0, 1, 0);
    cam.lookAt(this.target);
    cam.rotateZ(this.rollSmooth + sx * shakeAmount * 0.010 + (M.id === 'cockpit' ? ph.roll * 0.7 : 0));
    if (Math.abs(cam.fov - this.fovSmooth) > 0.01) {
      cam.fov = this.fovSmooth;
      cam.updateProjectionMatrix();
    }
  }

  _updatePhoto(dt, car) {
    const cam = this.camera;
    const ph = car.physics;
    const cy = Math.cos(this.photoPitch);
    this._v.set(
      Math.sin(this.photoYaw) * cy,
      Math.sin(this.photoPitch),
      Math.cos(this.photoYaw) * cy
    ).multiplyScalar(this.photoDist);
    cam.position.copy(ph.pos).add(this._v).add(this._v2.set(0, 0.7, 0));
    cam.up.set(0, 1, 0);
    cam.lookAt(ph.pos.x, ph.pos.y + 0.6, ph.pos.z);
    if (cam.fov !== this.photoFov) {
      cam.fov = this.photoFov ?? 46;
      cam.updateProjectionMatrix();
    }
  }

  enterPhoto() { this.photo = true; this.photoFov = 46; }
  exitPhoto() { this.photo = false; this.initialised = false; }

  orbitPhoto(dx, dy) {
    this.photoYaw -= dx * 0.006;
    this.photoPitch = clamp(this.photoPitch + dy * 0.004, -0.35, 1.2);
  }
  zoomPhoto(d) { this.photoDist = clamp(this.photoDist + d * 0.01, 3, 40); }
}
