import * as THREE from 'three';
import { clamp, lerp, damp, angleDelta, TAU, makeRNG } from '../core/math.js';

/**
 * AI racer. Follows the pre-computed racing line with a lookahead steering
 * controller, brakes off the speed profile, and swerves around cars ahead.
 * Skill scales aggression, line accuracy, reaction time and mistake rate.
 */
export class AIDriver {
  constructor(car, world, opts = {}) {
    this.car = car;
    this.world = world;
    this.track = world.track;
    this.line = world.racingLine;
    this.speedProfile = world.speedProfile;

    this.skill = clamp(opts.skill ?? 0.8, 0.35, 1.0);
    this.rng = makeRNG(opts.seed ?? 1);
    this.aggression = lerp(0.45, 1.0, this.skill) * (0.85 + this.rng() * 0.3);

    // Personality: where this driver likes to sit on the road.
    this.lineBias = (this.rng() - 0.5) * 3.4 * (1.25 - this.skill);
    this.reaction = lerp(0.34, 0.08, this.skill);
    this.mistakeChance = lerp(0.030, 0.002, this.skill);
    this.mistakeTimer = 0;
    this.mistakeSteer = 0;

    this._steerSmooth = 0;
    this._avoid = 0;
    this._targetOffset = 0;
    this._input = { throttle: 0, brake: 0, steer: 0, handbrake: 0, boost: false };
    this._v = new THREE.Vector3();
    this._reactBuffer = [];
    this.boostCooldown = 2 + this.rng() * 6;
    this.stuckTimer = 0;
  }

  /** Lateral offset of the racing line at arc length s. */
  lineAt(s) {
    const n = this.track.count;
    const t = ((s / this.track.spacing) % n + n) % n;
    const i0 = Math.floor(t), i1 = (i0 + 1) % n;
    return lerp(this.line[i0], this.line[i1], t - i0);
  }

  speedAt(s) {
    const n = this.track.count;
    const t = ((s / this.track.spacing) % n + n) % n;
    const i0 = Math.floor(t), i1 = (i0 + 1) % n;
    return lerp(this.speedProfile[i0], this.speedProfile[i1], t - i0);
  }

  update(dt, rivals) {
    const car = this.car;
    const ph = car.physics;
    const track = this.track;
    const spd = ph.speed;

    const q = track.nearest(ph.pos, car._lastS ?? null);
    const s = q.s;

    // ── Look-ahead point on the racing line ──────────────────────────────
    const look = clamp(6 + spd * 0.62, 8, 46);
    const aheadS = s + look;
    const baseOffset = this.lineAt(aheadS) + this.lineBias;

    // ── Avoidance: check rivals just ahead of us ─────────────────────────
    let avoidTarget = 0;
    let blocked = 0;
    for (const other of rivals) {
      if (other === car) continue;
      const d = other.trackS - s;
      const wrapped = d < -track.length / 2 ? d + track.length : d > track.length / 2 ? d - track.length : d;
      if (wrapped > 1 && wrapped < 34) {
        const lateralGap = other.lateral - q.lateral;
        if (Math.abs(lateralGap) < 3.4) {
          const urgency = 1 - wrapped / 34;
          const dir = lateralGap > 0 ? -1 : 1;
          // Prefer to pass toward the outside if the inside is tight.
          avoidTarget += dir * 4.0 * urgency * this.aggression;
          blocked = Math.max(blocked, urgency * (other.physics.speed < spd - 2 ? 1 : 0.4));
        }
      }
    }
    this._avoid = damp(this._avoid, clamp(avoidTarget, -5, 5), 3.2, dt);

    const maxOff = q.sample.width * 0.5 - 1.6;
    this._targetOffset = clamp(baseOffset + this._avoid, -maxOff, maxOff);

    // ── Steering: aim at a point on the line ahead ───────────────────────
    const target = track.at(aheadS);
    const aim = this._v.copy(target.pos).addScaledVector(target.right, this._targetOffset);
    const toAim = aim.sub(ph.pos);
    const desiredHeading = Math.atan2(toAim.x, toAim.z);
    let err = angleDelta(ph.yaw, desiredHeading);

    // Mistakes: brief steering wobbles / late braking.
    this.mistakeTimer -= dt;
    if (this.mistakeTimer <= 0 && this.rng() < this.mistakeChance) {
      this.mistakeTimer = 0.4 + this.rng() * 0.8;
      this.mistakeSteer = (this.rng() - 0.5) * 0.5;
    }
    if (this.mistakeTimer > 0) err += this.mistakeSteer * 0.4;

    let steer = clamp(err * 2.4, -1, 1);
    // Damp with yaw rate so it doesn't oscillate.
    steer -= ph.yawRate * 0.30;
    // Catch slides.
    steer -= clamp(ph.driftAngle * 1.4, -0.8, 0.8);
    this._steerSmooth = damp(this._steerSmooth, clamp(steer, -1, 1), lerp(9, 16, this.skill), dt);

    // ── Speed control ────────────────────────────────────────────────────
    // Look further ahead for braking than for steering.
    let limit = Infinity;
    const brakeLook = clamp(spd * 1.5, 18, 110);
    for (let d = 4; d < brakeLook; d += 6) {
      const v = this.speedAt(s + d) * lerp(0.86, 1.03, this.skill);
      // How fast can we be here and still make that corner?
      const allowed = Math.sqrt(Math.max(0, v * v + 2 * 12.5 * d));
      limit = Math.min(limit, allowed);
    }
    limit = Math.min(limit, this.speedAt(s + 4) * lerp(0.88, 1.04, this.skill));
    if (blocked > 0.5) limit = Math.min(limit, spd * 0.94);

    const dv = limit - spd;
    let throttle = clamp(dv * 0.45, 0, 1);
    let brake = clamp(-dv * 0.24, 0, 1);
    if (this.mistakeTimer > 0) brake *= 0.7;

    // Slow way down when badly off-line.
    if (Math.abs(q.lateral) > q.sample.width * 0.5 + 1.2) {
      throttle *= 0.55;
    }

    // ── Boost usage: on straights, when clear ────────────────────────────
    this.boostCooldown -= dt;
    const straight = Math.abs(this.speedAt(s + 30)) > 60;
    const useBoost = this.boostCooldown <= 0 && straight && throttle > 0.9 && ph.boost > 1.2;
    if (useBoost && this.rng() < dt * 2.5) this.boostCooldown = 6 + this.rng() * 8;

    // ── Unstick ──────────────────────────────────────────────────────────
    if (spd < 2.5) this.stuckTimer += dt; else this.stuckTimer = 0;
    if (this.stuckTimer > 3.5) {
      throttle = 1; brake = 0;
      this._steerSmooth = clamp(err * 3, -1, 1);
      if (this.stuckTimer > 6) {
        const a = this.track.at(s + 6);
        ph.reset(a.pos.clone().addScaledVector(a.right, this.lineAt(s + 6)), a.heading);
        this.stuckTimer = 0;
      }
    }

    this._input.throttle = throttle;
    this._input.brake = brake;
    this._input.steer = this._steerSmooth;
    this._input.handbrake = 0;
    this._input.boost = useBoost;
    car.update(dt, this._input);
  }
}
