import * as THREE from 'three';
import { clamp, lerp, damp, TAU, approach, smoothstep, saturate } from '../core/math.js';

// ────────────────────────────────────────────────────────────────────────────
//  Arcade-sim vehicle model.
//  A bicycle model with separate front/rear slip angles, load transfer and a
//  friction circle. That combination is what makes the car rotate on throttle
//  and hold a drift instead of feeling like it's on rails.
// ────────────────────────────────────────────────────────────────────────────

export const DEFAULT_SETUP = {
  mass: 1480,
  wheelbase: 2.78,
  track: 1.72,
  cgHeight: 0.38,
  cgBias: 0.44,           // fraction of wheelbase from front axle to CG
  yawInertia: 1900,

  // Engine
  peakTorque: 720,        // Nm at the crank
  redline: 8600,
  idleRpm: 950,
  gearRatios: [3.35, 2.28, 1.72, 1.36, 1.12, 0.94, 0.80],
  finalDrive: 3.9,
  drivetrainEff: 0.90,
  shiftTime: 0.16,
  wheelRadius: 0.355,

  // Grip
  tireGrip: 1.62,
  frontGripBias: 1.00,
  rearGripBias: 1.045,
  pacejkaB: 9.2,
  pacejkaC: 1.55,
  pacejkaE: 0.96,

  // Aero & resistance
  dragArea: 0.72,         // Cd*A
  downforceF: 1.55,
  downforceR: 2.35,
  rollResist: 12.5,

  // Brakes
  brakeTorque: 19500,
  brakeBias: 0.62,
  handbrakeGripScale: 0.30,

  // Steering
  maxSteer: 0.60,         // radians at the road wheel
  steerSpeedFalloff: 0.66,
  steerRate: 5.6,
  steerReturn: 7.5,
  countersteerAssist: 0.55,

  // Assists
  absStrength: 0.9,
  tcsStrength: 0.75,
  stabilityStrength: 0.55,

  // Boost
  boostForce: 7200,
  boostMax: 4.5,
  boostRegen: 0.34,
};

export class VehiclePhysics {
  constructor(setup = {}) {
    this.p = { ...DEFAULT_SETUP, ...setup };

    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.vx = 0;            // body-frame lateral velocity (+ = right)
    this.vz = 0;            // body-frame forward velocity
    this.yawRate = 0;
    this.vy = 0;            // vertical (jumps / crests)

    this.gear = 1;
    this.rpm = this.p.idleRpm;
    this.shiftTimer = 0;
    this.clutch = 1;

    this.steer = 0;
    this.steerTarget = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = 0;
    this.boost = this.p.boostMax;
    this.boostActive = false;

    this.slipFront = 0;
    this.slipRear = 0;
    this.loadFront = 0.5;
    this.loadRear = 0.5;
    this.lateralG = 0;
    this.longG = 0;
    this.wheelSpin = 0;      // 0..1 how much the rears are lit up
    this.airborne = false;
    this.groundY = 0;
    this.surfaceGrip = 1;
    this.brakeHeat = 0;

    this.assists = true;
    this.absActive = false;
    this.tcsActive = false;
    this.stmActive = false;

    this.odometer = 0;
    this.driftAngle = 0;
    this.driftTime = 0;
    this.airTime = 0;

    this._wheelAngles = [0, 0, 0, 0];
    this._susp = [0, 0, 0, 0];
  }

  get speed() { return Math.hypot(this.vx, this.vz); }
  get speedKmh() { return this.speed * 3.6; }
  get speedMph() { return this.speed * 2.2369363; }
  get forward() { return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }

  reset(pos, yaw) {
    this.pos.copy(pos);
    this.yaw = yaw;
    this.vx = this.vz = this.vy = 0;
    this.yawRate = 0;
    this.gear = 1;
    this.rpm = this.p.idleRpm;
    this.steer = this.steerTarget = 0;
    this.pitch = this.roll = 0;
    this.boost = this.p.boostMax;
    this.driftTime = 0;
    this.brakeHeat = 0;
  }

  /** Normalised torque curve — peaky top end like a big NA V12. */
  torqueAt(rpm) {
    const p = this.p;
    const t = clamp(rpm / p.redline, 0, 1.15);
    // Rises to a broad plateau then falls off past the power peak.
    const curve = 0.42 + 0.86 * Math.sin(Math.PI * Math.pow(clamp(t, 0, 1), 0.82)) - 0.28 * Math.pow(clamp(t - 0.82, 0, 1) / 0.18, 2);
    return clamp(curve, 0.05, 1.0) * p.peakTorque;
  }

