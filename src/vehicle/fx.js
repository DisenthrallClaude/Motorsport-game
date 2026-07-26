import * as THREE from 'three';
import { makeSmokeSprite, makeGlowSprite, makeRainStreak } from '../render/textures.js';
import { LAYER } from '../render/postfx.js';
import { clamp, lerp, TAU, saturate } from '../core/math.js';

const PARTICLE_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
attribute float aRot;
varying float vAlpha;
varying vec3 vColor;
varying float vRot;
uniform float uPixelScale;
uniform float uMaxSize;
void main() {
  vColor = aColor;
  vRot = aRot;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 0.1);
  gl_PointSize = min(aSize * uPixelScale / dist, uMaxSize);
  // Fade sprites out as they approach the lens, otherwise a single close
  // particle covers the whole frame and hides the car.
  vAlpha = aAlpha * smoothstep(0.9, 4.2, dist);
}
`;

const PARTICLE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform float uIntensity;
varying float vAlpha;
varying vec3 vColor;
varying float vRot;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float c = cos(vRot), s = sin(vRot);
  uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) + 0.5;
  vec4 t = texture2D(uMap, uv);
  if (t.a * vAlpha < 0.004) discard;
  gl_FragColor = vec4(vColor * uIntensity, t.a * vAlpha);
}
`;

/**
 * CPU-simulated particle pool rendered as a single Points draw call.
 * Handles tyre smoke, road spray, sparks and exhaust flame.
 */
export class ParticlePool {
  constructor(max, texture, opts = {}) {
    this.max = max;
    this.count = 0;
    this.cursor = 0;

    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.growth = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.color = new Float32Array(max * 3);
    this.rot = new Float32Array(max);
    this.rotVel = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.gravity = new Float32Array(max);
    this.fadeIn = new Float32Array(max);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aRot', new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: {
        uMap: { value: texture },
        uPixelScale: { value: 420 },
        uMaxSize: { value: opts.maxSize ?? 190 },
        uIntensity: { value: opts.intensity ?? 1.0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = opts.renderOrder ?? 5;
    this.points.layers.set(LAYER.FX);
    this.geometry = g;
  }

  emit(p) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.count = Math.min(this.count + 1, this.max);

    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = p.vx || 0; this.vel[i * 3 + 1] = p.vy || 0; this.vel[i * 3 + 2] = p.vz || 0;
    this.life[i] = 0;
    this.maxLife[i] = p.life ?? 1;
    this.size[i] = p.size ?? 1;
    this.growth[i] = p.growth ?? 0;
    this.alpha[i] = 0;
    this.color[i * 3] = p.r ?? 1; this.color[i * 3 + 1] = p.g ?? 1; this.color[i * 3 + 2] = p.b ?? 1;
    this.rot[i] = p.rot ?? Math.random() * TAU;
    this.rotVel[i] = p.rotVel ?? (Math.random() - 0.5) * 1.2;
    this.drag[i] = p.drag ?? 1.4;
    this.gravity[i] = p.gravity ?? 0;
    this.fadeIn[i] = p.fadeIn ?? 0.12;
    this._peak = p.peakAlpha ?? this._peak;
    if (p.peakAlpha !== undefined) this.alpha[i] = 0;
    this._peakAlpha = this._peakAlpha || new Float32Array(this.max);
    this._peakAlpha[i] = p.peakAlpha ?? 0.6;
  }

