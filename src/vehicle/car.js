import * as THREE from 'three';
import { CarModel, CAR_PRESETS } from './carmodel.js';
import { VehiclePhysics } from './physics.js';
import { clamp, lerp, damp, TAU, saturate } from '../core/math.js';
import { LAYER } from '../render/postfx.js';
import { makeGlowSprite } from '../render/textures.js';

/**
 * A drivable car: model + physics + everything that has to be kept in sync
 * between them (wheel poses, lights, ground contact, barrier collisions).
 */
export class Car {
  constructor(opts = {}) {
    const {
      preset = CAR_PRESETS[0], isPlayer = false, track = null,
      setup = {}, name = 'DRIVER', night = false,
    } = opts;

    this.name = name;
    this.isPlayer = isPlayer;
    this.track = track;
    this.model = new CarModel(preset, isPlayer);
    this.physics = new VehiclePhysics(setup);
    this.object = this.model.group;

    this.trackS = 0;
    this.lateral = 0;
    this.lap = 0;
    this.lapStartTime = 0;
    this.lapTimes = [];
    this.bestLap = Infinity;
    this.totalProgress = 0;
    this.position = 1;
    this.finished = false;
    this.finishTime = 0;

    this.scrape = 0;
    this.exhaustPop = 0;
    this.collisionImpulse = 0;
    this._prevGear = 1;
    this._suspension = [0, 0, 0, 0];
    this._headlightOn = night ? 1 : 0;
    this.night = night;

    // Headlight beams — cheap additive cones that read well in rain and fog.
    if (isPlayer || night) this._buildBeams();
  }