  gearRatio(g) {
    const p = this.p;
    return p.gearRatios[clamp(g - 1, 0, p.gearRatios.length - 1)] * p.finalDrive;
  }

  /** Pacejka-style lateral force coefficient for a slip angle in radians. */
  _tire(slip, gripScale) {
    const p = this.p;
    const B = p.pacejkaB, C = p.pacejkaC, E = p.pacejkaE;
    const Bs = B * slip;
    const f = Math.sin(C * Math.atan(Bs - E * (Bs - Math.atan(Bs))));
    return f * p.tireGrip * gripScale;
  }

  /**
   * @param {number} dt
   * @param {object} input  {throttle, brake, steer, handbrake, boost, shiftUp, shiftDown}
   * @param {object} ground {y, normal, grip, onTrack}
   */
  update(dt, input, ground) {
    const p = this.p;
    dt = Math.min(dt, 1 / 30);

    // ── Steering ──────────────────────────────────────────────────────────
    const spd = Math.abs(this.vz);
    // Less lock at speed, so the car is stable on a straight.
    const speedFactor = 1 / (1 + Math.pow(spd / 34, 1.55) * p.steerSpeedFalloff);
    this.steerTarget = input.steer * p.maxSteer * clamp(speedFactor, 0.22, 1);

    // Counter-steer assist: when the tail steps out, help the driver catch it.
    if (this.assists && spd > 6) {
      const drift = Math.atan2(this.vx, Math.max(1, Math.abs(this.vz)));
      this.steerTarget -= clamp(drift * p.countersteerAssist, -0.25, 0.25) * (1 - Math.abs(input.steer) * 0.6);
    }
    const rate = (Math.abs(this.steerTarget) > Math.abs(this.steer) ? p.steerRate : p.steerReturn);
    this.steer = damp(this.steer, this.steerTarget, rate, dt);

    // ── Ground ────────────────────────────────────────────────────────────
    this.groundY = ground.y;
    this.surfaceGrip = ground.grip ?? 1;
    const heightAbove = this.pos.y - ground.y;
    if (heightAbove > 0.12) {
      this.airborne = true;
      this.vy -= 19.6 * dt;
      this.airTime += dt;
    } else {
      if (this.airborne && this.vy < -3) {
        // Landing: scrub some speed and kick the suspension.
        this.vz *= 0.985;
        this._landImpulse = clamp(-this.vy / 12, 0, 1);
      }
      this.airborne = false;
      this.airTime = 0;
      this.vy = Math.max(this.vy, 0);
      this.pos.y = damp(this.pos.y, ground.y, 22, dt);
    }

    // ── Drivetrain ────────────────────────────────────────────────────────
    const ratio = this.gearRatio(this.gear);
    const wheelOmega = this.vz / p.wheelRadius;
    let targetRpm = Math.abs(wheelOmega) * ratio * (60 / TAU);
    targetRpm = clamp(targetRpm, p.idleRpm, p.redline * 1.02);

    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (this.shiftTimer > 0) this.clutch = damp(this.clutch, 0, 22, dt);
    else this.clutch = damp(this.clutch, 1, 14, dt);

    // Auto gearbox
    if (this.shiftTimer <= 0) {
      if (input.shiftUp) this._shift(1);
      else if (input.shiftDown) this._shift(-1);
      else if (!input.manual) {
        if (targetRpm > p.redline * 0.955 && this.gear < p.gearRatios.length) this._shift(1);
        else if (targetRpm < p.redline * 0.42 && this.gear > 1 && this.vz > 0.5) {
          const downRpm = Math.abs(wheelOmega) * this.gearRatio(this.gear - 1) * (60 / TAU);
          if (downRpm < p.redline * 0.92) this._shift(-1);
        }
      }
    }
    // Blip the revs while the clutch is out so the audio has life.
    const revTarget = this.shiftTimer > 0
      ? lerp(this.rpm, p.redline * (input.throttle > 0.2 ? 0.72 : 0.42), 0.4)
      : targetRpm;
    this.rpm = damp(this.rpm, Math.max(revTarget, p.idleRpm + input.throttle * 700), 9, dt);

    this.throttle = damp(this.throttle, input.throttle, 16, dt);
    this.brake = damp(this.brake, input.brake, 20, dt);
    this.handbrake = damp(this.handbrake, input.handbrake, 18, dt);

    // ── Boost ─────────────────────────────────────────────────────────────
    this.boostActive = !!input.boost && this.boost > 0.05 && this.throttle > 0.15;
    if (this.boostActive) this.boost = Math.max(0, this.boost - dt);
    else this.boost = Math.min(p.boostMax, this.boost + dt * p.boostRegen);

    // ── Longitudinal forces ───────────────────────────────────────────────
    let driveForce = 0;
    if (!this.airborne && this.shiftTimer <= 0) {
      const engineTorque = this.torqueAt(this.rpm) * this.throttle * this.clutch;
      driveForce = (engineTorque * ratio * p.drivetrainEff) / p.wheelRadius;
    }
    if (this.boostActive) driveForce += p.boostForce;

    // Engine braking
    if (this.throttle < 0.05 && !this.airborne) {
      driveForce -= clamp(this.rpm / p.redline, 0, 1) * 1400 * Math.sign(this.vz || 1);
    }

    const dragForce = 0.5 * 1.225 * p.dragArea * this.vz * Math.abs(this.vz);
    const rollForce = p.rollResist * this.vz;

    // Reverse when stationary and braking
    let brakeForce = 0;
    if (this.brake > 0.02) {
      if (this.vz > 0.4) brakeForce = -this.brake * p.brakeTorque / p.wheelRadius * 0.001 * p.mass * 0.02;
      else if (this.vz > -12) driveForce -= this.brake * 7000;   // reverse
    }
    // Simplified but well-behaved brake force.
    if (this.brake > 0.02 && this.vz > 0.4) {
      brakeForce = -this.brake * 26000 * this.surfaceGrip;
      this.brakeHeat = Math.min(1, this.brakeHeat + this.brake * dt * 1.2 * clamp(this.speed / 40, 0, 1));
    }
    this.brakeHeat = Math.max(0, this.brakeHeat - dt * 0.35);

    // ── Load transfer ─────────────────────────────────────────────────────
    const staticFront = 1 - p.cgBias;
    const accelEst = (driveForce + brakeForce - dragForce - rollForce) / p.mass;
    const transfer = clamp((accelEst * p.cgHeight) / (9.81 * p.wheelbase), -0.32, 0.32);
    this.loadFront = clamp(staticFront - transfer, 0.14, 0.86);
    this.loadRear = 1 - this.loadFront;

    // Aero load grows with the square of speed.
    const q = this.speed * this.speed;
    const dfF = p.downforceF * q * 0.0016;
    const dfR = p.downforceR * q * 0.0016;
    const totalN = p.mass * 9.81 + dfF + dfR;
    const nF = p.mass * 9.81 * this.loadFront + dfF;
    const nR = p.mass * 9.81 * this.loadRear + dfR;

    // ── Slip angles ───────────────────────────────────────────────────────
    const a = p.wheelbase * p.cgBias;        // front axle → CG
    const b = p.wheelbase * (1 - p.cgBias);  // CG → rear axle
    const vzSafe = Math.max(Math.abs(this.vz), 1.2) * Math.sign(this.vz || 1);

    let slipF = Math.atan((this.vx + this.yawRate * a) / Math.abs(vzSafe)) - this.steer * Math.sign(vzSafe);
    let slipR = Math.atan((this.vx - this.yawRate * b) / Math.abs(vzSafe));
    this.slipFront = slipF;
    this.slipRear = slipR;

    const gripEnv = this.surfaceGrip * (this.airborne ? 0.02 : 1);

    // Friction circle: longitudinal demand eats into lateral capacity.
    const longDemandR = clamp(Math.abs(driveForce) / (nR * p.tireGrip + 1), 0, 1.2);
    const longDemandF = clamp(Math.abs(brakeForce) * p.brakeBias / (nF * p.tireGrip + 1), 0, 1.2);
    const circleR = Math.sqrt(Math.max(0.06, 1 - longDemandR * longDemandR * 0.72));
    const circleF = Math.sqrt(Math.max(0.20, 1 - longDemandF * longDemandF * 0.55));

    const hbScale = lerp(1, p.handbrakeGripScale, this.handbrake);

    let muF = this._tire(slipF, p.frontGripBias * circleF * gripEnv);
    let muR = this._tire(slipR, p.rearGripBias * circleR * gripEnv * hbScale);

    // ── Assists ───────────────────────────────────────────────────────────
    this.absActive = false; this.tcsActive = false; this.stmActive = false;
    if (this.assists) {
      if (this.brake > 0.5 && Math.abs(slipF) > 0.16) {
        brakeForce *= 1 - p.absStrength * 0.35;
        this.absActive = true;
      }
      if (longDemandR > 0.82 && this.throttle > 0.5) {
        driveForce *= 1 - p.tcsStrength * 0.42;
        this.tcsActive = true;
      }
      const overRotate = Math.abs(slipR) - Math.abs(slipF);
      if (overRotate > 0.10 && this.speed > 8) {
        muR += Math.sign(-slipR) * Math.min(overRotate * p.stabilityStrength, 0.5);
        this.stmActive = true;
      }
    }

    const Fyf = -muF * nF;
    const Fyr = -muR * nR;

    // ── Integrate ─────────────────────────────────────────────────────────
    const cosS = Math.cos(this.steer);
    const sinS = Math.sin(this.steer);
    const Flong = driveForce + brakeForce - dragForce - rollForce - Fyf * sinS;
    const Flat = Fyf * cosS + Fyr;

    const ax = Flat / p.mass - this.yawRate * this.vz;
    const az = Flong / p.mass + this.yawRate * this.vx;

    this.vx += ax * dt;
    this.vz += az * dt;

    const yawTorque = a * Fyf * cosS - b * Fyr;
    let yawAccel = yawTorque / p.yawInertia;
    // Damp yaw at low speed so the car doesn't spin on the spot.
    yawAccel -= this.yawRate * clamp(3.0 - this.speed * 0.06, 0.4, 3.0);
    this.yawRate += yawAccel * dt;
    this.yawRate = clamp(this.yawRate, -3.2, 3.2);

    if (this.airborne) {
      this.yawRate *= Math.pow(0.55, dt * 10);
      this.vx *= Math.pow(0.9, dt * 10);
    }
    if (this.speed < 0.35 && this.throttle < 0.05) {
      this.vx *= 0.7; this.vz *= 0.7; this.yawRate *= 0.6;
    }

    this.yaw += this.yawRate * dt;

    // Body-frame → world
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    this.pos.x += (this.vz * s + this.vx * c) * dt;
    this.pos.z += (this.vz * c - this.vx * s) * dt;
    this.pos.y += this.vy * dt;
    this.odometer += this.speed * dt;

    // ── Derived state for visuals / audio / HUD ───────────────────────────
    this.lateralG = ax / 9.81;
    this.longG = az / 9.81;
    this.driftAngle = Math.atan2(this.vx, Math.max(1, Math.abs(this.vz)));
    const drifting = Math.abs(this.driftAngle) > 0.16 && this.speed > 9;
    this.driftTime = drifting ? this.driftTime + dt : 0;
    this.wheelSpin = clamp(longDemandR * 1.3 - 0.35, 0, 1) * this.throttle
      + clamp(Math.abs(slipR) * 1.6 - 0.2, 0, 1) * 0.6
      + this.handbrake * 0.6;
    this.wheelSpin = clamp(this.wheelSpin, 0, 1);

    // Chassis attitude: roll into the corner, dive under braking, squat on power.
    const targetRoll = clamp(-this.lateralG * 0.055, -0.09, 0.09);
    const targetPitch = clamp(this.longG * 0.030, -0.055, 0.055)
      + (this._landImpulse ? -this._landImpulse * 0.05 : 0);
    this.roll = damp(this.roll, targetRoll, 8, dt);
    this.pitch = damp(this.pitch, targetPitch, 9, dt);
    this._landImpulse = this._landImpulse ? this._landImpulse * Math.pow(0.02, dt) : 0;

    // Wheel spin angles for the visual model.
    const rollSpeed = this.vz / p.wheelRadius;
    const spinSpeed = rollSpeed * (1 + this.wheelSpin * 1.8);
    for (let i = 0; i < 4; i++) {
      const isRear = i >= 2;
      this._wheelAngles[i] += (isRear ? spinSpeed : rollSpeed) * dt;
    }
    return this;
  }

  _shift(dir) {
    const p = this.p;
    const ng = clamp(this.gear + dir, 1, p.gearRatios.length);
    if (ng === this.gear) return;
    this.gear = ng;
    this.shiftTimer = p.shiftTime;
    this.lastShift = dir;
  }

  /** Push the car back onto the road when it hits the barriers. */
  applyBarrier(lateral, halfWidth, normalRight, restitution = 0.35) {
    const over = Math.abs(lateral) - halfWidth;
    if (over <= 0) return 0;
    const dir = -Math.sign(lateral);
    // Reflect the lateral component of velocity and scrub speed.
    const push = Math.min(over, 2.2) * dir;
    this.pos.x += normalRight.x * push * 0.6;
    this.pos.z += normalRight.z * push * 0.6;
    const inward = this.vx * -dir;
    if (inward > 0) this.vx = -this.vx * restitution;
    const scrub = clamp(over * 0.35, 0, 0.5);
    this.vz *= 1 - scrub * 0.55;
    this.yawRate *= 0.6;
    return clamp(over * 0.5 + Math.abs(inward) * 0.06, 0, 1);
  }

  get wheelAngles() { return this._wheelAngles; }
}