  update(dt) {
    if (!this.count) { this.geometry.setDrawRange(0, 0); return; }
    const n = this.count;
    let live = 0;
    for (let i = 0; i < n; i++) {
      if (this.life[i] >= this.maxLife[i]) { this.alpha[i] = 0; continue; }
      this.life[i] += dt;
      const t = this.life[i] / this.maxLife[i];
      if (t >= 1) { this.alpha[i] = 0; continue; }

      const d = Math.pow(1 / (1 + this.drag[i] * dt), 1);
      this.vel[i * 3] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d + this.gravity[i] * dt;
      this.vel[i * 3 + 2] *= d;

      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;

      this.size[i] += this.growth[i] * dt;
      this.rot[i] += this.rotVel[i] * dt;

      const fi = saturate(t / this.fadeIn[i]);
      const fo = 1 - saturate((t - this.fadeIn[i]) / (1 - this.fadeIn[i]));
      this.alpha[i] = (this._peakAlpha ? this._peakAlpha[i] : 0.6) * fi * fo * fo;
      live++;
    }
    this.geometry.setDrawRange(0, n);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aRot.needsUpdate = true;
    this.liveCount = live;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * All the effects that hang off a car: tyre smoke, wet spray, brake sparks,
 * exhaust flame and the volumetric-ish headlight cones.
 */
export class CarFX {
  constructor(scene, theme) {
    this.scene = scene;
    this.theme = theme;
    const smokeTex = makeSmokeSprite(2);
    const glowTex = makeGlowSprite(0.15);

    this.smoke = new ParticlePool(340, smokeTex, { intensity: 0.9, renderOrder: 6, maxSize: 210 });
    this.spray = new ParticlePool(420, smokeTex, { intensity: 1.0, renderOrder: 7, maxSize: 150 });
    this.sparks = new ParticlePool(160, glowTex, { additive: true, intensity: 3.2, renderOrder: 8 });
    this.flame = new ParticlePool(60, glowTex, { additive: true, intensity: 2.2, renderOrder: 9, maxSize: 70 });

    scene.add(this.smoke.points, this.spray.points, this.sparks.points, this.flame.points);

    this._v = new THREE.Vector3();
    this._acc = 0;
    this._sprayAcc = 0;
  }

  /**
   * @param {number} dt
   * @param {object} car   { physics, model, wheelWorldPositions }
   * @param {number} rain  0..1 surface wetness
   */
  update(dt, car, rain) {
    const ph = car.physics;
    const spd = ph.speed;
    const wet = clamp(rain, 0, 1);

    // ── Tyre smoke from the driven wheels ────────────────────────────────
    const smokeRate = ph.wheelSpin * clamp(spd / 8, 0, 1) * 90;
    this._acc += smokeRate * dt;
    while (this._acc >= 1) {
      this._acc -= 1;
      for (const w of [2, 3]) {
        const p = car.wheelWorld(w, this._v);
        const jitter = () => (Math.random() - 0.5);
        const tint = wet > 0.4 ? 0.86 : 0.72;
        this.smoke.emit({
          x: p.x + jitter() * 0.3, y: p.y - 0.22 + Math.random() * 0.12, z: p.z + jitter() * 0.3,
          vx: -ph.forward.x * spd * 0.09 + jitter() * 2.2,
          vy: 0.6 + Math.random() * 1.4,
          vz: -ph.forward.z * spd * 0.09 + jitter() * 2.2,
          life: 1.1 + Math.random() * 1.0,
          size: 0.9 + Math.random() * 0.7,
          growth: 2.6,
          peakAlpha: 0.24 * (0.55 + ph.wheelSpin * 0.7),
          r: tint, g: tint, b: tint * 1.02,
          drag: 1.1, gravity: 0.5, fadeIn: 0.22,
        });
      }
    }

    // ── Wet-road spray: a rooster tail behind every wheel ────────────────
    if (wet > 0.18 && spd > 4) {
      const rate = Math.min(wet, 0.7) * clamp(spd / 12, 0, 2.0) * 62;
      this._sprayAcc += rate * dt;
      while (this._sprayAcc >= 1) {
        this._sprayAcc -= 1;
        const w = (Math.random() * 4) | 0;
        const p = car.wheelWorld(w, this._v);
        const back = ph.forward;
        const j = () => (Math.random() - 0.5);
        this.spray.emit({
          x: p.x - back.x * 0.7 + j() * 0.3,
          y: p.y - 0.30 + Math.random() * 0.08,
          z: p.z - back.z * 0.7 + j() * 0.3,
          vx: -back.x * spd * 0.26 + j() * 2.2,
          vy: 0.9 + Math.random() * 1.9,
          vz: -back.z * spd * 0.26 + j() * 2.2,
          life: 0.40 + Math.random() * 0.42,
          size: 0.26 + Math.random() * 0.30,
          growth: 2.3,
          peakAlpha: 0.085 * Math.min(wet, 0.8),
          r: 0.90, g: 0.94, b: 1.0,
          drag: 2.9, gravity: -3.4, fadeIn: 0.14,
        });
      }
    }

    // ── Sparks when the floor grounds out or on heavy kerb strikes ───────
    if (car.scrape > 0.01 && spd > 12) {
      const n = Math.floor(car.scrape * 30 * dt * 60);
      for (let i = 0; i < n; i++) {
        const p = car.underbodyPoint(this._v);
        const j = () => (Math.random() - 0.5);
        this.sparks.emit({
          x: p.x + j() * 0.5, y: p.y, z: p.z + j() * 0.5,
          vx: -ph.forward.x * spd * 0.45 + j() * 5,
          vy: 0.6 + Math.random() * 2.6,
          vz: -ph.forward.z * spd * 0.45 + j() * 5,
          life: 0.28 + Math.random() * 0.34,
          size: 0.08 + Math.random() * 0.08,
          growth: -0.06,
          peakAlpha: 0.95,
          r: 1.0, g: 0.62, b: 0.18,
          drag: 1.0, gravity: -11, fadeIn: 0.04,
        });
      }
    }

    // ── Exhaust flame on lift-off / upshift ─────────────────────────────
    if (car.exhaustPop > 0) {
      const n = Math.min(6, Math.ceil(car.exhaustPop * 6));
      for (let i = 0; i < n; i++) {
        const p = car.exhaustWorld(i % 2, this._v);
        const j = () => (Math.random() - 0.5);
        this.flame.emit({
          x: p.x + j() * 0.06, y: p.y + j() * 0.06, z: p.z + j() * 0.06,
          vx: ph.forward.x * -6 + j() * 1.4,
          vy: 0.4 + Math.random(),
          vz: ph.forward.z * -6 + j() * 1.4,
          life: 0.08 + Math.random() * 0.08,
          size: 0.13 + Math.random() * 0.12,
          growth: 0.9,
          peakAlpha: 0.75,
          r: 1.0, g: 0.48, b: 0.14,
          drag: 5.0, gravity: 1.2, fadeIn: 0.08,
        });
      }
    }

    this.smoke.update(dt);
    this.spray.update(dt);
    this.sparks.update(dt);
    this.flame.update(dt);
  }

  dispose() {
    for (const p of [this.smoke, this.spray, this.sparks, this.flame]) {
      this.scene.remove(p.points);
      p.dispose();
    }
  }
}

/**
 * Camera-locked rain box. Streaks are instanced quads that wrap around the
 * camera, so a few thousand cover the whole visible volume.
 */
export class RainSystem {
  constructor(scene, count = 2600, opts = {}) {
    this.count = count;
    this.box = opts.box ?? 34;
    this.speed = opts.speed ?? 26;
    this.wind = opts.wind ?? new THREE.Vector3(2.4, 0, 1.2);

    const tex = makeRainStreak();
    const geo = new THREE.PlaneGeometry(0.03, 0.75);
    this.material = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: opts.opacity ?? 0.42,
      depthWrite: false, blending: THREE.NormalBlending,
      color: opts.color ?? 0xcfe0ff, toneMapped: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, count);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.FX);
    this.mesh.renderOrder = 10;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.p = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.p[i * 3] = (Math.random() - 0.5) * this.box * 2;
      this.p[i * 3 + 1] = Math.random() * this.box * 1.3;
      this.p[i * 3 + 2] = (Math.random() - 0.5) * this.box * 2;
    }
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
    this._v = new THREE.Vector3();
    scene.add(this.mesh);
    this.scene = scene;
    this.intensity = 1;
  }

  update(dt, camera, carVelocity) {
    if (this.intensity <= 0.001) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    const cam = camera.position;
    const B = this.box;
    // Streaks lean into the direction of travel — sells speed in the rain.
    const lean = this._v.copy(this.wind).addScaledVector(carVelocity || this._v.set(0, 0, 0), -0.12);
    const fall = new THREE.Vector3(lean.x, -this.speed, lean.z);
    const len = fall.length();
    const dir = fall.clone().normalize();
    this._q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
    this._s.set(1, clamp(len / this.speed, 0.7, 2.4), 1);

    for (let i = 0; i < this.count; i++) {
      let x = this.p[i * 3], y = this.p[i * 3 + 1], z = this.p[i * 3 + 2];
      x += fall.x * dt; y += fall.y * dt; z += fall.z * dt;
      // Wrap relative to the camera.
      const rx = x - cam.x, ry = y - cam.y, rz = z - cam.z;
      if (ry < -B * 0.35) y += B * 1.3;
      if (rx > B) x -= B * 2; else if (rx < -B) x += B * 2;
      if (rz > B) z -= B * 2; else if (rz < -B) z += B * 2;
      this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
      this._m.compose(this._v.set(x, y, z), this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.material.opacity = 0.42 * this.intensity;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
