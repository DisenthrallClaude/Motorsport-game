import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, lerp, damp, makeRNG, TAU, angleDelta } from '../core/math.js';
import { LAYER } from '../render/postfx.js';

// ────────────────────────────────────────────────────────────────────────────
//  Ambient traffic.
//  Every vehicle type is drawn as three InstancedMeshes (body / glass / lamps)
//  so a whole city's worth of traffic costs about fifteen draw calls.
// ────────────────────────────────────────────────────────────────────────────

function box(w, h, d, x, y, z, tint = 1, rot = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rot) g.rotateX(rot);
  g.translate(x, y, z);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const t = Array.isArray(tint) ? tint : [tint, tint, tint];
  for (let i = 0; i < n; i++) { col[i * 3] = t[0]; col[i * 3 + 1] = t[1]; col[i * 3 + 2] = t[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function cyl(r, h, seg, x, y, z, tint = 1, axis = 'x') {
  const g = new THREE.CylinderGeometry(r, r, h, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const t = Array.isArray(tint) ? tint : [tint, tint, tint];
  for (let i = 0; i < n; i++) { col[i * 3] = t[0]; col[i * 3 + 1] = t[1]; col[i * 3 + 2] = t[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

const DARK = 0.10, TRIM = 0.22, CHROME = 0.75;

/** Each builder returns { body, glass, lamps, length, width, height, speed }. */
const BUILDERS = {
  sedan() {
    const body = [
      box(1.82, 0.62, 4.42, 0, 0.72, 0),          // main volume
      box(1.70, 0.46, 2.20, 0, 1.18, -0.12),      // greenhouse shoulder
      box(1.86, 0.20, 4.20, 0, 0.44, 0, TRIM),    // sill
      box(1.88, 0.16, 0.30, 0, 0.60, -2.20, TRIM),// front bumper
      box(1.88, 0.16, 0.30, 0, 0.60, 2.20, TRIM), // rear bumper
    ];
    const glass = [
      box(1.60, 0.40, 0.10, 0, 1.20, -1.06, 1, -0.35),
      box(1.60, 0.40, 0.10, 0, 1.20, 1.02, 1, 0.30),
      box(0.06, 0.34, 1.90, -0.84, 1.20, -0.06),
      box(0.06, 0.34, 1.90, 0.84, 1.20, -0.06),
    ];
    const lamps = [
      box(0.42, 0.13, 0.06, -0.62, 0.78, -2.22),
      box(0.42, 0.13, 0.06, 0.62, 0.78, -2.22),
    ];
    const rear = [
      box(0.40, 0.12, 0.06, -0.62, 0.80, 2.22),
      box(0.40, 0.12, 0.06, 0.62, 0.80, 2.22),
    ];
    const wheels = [
      cyl(0.34, 0.24, 12, -0.86, 0.34, -1.42, DARK),
      cyl(0.34, 0.24, 12, 0.86, 0.34, -1.42, DARK),
      cyl(0.34, 0.24, 12, -0.86, 0.34, 1.46, DARK),
      cyl(0.34, 0.24, 12, 0.86, 0.34, 1.46, DARK),
    ];
    return { body: [...body, ...wheels], glass, lamps, rear, length: 4.6, width: 1.9, speed: 12 };
  },

  taxi() {
    const body = [
      box(1.86, 0.90, 4.30, 0, 0.78, 0),
      box(1.76, 0.86, 2.50, 0, 1.60, 0.10),
      box(1.90, 0.18, 4.10, 0, 0.42, 0, TRIM),
      box(1.92, 0.18, 0.28, 0, 0.62, -2.14, TRIM),
      box(1.92, 0.18, 0.28, 0, 0.62, 2.14, TRIM),
      box(0.60, 0.16, 0.30, 0, 2.10, -0.55, [1.6, 1.5, 0.6]),  // roof sign
    ];
    const glass = [
      box(1.64, 0.66, 0.10, 0, 1.62, -1.12, 1, -0.22),
      box(1.64, 0.66, 0.10, 0, 1.62, 1.30, 1, 0.18),
      box(0.06, 0.60, 2.20, -0.86, 1.62, 0.10),
      box(0.06, 0.60, 2.20, 0.86, 1.62, 0.10),
    ];
    const lamps = [
      box(0.34, 0.24, 0.06, -0.66, 0.86, -2.16),
      box(0.34, 0.24, 0.06, 0.66, 0.86, -2.16),
    ];
    const rear = [
      box(0.24, 0.42, 0.06, -0.74, 0.92, 2.16),
      box(0.24, 0.42, 0.06, 0.74, 0.92, 2.16),
    ];
    const wheels = [
      cyl(0.36, 0.24, 12, -0.88, 0.36, -1.40, DARK),
      cyl(0.36, 0.24, 12, 0.88, 0.36, -1.40, DARK),
      cyl(0.36, 0.24, 12, -0.88, 0.36, 1.48, DARK),
      cyl(0.36, 0.24, 12, 0.88, 0.36, 1.48, DARK),
    ];
    return { body: [...body, ...wheels], glass, lamps, rear, length: 4.5, width: 1.95, speed: 11 };
  },

  bus() {
    // London-style double-decker.
    const body = [
      box(2.52, 2.05, 10.6, 0, 1.30, 0),
      box(2.48, 1.90, 9.4, 0, 3.28, 0.4),
      box(2.56, 0.34, 10.4, 0, 0.42, 0, TRIM),
      box(2.58, 0.30, 0.34, 0, 0.72, -5.30, TRIM),
      box(2.58, 0.30, 0.34, 0, 0.72, 5.30, TRIM),
      box(2.44, 0.16, 9.0, 0, 4.24, 0.4, TRIM),
    ];
    const glass = [];
    for (let i = 0; i < 7; i++) {
      const z = -4.2 + i * 1.42;
      glass.push(box(0.08, 0.92, 1.20, -1.25, 1.62, z));
      glass.push(box(0.08, 0.92, 1.20, 1.25, 1.62, z));
      glass.push(box(0.08, 0.92, 1.20, -1.23, 3.52, z));
      glass.push(box(0.08, 0.92, 1.20, 1.23, 3.52, z));
    }
    glass.push(box(2.30, 1.10, 0.10, 0, 1.72, -5.28));
    glass.push(box(2.26, 1.10, 0.10, 0, 3.62, -4.68));
    const lamps = [
      box(0.34, 0.22, 0.06, -0.94, 0.92, -5.32),
      box(0.34, 0.22, 0.06, 0.94, 0.92, -5.32),
    ];
    const rear = [
      box(0.26, 0.50, 0.06, -0.98, 1.10, 5.32),
      box(0.26, 0.50, 0.06, 0.98, 1.10, 5.32),
    ];
    const wheels = [
      cyl(0.52, 0.32, 12, -1.16, 0.52, -3.40, DARK),
      cyl(0.52, 0.32, 12, 1.16, 0.52, -3.40, DARK),
      cyl(0.52, 0.32, 12, -1.16, 0.52, 3.10, DARK),
      cyl(0.52, 0.32, 12, 1.16, 0.52, 3.10, DARK),
    ];
    return { body: [...body, ...wheels], glass, lamps, rear, length: 10.8, width: 2.6, speed: 9 };
  },

  van() {
    const body = [
      box(2.06, 1.90, 5.60, 0, 1.24, 0.3),
      box(2.00, 0.90, 1.70, 0, 1.00, -2.30),
      box(2.10, 0.24, 5.40, 0, 0.40, 0.3, TRIM),
      box(2.12, 0.22, 0.30, 0, 0.60, -3.02, TRIM),
    ];
    const glass = [
      box(1.80, 0.62, 0.10, 0, 1.32, -3.00, 1, -0.20),
      box(0.08, 0.55, 1.10, -0.98, 1.32, -2.40),
      box(0.08, 0.55, 1.10, 0.98, 1.32, -2.40),
    ];
    const lamps = [
      box(0.36, 0.20, 0.06, -0.70, 0.82, -3.06),
      box(0.36, 0.20, 0.06, 0.70, 0.82, -3.06),
    ];
    const rear = [
      box(0.22, 0.44, 0.06, -0.86, 1.00, 3.12),
      box(0.22, 0.44, 0.06, 0.86, 1.00, 3.12),
    ];
    const wheels = [
      cyl(0.40, 0.26, 12, -0.98, 0.40, -1.86, DARK),
      cyl(0.40, 0.26, 12, 0.98, 0.40, -1.86, DARK),
      cyl(0.40, 0.26, 12, -0.98, 0.40, 1.90, DARK),
      cyl(0.40, 0.26, 12, 0.98, 0.40, 1.90, DARK),
    ];
    return { body: [...body, ...wheels], glass, lamps, rear, length: 5.8, width: 2.1, speed: 10.5 };
  },

  kei() {
    const body = [
      box(1.48, 1.30, 3.30, 0, 0.92, 0),
      box(1.44, 0.30, 3.10, 0, 0.40, 0, TRIM),
      box(1.50, 0.14, 0.24, 0, 0.56, -1.66, TRIM),
    ];
    const glass = [
      box(1.28, 0.52, 0.10, 0, 1.32, -0.92, 1, -0.28),
      box(1.28, 0.52, 0.10, 0, 1.32, 1.20, 1, 0.24),
      box(0.06, 0.46, 1.70, -0.70, 1.32, 0.14),
      box(0.06, 0.46, 1.70, 0.70, 1.32, 0.14),
    ];
    const lamps = [
      box(0.30, 0.16, 0.06, -0.48, 0.94, -1.68),
      box(0.30, 0.16, 0.06, 0.48, 0.94, -1.68),
    ];
    const rear = [
      box(0.24, 0.28, 0.06, -0.56, 1.00, 1.68),
      box(0.24, 0.28, 0.06, 0.56, 1.00, 1.68),
    ];
    const wheels = [
      cyl(0.28, 0.20, 10, -0.70, 0.28, -1.06, DARK),
      cyl(0.28, 0.20, 10, 0.70, 0.28, -1.06, DARK),
      cyl(0.28, 0.20, 10, -0.70, 0.28, 1.12, DARK),
      cyl(0.28, 0.20, 10, 0.70, 0.28, 1.12, DARK),
    ];
    return { body: [...body, ...wheels], glass, lamps, rear, length: 3.5, width: 1.5, speed: 11 };
  },

  suv() {
    const body = [
      box(1.98, 1.10, 4.80, 0, 0.94, 0),
      box(1.86, 0.62, 2.90, 0, 1.72, 0.05),
      box(2.02, 0.26, 4.60, 0, 0.48, 0, TRIM),
      box(2.04, 0.20, 0.30, 0, 0.66, -2.40, TRIM),
      box(1.60, 0.10, 1.90, 0, 2.08, 0.05, TRIM),
    ];
    const glass = [
      box(1.68, 0.52, 0.10, 0, 1.74, -1.36, 1, -0.30),
      box(1.68, 0.52, 0.10, 0, 1.74, 1.44, 1, 0.22),
      box(0.06, 0.48, 2.50, -0.90, 1.74, 0.05),
      box(0.06, 0.48, 2.50, 0.90, 1.74, 0.05),
    ];
    const lamps = [
      box(0.40, 0.16, 0.06, -0.66, 1.06, -2.42),
      box(0.40, 0.16, 0.06, 0.66, 1.06, -2.42),
    ];
    const rear = [
      box(0.24, 0.40, 0.06, -0.80, 1.16, 2.42),
      box(0.24, 0.40, 0.06, 0.80, 1.16, 2.42),
    ];
    const wheels = [
      cyl(0.40, 0.28, 12, -0.94, 0.40, -1.52, DARK),
      cyl(0.40, 0.28, 12, 0.94, 0.40, -1.52, DARK),
      cyl(0.40, 0.28, 12, -0.94, 0.40, 1.58, DARK),
      cyl(0.40, 0.28, 12, 0.94, 0.40, 1.58, DARK),
    ];
    return { body: [...body, ...wheels], glass, lamps, rear, length: 4.9, width: 2.0, speed: 12 };
  },
};

const PALETTES = {
  bus: [0xb01a12, 0xb01a12, 0x1a4f8a],
  taxi: [0x14161a, 0x14161a, 0xe0a80c],
  sedan: [0x9aa0a8, 0x2a2e34, 0x6a7078, 0xb8bcc0, 0x1a2a4a, 0x5a2a2a, 0xd8d4cc, 0x30506a],
  van: [0xd8d6d0, 0xd8d6d0, 0x2a4a7a, 0x8a8a86],
  kei: [0xe0e0dc, 0x8ab8d8, 0xd8c860, 0x5a5a5e],
  suv: [0x2a2e34, 0x8a8e94, 0x1c3a5a, 0x6a4a2a],
};

export class TrafficSystem {
  constructor(scene, track, theme, opts = {}) {
    this.scene = scene;
    this.track = track;
    this.theme = theme;
    this.rng = makeRNG(opts.seed ?? 909);
    this.night = !!theme.night;

    const types = [...new Set(theme.traffic?.palette ?? ['sedan', 'van', 'taxi'])];
    this.types = types.filter((t) => BUILDERS[t]);
    if (!this.types.length) this.types = ['sedan'];

    const density = theme.traffic?.density ?? 0.6;
    // One vehicle roughly every 90 m of road at full density.
    this.total = Math.round(clamp((track.length / 90) * density, 6, 46));

    this.bodyMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.42, metalness: 0.45, envMapIntensity: 1.1, dithering: true,
    });
    this.glassMat = new THREE.MeshStandardMaterial({
      color: 0x0e141c, roughness: 0.08, metalness: 0.3, envMapIntensity: 2.0,
      transparent: true, opacity: 0.62, vertexColors: true,
    });
    this.lampMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a18, emissive: 0xfff0d0, emissiveIntensity: this.night ? 2.2 : 0.35,
      roughness: 0.3, vertexColors: true,
    });
    this.rearMat = new THREE.MeshStandardMaterial({
      color: 0x180608, emissive: 0xff2418, emissiveIntensity: this.night ? 1.9 : 0.75,
      roughness: 0.3, vertexColors: true,
    });

    this.groups = [];
    this.vehicles = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._c = new THREE.Color();

    this._build();
  }

  _build() {
    const perType = Math.ceil(this.total / this.types.length);
    const laneCount = Math.max(2, Math.floor(this.track.width / 3.6));

    for (const type of this.types) {
      const spec = BUILDERS[type]();
      const merge = (list) => list.length ? BufferGeometryUtils.mergeGeometries(list, false) : null;
      const bodyGeo = merge(spec.body);
      const glassGeo = merge(spec.glass);
      const lampGeo = merge(spec.lamps);
      const rearGeo = merge(spec.rear);
      spec.body.forEach((g) => g.dispose());
      spec.glass.forEach((g) => g.dispose());
      spec.lamps.forEach((g) => g.dispose());
      spec.rear.forEach((g) => g.dispose());

      const count = perType;
      const mk = (geo, mat, shadow) => {
        if (!geo) return null;
        const im = new THREE.InstancedMesh(geo, mat, count);
        im.castShadow = shadow;
        im.receiveShadow = shadow;
        im.frustumCulled = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(im);
        return im;
      };
      const bodyMesh = mk(bodyGeo, this.bodyMat, true);
      const glassMesh = mk(glassGeo, this.glassMat, false);
      const lampMesh = mk(lampGeo, this.lampMat, false);
      const rearMesh = mk(rearGeo, this.rearMat, false);
      if (glassMesh) glassMesh.renderOrder = 2;

      const pal = PALETTES[type] || PALETTES.sedan;
      const group = { type, spec, bodyMesh, glassMesh, lampMesh, rearMesh, count };
      this.groups.push(group);

      for (let i = 0; i < count; i++) {
        const color = pal[(this.rng() * pal.length) | 0];
        if (bodyMesh) {
          bodyMesh.setColorAt(i, this._c.setHex(color).convertSRGBToLinear());
        }
        // Same-direction lanes are on the left half; oncoming on the right.
        const dir = this.rng() < 0.55 ? 1 : -1;
        const laneIdx = 1 + ((this.rng() * (laneCount / 2 - 0.01)) | 0);
        const lane = dir > 0
          ? -this.track.width * 0.5 + laneIdx * 3.4
          : this.track.width * 0.5 - laneIdx * 3.4;
        this.vehicles.push({
          group, index: i, type,
          s: this.rng() * this.track.length,
          lane,
          laneTarget: lane,
          dir,
          speed: spec.speed * (0.8 + this.rng() * 0.5),
          baseSpeed: spec.speed * (0.8 + this.rng() * 0.5),
          bob: this.rng() * TAU,
          braking: 0,
        });
      }
      if (bodyMesh && bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
    }
  }

  update(dt, playerCar) {
    const track = this.track;
    const playerS = playerCar ? playerCar.trackS : 0;
    const playerLat = playerCar ? playerCar.lateral : 0;

    for (const v of this.vehicles) {
      // Slow down if the player is right on top of them in the same lane.
      let brake = 0;
      if (playerCar) {
        let d = (v.s - playerS + track.length) % track.length;
        if (d > track.length / 2) d -= track.length;
        if (v.dir > 0 && d > -6 && d < 26 && Math.abs(v.lane - playerLat) < 3.2) {
          brake = clamp(1 - Math.abs(d) / 26, 0, 1) * 0.8;
          // Nudge out of the way.
          v.laneTarget = v.lane + Math.sign(v.lane - playerLat || 1) * 1.4;
        } else {
          v.laneTarget = damp(v.laneTarget, v.lane, 1.0, dt);
        }
      }
      v.braking = damp(v.braking, brake, 4, dt);
      const spd = v.baseSpeed * (1 - v.braking * 0.85);
      v.s += spd * v.dir * dt;
      v.s = (v.s + track.length) % track.length;
      v.bob += dt * 6;

      const a = track.at(v.s);
      const lat = v.laneTarget;
      this._p.copy(a.pos).addScaledVector(a.right, lat);
      this._p.y = a.pos.y + Math.sin(v.bob) * 0.006;

      const heading = a.heading + (v.dir > 0 ? 0 : Math.PI);
      this._e.set(0, heading, Math.sin(v.bob * 0.7) * 0.004);
      this._q.setFromEuler(this._e);
      this._m.compose(this._p, this._q, this._s);

      const g = v.group;
      if (g.bodyMesh) g.bodyMesh.setMatrixAt(v.index, this._m);
      if (g.glassMesh) g.glassMesh.setMatrixAt(v.index, this._m);
      if (g.lampMesh) g.lampMesh.setMatrixAt(v.index, this._m);
      if (g.rearMesh) g.rearMesh.setMatrixAt(v.index, this._m);
    }

    for (const g of this.groups) {
      if (g.bodyMesh) g.bodyMesh.instanceMatrix.needsUpdate = true;
      if (g.glassMesh) g.glassMesh.instanceMatrix.needsUpdate = true;
      if (g.lampMesh) g.lampMesh.instanceMatrix.needsUpdate = true;
      if (g.rearMesh) g.rearMesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Nearby traffic for the player's collision test. */
  forEachNear(pos, radius, fn) {
    const r2 = radius * radius;
    for (const v of this.vehicles) {
      const a = this.track.at(v.s);
      const x = a.pos.x + a.right.x * v.laneTarget;
      const z = a.pos.z + a.right.z * v.laneTarget;
      const dx = x - pos.x, dz = z - pos.z;
      if (dx * dx + dz * dz < r2) fn(v, x, z, a);
    }
  }

  dispose() {
    for (const g of this.groups) {
      for (const m of [g.bodyMesh, g.glassMesh, g.lampMesh, g.rearMesh]) {
        if (!m) continue;
        this.scene.remove(m);
        m.geometry.dispose();
      }
    }
    this.bodyMat.dispose(); this.glassMat.dispose();
    this.lampMat.dispose(); this.rearMat.dispose();
  }
}
