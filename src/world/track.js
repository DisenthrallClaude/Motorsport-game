import * as THREE from 'three';
import { clamp, lerp, TAU, makeRNG } from '../core/math.js';
import { LAYER } from '../render/postfx.js';
import { makeRoadTexture, makePavement } from '../render/textures.js';
import { makeRoadMaterial, makeSurface } from '../render/materials.js';

/**
 * A city circuit built from a centre-line spline.
 *
 * Everything downstream — road mesh, pavements, buildings, props, AI racing
 * line, traffic lanes and the minimap — is derived from the sample array this
 * class produces, so a new city is just a new list of control points.
 */
export class Track {
  constructor(spec) {
    this.spec = spec;
    this.closed = spec.closed !== false;
    this.width = spec.width ?? 15;
    this.name = spec.name ?? 'circuit';

    const pts = spec.points.map((p) => new THREE.Vector3(p[0], p[1] ?? 0, p[2]));
    this.curve = new THREE.CatmullRomCurve3(pts, this.closed, 'centripetal', spec.tension ?? 0.5);

    this._buildSamples(spec.resolution ?? 2.0);
    this._buildLookup();
    this._buildWidthProfile();
  }

  // ────────────────────────────────────────────────────────────────────────
  _buildSamples(spacing) {
    // Two-pass: rough arc length, then even re-sampling by distance.
    const rough = Math.max(400, Math.ceil(this.curve.getLength() / spacing));
    const lengths = this.curve.getLengths(rough);
    this.length = lengths[lengths.length - 1];

    const count = Math.max(64, Math.round(this.length / spacing));
    const samples = new Array(count);
    const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < count; i++) {
      const dist = (i / count) * this.length;
      const u = this.curve.getUtoTmapping(0, dist);
      const pos = this.curve.getPoint(u);
      const tan = this.curve.getTangent(u).normalize();
      const right = new THREE.Vector3().crossVectors(tan, up).normalize();
      samples[i] = {
        i,
        dist,
        pos,
        tan,
        right,
        up: new THREE.Vector3(0, 1, 0),
        curvature: 0,
        heading: Math.atan2(tan.x, tan.z),
        bank: 0,
        width: this.width,
      };
    }