  _buildBeams() {
    const tex = makeGlowSprite(0.4);
    this._beamTex = tex;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, color: 0xfff0d4, transparent: true, opacity: 0.0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.beamMaterial = mat;
    this.beams = new THREE.Group();
    this.beams.layers.set(LAYER.FX);
    for (const s of [-1, 1]) {
      const g = new THREE.ConeGeometry(1.5, 17, 12, 1, true);
      g.translate(0, -8.5, 0);
      g.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(g, mat);
      m.position.set(s * 0.66, 0.60, -2.1);
      m.rotation.x = 0.045;
      m.layers.set(LAYER.FX);
      m.renderOrder = 4;
      this.beams.add(m);
    }
    this.model.chassis.add(this.beams);

    // Pools of light on the tarmac in front of the car.
    const poolMat = new THREE.MeshBasicMaterial({
      map: tex, color: 0xffe8c0, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this.poolMaterial = poolMat;
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(9, 24), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.04, -11);
    pool.layers.set(LAYER.FX);
    pool.renderOrder = 3;
    this.model.chassis.add(pool);
    this.lightPool = pool;

    // At night the additive cones alone aren't enough — without a real light
    // the road, the traffic and the buildings ahead stay black. One shadowless
    // spot per car is cheap and transforms the night circuits.
    if (this.night) {
      const spot = new THREE.SpotLight(0xfff0d2, 0, 78, 0.62, 0.55, 1.1);
      spot.castShadow = false;
      spot.position.set(0, 0.62, -1.9);
      spot.target.position.set(0, -1.6, -34);
      this.model.chassis.add(spot);
      this.model.chassis.add(spot.target);
      this.headlightSpot = spot;
    }
  }

  reset(pos, yaw) {
    this.physics.reset(pos, yaw);
    this.syncVisual(0);
    this.scrape = 0;
    this.collisionImpulse = 0;
  }

  /** Ask the track for the surface under the car. */
  sampleGround() {
    if (!this.track) return { y: 0, grip: 1, onTrack: true, lateral: 0, sample: null };
    const q = this.track.nearest(this.physics.pos, this._lastS ?? null);
    this._lastS = q.s;
    this.trackS = q.s;
    this.lateral = q.lateral;
    const s = q.sample;
    const half = s.width * 0.5;
    const over = Math.abs(q.lateral) - half;
    let grip = 1;
    if (over > 0) {
      // Kerb, then pavement, then grass/dirt — grip falls off in bands.
      grip = over < 0.4 ? 0.94 : over < 1.2 ? 0.72 : 0.52;
    }
    const y = s.pos.y - (this.track.spec.road?.crown ?? 0.09) + Math.sin(s.bank) * -q.lateral;
    return { y, grip, onTrack: over <= 0, lateral: q.lateral, sample: s, half, over };
  }

  update(dt, input) {
    const ph = this.physics;
    const ground = this.sampleGround();

    ph.update(dt, input, ground);

    // ── Barriers ─────────────────────────────────────────────────────────
    const g2 = this.sampleGround();
    this.collisionImpulse *= Math.pow(0.02, dt);
    if (g2.sample) {
      const limit = g2.half + (this.track.spec.road?.pavementWidth ?? 4.5) + 1.4;
      if (Math.abs(g2.lateral) > limit) {
        const imp = ph.applyBarrier(g2.lateral, limit, g2.sample.right, 0.32);
        this.collisionImpulse = Math.max(this.collisionImpulse, imp);
      }
    }

    // Kerb rattle → sparks + a small vertical kick.
    this.scrape = 0;
    if (g2.over > 0.02 && g2.over < 0.55 && ph.speed > 10) {
      this.scrape = clamp((0.55 - Math.abs(g2.over - 0.28)) * 2.2, 0, 1) * clamp(ph.speed / 30, 0, 1);
    }

    // ── Gear-change pop ──────────────────────────────────────────────────
    this.exhaustPop = Math.max(0, this.exhaustPop - dt * 8);
    if (ph.gear !== this._prevGear) {
      if (ph.gear > this._prevGear && ph.throttle > 0.5) this.exhaustPop = 1;
      this._prevGear = ph.gear;
    }
    // Overrun crackle: occasional, not a constant flame thrower.
    this._popCool = Math.max(0, (this._popCool ?? 0) - dt);
    if (ph.throttle < 0.05 && ph.brake < 0.2 && ph.rpm > ph.p.redline * 0.70
        && this._popCool <= 0 && Math.random() < dt * 1.6) {
      this.exhaustPop = 0.55;
      this._popCool = 0.35 + Math.random() * 0.9;
    }

    this.syncVisual(dt);
    return ground;
  }

  /** Push the physics state into the visual model. */
  syncVisual(dt) {
    const ph = this.physics;
    const o = this.object;
    o.position.copy(ph.pos);
    o.rotation.set(0, 0, 0);
    o.rotateY(ph.yaw);
    o.rotateX(ph.pitch);
    o.rotateZ(ph.roll);

    // Wheels: steer, spin, and a bit of suspension travel.
    const angles = ph.wheelAngles;
    for (let i = 0; i < this.model.wheels.length; i++) {
      const w = this.model.wheels[i];
      if (w.front) w.steer.rotation.y = ph.steer * 0.92;
      w.spin.rotation.x = -angles[i];

      const side = w.side;
      const isFront = w.front;
      const rollComp = -ph.roll * side * 1.6;
      const pitchComp = ph.pitch * (isFront ? 1.4 : -1.4);
      const target = clamp(rollComp + pitchComp, -0.09, 0.09);
      this._suspension[i] = dt > 0 ? damp(this._suspension[i], target, 14, dt) : target;
      w.steer.position.y = w.restY + this._suspension[i];
    }

    // Lights
    const braking = ph.brake > 0.05 ? 1 : (ph.throttle < 0.02 && ph.speed > 2 ? 0.25 : 0);
    const reverse = ph.vz < -0.6 ? 1 : 0;
    this.model.setLights({
      headlights: this._headlightOn,
      brake: braking,
      reverse,
      brakeHeat: ph.brakeHeat,
    });
    if (this.beamMaterial) {
      this.beamMaterial.opacity = this._headlightOn * (this.night ? 0.16 : 0.09);
      this.poolMaterial.opacity = this._headlightOn * (this.night ? 0.42 : 0.20);
    }
    if (this.headlightSpot) {
      this.headlightSpot.intensity = this._headlightOn * (this.isPlayer ? 190 : 120);
    }

    // Ground the fake contact shadow even when the body pitches.
    if (this.model.shadowBlob) {
      this.model.shadowBlob.position.y = 0.02;
      this.model.shadowBlob.rotation.set(-Math.PI / 2, 0, 0);
    }
  }

  setHeadlights(on) { this._headlightOn = on ? 1 : 0; }

  /** World position of wheel `i` (used by the FX system). */
  wheelWorld(i, out) {
    const w = this.model.wheels[i];
    if (!w) return out.copy(this.physics.pos);
    w.steer.getWorldPosition(out);
    return out;
  }

  exhaustWorld(i, out) {
    const p = this.model.exhaustPositions[i] || this.model.exhaustPositions[0];
    out.copy(p).applyMatrix4(this.model.chassis.matrixWorld);
    return out;
  }

  underbodyPoint(out) {
    out.set((Math.random() - 0.5) * 1.4, 0.06, 0.4 + Math.random() * 1.6)
      .applyMatrix4(this.model.chassis.matrixWorld);
    out.y = this.physics.groundY + 0.04;
    return out;
  }

  dispose() {
    this.model.dispose();
    this._beamTex?.dispose();
    this.beamMaterial?.dispose();
    this.poolMaterial?.dispose();
  }
}

export { CAR_PRESETS };