    // Signed curvature from the heading derivative — drives banking, AI speed
    // and where we place kerbs.
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const a = samples[(i - 2 + n) % n];
      const b = samples[(i + 2) % n];
      let dh = b.heading - a.heading;
      while (dh > Math.PI) dh -= TAU;
      while (dh < -Math.PI) dh += TAU;
      const ds = 4 * (this.length / n);
      samples[i].curvature = dh / ds;
    }
    // Smooth it so the road doesn't twitch.
    for (let pass = 0; pass < 3; pass++) {
      const src = samples.map((s) => s.curvature);
      for (let i = 0; i < n; i++) {
        samples[i].curvature =
          (src[(i - 1 + n) % n] + src[i] * 2 + src[(i + 1) % n]) * 0.25;
      }
    }

    const bankAmount = this.spec.banking ?? 0.55;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      s.bank = clamp(-s.curvature * 26 * bankAmount, -0.14, 0.14);
      const up2 = new THREE.Vector3(0, 1, 0);
      up2.applyAxisAngle(s.tan, s.bank);
      s.up.copy(up2).normalize();
      s.rightBanked = new THREE.Vector3().crossVectors(s.tan, s.up).normalize();
    }

    this.samples = samples;
    this.count = n;
    this.spacing = this.length / n;
  }

  _buildWidthProfile() {
    // Wider on straights, tighter through corners — reads as a real street plan.
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      const k = Math.abs(s.curvature);
      s.width = this.width * lerp(1.0, 0.88, clamp(k * 24, 0, 1));
    }
    for (let pass = 0; pass < 4; pass++) {
      const src = this.samples.map((s) => s.width);
      for (let i = 0; i < n; i++) {
        this.samples[i].width = (src[(i - 1 + n) % n] + src[i] * 2 + src[(i + 1) % n]) * 0.25;
      }
    }
  }

  /** Uniform grid so `nearest()` is O(1) instead of O(samples). */
  _buildLookup() {
    const cell = 24;
    this._cell = cell;
    const grid = new Map();
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const s of this.samples) {
      minX = Math.min(minX, s.pos.x); maxX = Math.max(maxX, s.pos.x);
      minZ = Math.min(minZ, s.pos.z); maxZ = Math.max(maxZ, s.pos.z);
    }
    this.bounds = { minX, maxX, minZ, maxZ };
    const key = (cx, cz) => cx * 100003 + cz;
    for (const s of this.samples) {
      const cx = Math.floor(s.pos.x / cell), cz = Math.floor(s.pos.z / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const k = key(cx + dx, cz + dz);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(s.i);
        }
      }
    }
    this._grid = grid;
    this._key = key;
  }

  /** Interpolated sample at arc-length `s` (wraps for closed circuits). */
  at(s) {
    const n = this.count;
    let t = s / this.spacing;
    if (this.closed) t = ((t % n) + n) % n;
    else t = clamp(t, 0, n - 1.001);
    const i0 = Math.floor(t);
    const i1 = this.closed ? (i0 + 1) % n : Math.min(i0 + 1, n - 1);
    const f = t - i0;
    const a = this.samples[i0], b = this.samples[i1];
    return {
      pos: a.pos.clone().lerp(b.pos, f),
      tan: a.tan.clone().lerp(b.tan, f).normalize(),
      right: a.right.clone().lerp(b.right, f).normalize(),
      up: a.up.clone().lerp(b.up, f).normalize(),
      curvature: lerp(a.curvature, b.curvature, f),
      width: lerp(a.width, b.width, f),
      bank: lerp(a.bank, b.bank, f),
      dist: s,
      heading: a.heading + shortAngle(a.heading, b.heading) * f,
    };
  }

  /** Closest point on the centre line. Returns arc length + signed offset. */
  nearest(point, hintS = null) {
    let best = null, bestD = Infinity;
    if (hintS !== null) {
      // Local search around last frame's result — much cheaper and stable.
      const span = 14;
      const i0 = Math.round(hintS / this.spacing);
      for (let d = -span; d <= span; d++) {
        const i = this.closed
          ? ((i0 + d) % this.count + this.count) % this.count
          : clamp(i0 + d, 0, this.count - 1);
        const s = this.samples[i];
        const dx = point.x - s.pos.x, dz = point.z - s.pos.z;
        const dd = dx * dx + dz * dz;
        if (dd < bestD) { bestD = dd; best = s; }
      }
      if (bestD < 900) return this._refine(point, best);
    }
    const cx = Math.floor(point.x / this._cell), cz = Math.floor(point.z / this._cell);
    const bucket = this._grid.get(this._key(cx, cz));
    const list = bucket || this.samples.map((s) => s.i);
    for (const idx of list) {
      const s = this.samples[idx];
      const dx = point.x - s.pos.x, dz = point.z - s.pos.z;
      const dd = dx * dx + dz * dz;
      if (dd < bestD) { bestD = dd; best = s; }
    }
    if (!best) best = this.samples[0];
    return this._refine(point, best);
  }

  _refine(point, s) {
    // Project onto the local tangent for sub-sample precision.
    const dx = point.x - s.pos.x, dy = point.y - s.pos.y, dz = point.z - s.pos.z;
    const along = dx * s.tan.x + dz * s.tan.z;
    const lateral = dx * s.right.x + dz * s.right.z;
    return {
      s: s.dist + along,
      lateral,
      height: s.pos.y,
      sample: s,
      onTrack: Math.abs(lateral) <= s.width * 0.5 + 0.4,
      dy,
    };
  }

  /** Ground height at a world position (road surface, banked). */
  heightAt(point, hintS = null) {
    const r = this.nearest(point, hintS);
    const s = r.sample;
    return s.pos.y + Math.sin(s.bank) * -r.lateral;
  }

  worldPoint(s, lateral, lift = 0) {
    const a = this.at(s);
    return new THREE.Vector3()
      .copy(a.pos)
      .addScaledVector(a.right, lateral)
      .addScaledVector(a.up, lift + Math.abs(lateral) * Math.tan(a.bank) * 0);
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Geometry
  // ────────────────────────────────────────────────────────────────────────
  /**
   * Road slab + kerbs + pavements + gutters.
   * Returns { group, roadMaterials } — road materials need the planar
   * reflection fed to them every frame.
   */
  buildSurface(theme) {
    const group = new THREE.Group();
    group.name = 'track-surface';
    const roadMaterials = [];
    const t = theme.road || {};

    const roadTex = makeRoadTexture({
      roadWidth: this.width,
      tileLength: t.tileLength ?? 12,
      markings: t.markings ?? 'uk',
      base: t.asphaltColor ?? 0x2c2d31,
      seed: t.seed ?? 11,
      wear: t.wear ?? 1.0,
    });
    // v repeats along the road, u stays 0..1 across it.
    const tileLen = t.tileLength ?? 12;
    for (const k of ['map', 'normalMap', 'roughnessMap']) {
      roadTex[k].wrapS = THREE.ClampToEdgeWrapping;
      roadTex[k].wrapT = THREE.RepeatWrapping;
      roadTex[k].repeat.set(1, 1);
    }

    const roadMat = makeRoadMaterial({
      textures: roadTex,
      wetness: t.wetness ?? 0.5,
      reflectTint: t.reflectTint ?? 0xffffff,
      reflectStrength: t.reflectStrength ?? 1.0,
      roughness: t.roughness ?? 0.88,
      puddleScale: t.puddleScale ?? 0.012,
    });
    roadMaterials.push(roadMat);

    // ── Road slab ──────────────────────────────────────────────────────────
    const n = this.count;
    const segs = this.closed ? n : n - 1;
    const pos = [], uv = [], nor = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const s = this.samples[i % n];
      const hw = s.width * 0.5;
      const r = s.rightBanked || s.right;
      const l = new THREE.Vector3().copy(s.pos).addScaledVector(r, -hw);
      const rr = new THREE.Vector3().copy(s.pos).addScaledVector(r, hw);
      // Crown: city roads shed water toward the gutters.
      const crown = t.crown ?? 0.09;
      l.y -= crown; rr.y -= crown;
      pos.push(l.x, l.y, l.z, rr.x, rr.y, rr.z);
      const v = s.dist / tileLen;
      uv.push(0, v, 1, v);
      nor.push(s.up.x, s.up.y, s.up.z, s.up.x, s.up.y, s.up.z);
    }
    for (let i = 0; i < segs; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const road = new THREE.Mesh(g, roadMat);
    road.receiveShadow = true;
    road.layers.set(LAYER.MIRROR);
    road.name = 'road';
    group.add(road);
    this.roadMesh = road;

    // ── Kerbs, pavements, gutter strips ────────────────────────────────────
    const pavTex = makePavement({
      style: t.pavementStyle ?? 'slab',
      color: t.pavementColor ?? 0x8e8a84,
      seed: (t.seed ?? 11) + 5,
    });
    const kerbTex = makePavement({
      style: t.kerbStyle ?? 'granite',
      color: t.kerbColor ?? 0x9d9a94,
      seed: (t.seed ?? 11) + 9,
    });

    const pavMat = makeSurface(pavTex, { repeat: [1, 1], roughness: 0.82, envMapIntensity: 0.5 });
    const kerbMat = makeSurface(kerbTex, { repeat: [1, 1], roughness: 0.72, envMapIntensity: 0.6 });
    // Pavements are wet too on rain themes — reuse the reflective material.
    if ((t.wetness ?? 0) > 0.35) {
      pavMat.roughness = 0.5;
      pavMat.envMapIntensity = 0.9;
    }

    const pavWidth = t.pavementWidth ?? 4.2;
    const kerbH = t.kerbHeight ?? 0.16;

    for (const side of [-1, 1]) {
      // Kerb face + top
      const kp = [], ku = [], ki = [];
      const pp = [], pu = [], pi = [];
      for (let i = 0; i <= segs; i++) {
        const s = this.samples[i % n];
        const r = s.rightBanked || s.right;
        const hw = s.width * 0.5;
        const base = new THREE.Vector3().copy(s.pos).addScaledVector(r, side * hw);
        const kerbOut = new THREE.Vector3().copy(base).addScaledVector(r, side * 0.34);
        const pavOut = new THREE.Vector3().copy(base).addScaledVector(r, side * (0.34 + pavWidth));

        // kerb: inner-bottom, inner-top, outer-top
        kp.push(base.x, base.y - (t.crown ?? 0.09), base.z);
        kp.push(base.x, base.y + kerbH, base.z);
        kp.push(kerbOut.x, kerbOut.y + kerbH, kerbOut.z);
        const v = s.dist / 3.0;
        ku.push(0, v, 0.4, v, 1, v);

        pp.push(kerbOut.x, kerbOut.y + kerbH, kerbOut.z);
        pp.push(pavOut.x, pavOut.y + kerbH + 0.02, pavOut.z);
        pu.push(0, s.dist / 4.0, 1, s.dist / 4.0);
      }
      for (let i = 0; i < segs; i++) {
        const a = i * 3, b = (i + 1) * 3;
        // face
        ki.push(a, a + 1, b, a + 1, b + 1, b);
        // top
        ki.push(a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
        const pa = i * 2, pb = (i + 1) * 2;
        pi.push(pa, pa + 1, pb, pa + 1, pb + 1, pb);
      }
      const flip = side < 0;
      const kg = buildGeom(kp, ku, ki, flip);
      const kerb = new THREE.Mesh(kg, kerbMat);
      kerb.receiveShadow = true; kerb.castShadow = true;
      group.add(kerb);

      const pg = buildGeom(pp, pu, pi, flip);
      const pav = new THREE.Mesh(pg, pavMat);
      pav.receiveShadow = true;
      group.add(pav);

      // Outer wall so the pavement doesn't float over the void.
      const wp = [], wu = [], wi = [];
      for (let i = 0; i <= segs; i++) {
        const s = this.samples[i % n];
        const r = s.rightBanked || s.right;
        const hw = s.width * 0.5;
        const o = new THREE.Vector3().copy(s.pos).addScaledVector(r, side * (0.34 + pavWidth));
        wp.push(o.x, o.y + kerbH + 0.02, o.z);
        wp.push(o.x, o.y - 2.5, o.z);
        wu.push(0, s.dist / 4, 1, s.dist / 4);
      }
      for (let i = 0; i < segs; i++) {
        const a = i * 2, b = (i + 1) * 2;
        wi.push(a, a + 1, b, a + 1, b + 1, b);
      }
      const wall = new THREE.Mesh(buildGeom(wp, wu, wi, !flip), kerbMat);
      group.add(wall);
    }

    this.roadTexture = roadTex;
    return { group, roadMaterials };
  }

  /**
   * Racing line: pulls toward the inside of corners and out on entry/exit.
   * Returns an array of lateral offsets, one per sample.
   */
  buildRacingLine(aggression = 1) {
    const n = this.count;
    const line = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      const k = s.curvature;
      const maxOff = s.width * 0.5 - 2.0;
      line[i] = clamp(-Math.sign(k) * Math.min(Math.abs(k) * 320, 1) * maxOff * aggression, -maxOff, maxOff);
    }
    // Heavy smoothing gives the long, sweeping entry/exit arcs a driver uses.
    for (let pass = 0; pass < 26; pass++) {
      const src = Float32Array.from(line);
      for (let i = 0; i < n; i++) {
        const a = src[(i - 1 + n) % n], b = src[i], c = src[(i + 1) % n];
        line[i] = a * 0.29 + b * 0.42 + c * 0.29;
      }
    }
    return line;
  }

  /** Target speed per sample from curvature + a global grip figure. */
  buildSpeedProfile(grip = 15.5, vmax = 92) {
    const n = this.count;
    const sp = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = Math.abs(this.samples[i].curvature);
      sp[i] = k < 1e-5 ? vmax : Math.min(vmax, Math.sqrt(grip / k));
    }
    // Backward pass: you must already be slow when you arrive at the corner.
    const decel = 13.0;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = n - 1; i >= 0; i--) {
        const j = (i + 1) % n;
        const maxV = Math.sqrt(sp[j] * sp[j] + 2 * decel * this.spacing);
        sp[i] = Math.min(sp[i], maxV);
      }
      // Forward pass for acceleration limits.
      const accel = 8.5;
      for (let i = 0; i < n; i++) {
        const j = (i - 1 + n) % n;
        const maxV = Math.sqrt(sp[j] * sp[j] + 2 * accel * this.spacing);
        sp[i] = Math.min(sp[i], maxV);
      }
    }
    return sp;
  }

  /** Evenly spaced grid slots behind the start line. */
  gridSlots(count, startS = 0) {
    const slots = [];
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 2);
      const col = i % 2 === 0 ? -1 : 1;
      const s = startS - 8 - row * 9;
      const a = this.at(s);
      slots.push({
        pos: a.pos.clone().addScaledVector(a.right, col * 3.1).setY(a.pos.y + 0.05),
        heading: a.heading,
        s,
      });
    }
    return slots;
  }

  /** Polyline in track space for the minimap. */
  minimapPath(step = 6) {
    const pts = [];
    for (let i = 0; i < this.count; i += step) {
      pts.push([this.samples[i].pos.x, this.samples[i].pos.z]);
    }
    if (this.closed) pts.push(pts[0]);
    return pts;
  }
}

function shortAngle(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function buildGeom(pos, uv, idx, flip) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (flip) {
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t;
    }
  }
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export { buildGeom };
