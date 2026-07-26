import * as THREE from 'three';
import { trimBox, frustum, wallShell } from './buildings.js';
import { canvas, toTexture } from '../render/textures.js';
import { TAU, lerp, clamp, makeRNG } from '../core/math.js';

const mesh = (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
};

// ────────────────────────────────────────────────────────────────────────────
//  Shared building blocks
// ────────────────────────────────────────────────────────────────────────────

/**
 * Tapered lattice tower (Eiffel / Tokyo Tower).
 * `radiusAt(t)` returns the half-width at normalised height t.
 */
export function latticeTower(mat, height, radiusAt, segments = 14, opts = {}) {
  const g = new THREE.Group();
  const { postR = 0.55, braceR = 0.28, sides = 4, braceEvery = 1 } = opts;

  const corner = (t, i) => {
    const r = radiusAt(t);
    const a = (i / sides) * TAU + Math.PI / sides;
    return new THREE.Vector3(Math.cos(a) * r, t * height, Math.sin(a) * r);
  };

  const strut = (a, b, radius) => {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 0.01) return;
    const c = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 5), mat);
    c.position.copy(a).addScaledVector(dir, 0.5);
    c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    c.castShadow = true;
    g.add(c);
  };

  for (let s = 0; s < segments; s++) {
    const t0 = s / segments, t1 = (s + 1) / segments;
    for (let i = 0; i < sides; i++) {
      const a0 = corner(t0, i), a1 = corner(t1, i);
      const scale = lerp(1.0, 0.45, t0);
      strut(a0, a1, postR * scale);
      // Horizontal ring
      const b0 = corner(t0, (i + 1) % sides);
      strut(a0, b0, braceR * scale);
      // X bracing
      if (s % braceEvery === 0) {
        const b1 = corner(t1, (i + 1) % sides);
        strut(a0, b1, braceR * scale * 0.85);
        strut(b0, a1, braceR * scale * 0.85);
      }
    }
  }
  // Cap ring
  for (let i = 0; i < sides; i++) {
    strut(corner(1, i), corner(1, (i + 1) % sides), braceR * 0.45);
  }
  return g;
}

/** Clock dial texture — cream face, gothic ring, roman numerals, hands. */
export function makeClockFace(hour = 10, minute = 9) {
  const S = 512;
  const cv = canvas(S);
  const g = cv.getContext('2d');
  const c = S / 2;

  // Ornate stone surround
  g.fillStyle = '#b9ae97';
  g.beginPath(); g.arc(c, c, S * 0.5, 0, TAU); g.fill();
  g.fillStyle = '#8f866f';
  g.beginPath(); g.arc(c, c, S * 0.455, 0, TAU); g.fill();

  // Gilded ring with tracery lobes
  g.fillStyle = '#c9a349';
  g.beginPath(); g.arc(c, c, S * 0.44, 0, TAU); g.fill();
  g.fillStyle = '#efe6cf';
  g.beginPath(); g.arc(c, c, S * 0.415, 0, TAU); g.fill();

  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    g.fillStyle = i % 2 ? '#d8cfae' : '#c9a349';
    g.beginPath();
    g.arc(c + Math.cos(a) * S * 0.428, c + Math.sin(a) * S * 0.428, S * 0.028, 0, TAU);
    g.fill();
  }

  // Dial
  g.fillStyle = '#efe9d6';
  g.beginPath(); g.arc(c, c, S * 0.39, 0, TAU); g.fill();

  // Glazing bars — the panelled look of the real dial
  g.strokeStyle = 'rgba(70,62,45,0.5)';
  g.lineWidth = 2.5;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    g.beginPath();
    g.moveTo(c + Math.cos(a) * S * 0.10, c + Math.sin(a) * S * 0.10);
    g.lineTo(c + Math.cos(a) * S * 0.385, c + Math.sin(a) * S * 0.385);
    g.stroke();
  }
  for (const rr of [0.18, 0.27, 0.35]) {
    g.beginPath(); g.arc(c, c, S * rr, 0, TAU); g.stroke();
  }

  // Roman numerals
  const nums = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
  g.fillStyle = '#22201a';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${S * 0.072}px Georgia, serif`;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU - Math.PI / 2;
    g.save();
    g.translate(c + Math.cos(a) * S * 0.325, c + Math.sin(a) * S * 0.325);
    g.rotate(a + Math.PI / 2);
    g.fillText(nums[i], 0, 0);
    g.restore();
  }

  // Hands
  const hand = (angle, len, wid) => {
    g.save();
    g.translate(c, c);
    g.rotate(angle);
    g.fillStyle = '#1a1814';
    g.beginPath();
    g.moveTo(-wid, wid * 1.6);
    g.lineTo(0, -len);
    g.lineTo(wid, wid * 1.6);
    g.closePath();
    g.fill();
    g.restore();
  };
  hand(((hour % 12) / 12) * TAU + (minute / 60) * (TAU / 12), S * 0.22, S * 0.019);
  hand((minute / 60) * TAU, S * 0.33, S * 0.013);
  g.fillStyle = '#c9a349';
  g.beginPath(); g.arc(c, c, S * 0.022, 0, TAU); g.fill();

  return toTexture(cv, { wrap: THREE.ClampToEdgeWrapping });
}

// ════════════════════════════════════════════════════════════════════════════
//  LONDON — Elizabeth Tower (Big Ben)
// ════════════════════════════════════════════════════════════════════════════
export function bigBen(kit, opts = {}) {
  const g = new THREE.Group();
  const scale = opts.scale ?? 1;
  const stone = kit.mats.stone;
  const trim = kit.mats.trim;
  const roof = kit.mats.roof;
  const gold = kit.mats.gold;
  const dark = kit.mats.dark;
  const W = 12.5;               // tower is ~12m square in reality
  const rng = makeRNG(42);

  // ── Shaft: four stages, each slightly stepped in ────────────────────────
  const stages = [
    { h: 16, w: W + 1.6 },
    { h: 20, w: W + 0.9 },
    { h: 20, w: W + 0.4 },
    { h: 12, w: W },
  ];
  let y = 0;
  for (const st of stages) {
    const body = new THREE.Mesh(wallShell(st.w, st.h, st.w, 3.1, 4.0), opts.facade || stone);
    body.position.y = y;
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    // Tall pointed-arch windows down each face
    const bays = 3;
    for (let f = 0; f < 4; f++) {
      const a = (f / 4) * TAU;
      const nx = Math.sin(a), nz = Math.cos(a);
      for (let b = 0; b < bays; b++) {
        const off = (b - (bays - 1) / 2) * (st.w / bays);
        const px = nx * (st.w / 2 + 0.06) - nz * off;
        const pz = nz * (st.w / 2 + 0.06) + nx * off;
        const wh = st.h * 0.42;
        const win = mesh(trimBox(1.5, wh, 0.12), dark, px, y + st.h * 0.52, pz, 0, a, 0);
        g.add(win);
        const arch = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.12, 10, 1, false, 0, Math.PI), dark);
        arch.position.set(px, y + st.h * 0.52 + wh / 2, pz);
        arch.rotation.set(Math.PI / 2, 0, 0);
        arch.rotateY(-a);
        g.add(arch);
      }
      // String course
    }
    g.add(mesh(trimBox(st.w + 0.7, 0.55, st.w + 0.7), trim, 0, y + st.h, 0));
    y += st.h;
  }

  // ── Clock stage ─────────────────────────────────────────────────────────
  const clockH = 12;
  const cw = W + 0.7;
  const clockBody = new THREE.Mesh(wallShell(cw, clockH, cw, 3.4, 6), opts.facade || stone);
  clockBody.position.y = y;
  clockBody.castShadow = true; clockBody.receiveShadow = true;
  g.add(clockBody);

  const clockTex = opts.clockTexture || makeClockFace(10, 9);
  const clockMat = new THREE.MeshStandardMaterial({
    map: clockTex, roughness: 0.55, metalness: 0.05,
    emissive: 0xffffff, emissiveMap: clockTex,
    emissiveIntensity: opts.night ? 1.5 : 0.16,
  });
  const dial = new THREE.CircleGeometry(3.5, 40);
  for (let f = 0; f < 4; f++) {
    const a = (f / 4) * TAU;
    g.add(mesh(dial, clockMat, Math.sin(a) * (cw / 2 + 0.14), y + clockH * 0.52, Math.cos(a) * (cw / 2 + 0.14), 0, a, 0));
    // Stone surround ring
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.72, 0.32, 8, 32), trim);
    ring.position.set(Math.sin(a) * (cw / 2 + 0.10), y + clockH * 0.52, Math.cos(a) * (cw / 2 + 0.10));
    ring.rotation.y = a;
    ring.castShadow = true;
    g.add(ring);
  }
  g.add(mesh(trimBox(cw + 1.5, 0.7, cw + 1.5), trim, 0, y + clockH, 0));
  y += clockH;

  // ── Belfry with louvres ─────────────────────────────────────────────────
  const belfryH = 11;
  const bw = W + 0.2;
  g.add(mesh(trimBox(bw, belfryH, bw), stone, 0, y + belfryH / 2, 0));
  for (let f = 0; f < 4; f++) {
    const a = (f / 4) * TAU;
    const nx = Math.sin(a), nz = Math.cos(a);
    for (let b = -1; b <= 1; b++) {
      const off = b * 3.6;
      const px = nx * (bw / 2 + 0.05) - nz * off;
      const pz = nz * (bw / 2 + 0.05) + nx * off;
      g.add(mesh(trimBox(2.5, belfryH * 0.66, 0.16), dark, px, y + belfryH * 0.5, pz, 0, a, 0));
      for (let l = 0; l < 9; l++) {
        g.add(mesh(trimBox(2.4, 0.22, 0.28), trim,
          px, y + belfryH * 0.18 + l * (belfryH * 0.64 / 9), pz, -0.35, a, 0));
      }
    }
  }
  g.add(mesh(trimBox(bw + 1.9, 0.8, bw + 1.9), trim, 0, y + belfryH, 0));
  y += belfryH;

  // ── Corner pinnacles + the cast-iron spire ──────────────────────────────
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = sx * (bw / 2 + 0.5), pz = sz * (bw / 2 + 0.5);
    g.add(mesh(frustum(1.7, 1.7, 1.15, 1.15, 2.6, 0.5), stone, px, y, pz));
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.92, 5.5, 4), roof);
    sp.position.set(px, y + 2.6 + 2.75, pz);
    sp.rotation.y = Math.PI / 4;
    sp.castShadow = true;
    g.add(sp);
    g.add(mesh(new THREE.SphereGeometry(0.24, 8, 6), gold, px, y + 8.6, pz));
  }

  // Steep pyramidal roof in three tapering stages, gilded at the joints.
  const r1 = new THREE.Mesh(frustum(bw + 1.0, bw + 1.0, bw * 0.62, bw * 0.62, 4.6, 0.4), roof);
  r1.position.y = y; r1.castShadow = true; g.add(r1);
  g.add(mesh(trimBox(bw * 0.68, 0.36, bw * 0.68), gold, 0, y + 4.6, 0));

  const r2 = new THREE.Mesh(frustum(bw * 0.66, bw * 0.66, bw * 0.3, bw * 0.3, 6.4, 0.4), roof);
  r2.position.y = y + 4.9; r2.castShadow = true; g.add(r2);
  g.add(mesh(trimBox(bw * 0.34, 0.3, bw * 0.34), gold, 0, y + 11.3, 0));

  const spire = new THREE.Mesh(new THREE.ConeGeometry(bw * 0.20, 9.0, 4), roof);
  spire.position.y = y + 11.6 + 4.5;
  spire.rotation.y = Math.PI / 4;
  spire.castShadow = true;
  g.add(spire);

  // Ayrton light + finial
  g.add(mesh(new THREE.CylinderGeometry(0.45, 0.62, 1.4, 8), gold, 0, y + 21.0, 0));
  g.add(mesh(new THREE.SphereGeometry(0.5, 12, 8), gold, 0, y + 22.0, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.06, 0.1, 2.6, 6), gold, 0, y + 23.6, 0));
  g.add(mesh(new THREE.SphereGeometry(0.2, 8, 6), gold, 0, y + 25.0, 0));

  g.scale.setScalar(scale);
  g.userData.height = (y + 25) * scale;
  return g;
}

/** Palace of Westminster river frontage: long gothic range + Victoria Tower. */
export function westminsterRange(kit, opts = {}) {
  const g = new THREE.Group();
  const stone = opts.facade || kit.mats.stone;
  const trim = kit.mats.trim;
  const roof = kit.mats.roof;
  const rng = makeRNG(77);
  const len = opts.length ?? 150;
  const h = opts.height ?? 26;
  const d = opts.depth ?? 22;

  // Main range
  const body = new THREE.Mesh(wallShell(len, h, d, 3.2, 5.2), stone);
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);

  // Buttress piers + pinnacles along the frontage
  const piers = Math.round(len / 6.4);
  for (let i = 0; i <= piers; i++) {
    const x = -len / 2 + (len / piers) * i;
    g.add(mesh(trimBox(1.0, h, 1.0), stone, x, h / 2, d / 2 + 0.3));
    g.add(mesh(frustum(1.15, 1.15, 0.6, 0.6, 1.8, 0.5), stone, x, h, d / 2 + 0.3));
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.46, 3.4, 4), stone);
    sp.position.set(x, h + 1.8 + 1.7, d / 2 + 0.3);
    sp.rotation.y = Math.PI / 4;
    sp.castShadow = true;
    g.add(sp);
  }
  // Crenellated parapet
  const merlons = Math.round(len / 1.5);
  for (let i = 0; i < merlons; i++) {
    if (i % 2) continue;
    const x = -len / 2 + (len / merlons) * (i + 0.5);
    g.add(mesh(trimBox(len / merlons * 0.85, 0.9, 0.55), stone, x, h + 0.45, d / 2 - 0.1));
  }
  g.add(mesh(trimBox(len + 0.6, 0.4, d + 0.6), trim, 0, h + 0.2, 0));

  // Steep slate roof
  const rf = new THREE.Mesh(frustum(len - 2.5, d - 2.5, len - 8, d * 0.22, 5.5, 0.3), roof);
  rf.position.y = h + 0.4;
  rf.castShadow = true;
  g.add(rf);

  // Roof ventilator spirelets
  for (let i = 0; i < 9; i++) {
    const x = -len / 2 + (len / 9) * (i + 0.5);
    const base = mesh(trimBox(1.5, 2.0, 1.5), stone, x, h + 5.9, 0);
    g.add(base);
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.9, 4.2, 8), roof);
    sp.position.set(x, h + 9.0, 0);
    sp.castShadow = true;
    g.add(sp);
    g.add(mesh(new THREE.SphereGeometry(0.2, 8, 6), kit.mats.gold, x, h + 11.2, 0));
  }

  // Central spire (Central Tower)
  const cx = 0;
  g.add(mesh(trimBox(11, h + 12, 11), stone, cx, (h + 12) / 2, 0));
  g.add(mesh(trimBox(13, 0.7, 13), trim, cx, h + 12, 0));
  const cSpire = new THREE.Mesh(new THREE.ConeGeometry(6.2, 26, 8), roof);
  cSpire.position.set(cx, h + 12 + 13, 0);
  cSpire.castShadow = true;
  g.add(cSpire);
  g.add(mesh(new THREE.SphereGeometry(0.7, 10, 8), kit.mats.gold, cx, h + 12 + 26.4, 0));

  return g;
}

/** Victoria Tower — the big square tower at the far end of the Palace. */
export function victoriaTower(kit, opts = {}) {
  const g = new THREE.Group();
  const stone = opts.facade || kit.mats.stone;
  const trim = kit.mats.trim;
  const roof = kit.mats.roof;
  const W = 22, H = 74;
  const body = new THREE.Mesh(wallShell(W, H, W, 3.6, 5.6), stone);
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.add(mesh(trimBox(3.2, H + 3, 3.2), stone, sx * (W / 2 - 0.4), (H + 3) / 2, sz * (W / 2 - 0.4)));
    const sp = new THREE.Mesh(new THREE.ConeGeometry(1.9, 8.5, 4), roof);
    sp.position.set(sx * (W / 2 - 0.4), H + 3 + 4.25, sz * (W / 2 - 0.4));
    sp.rotation.y = Math.PI / 4;
    sp.castShadow = true;
    g.add(sp);
  }
  g.add(mesh(trimBox(W + 2.4, 1.0, W + 2.4), trim, 0, H + 0.5, 0));
  const cap = new THREE.Mesh(frustum(W - 1, W - 1, W * 0.35, W * 0.35, 9, 0.3), roof);
  cap.position.y = H + 1.0;
  cap.castShadow = true;
  g.add(cap);
  const fl = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 14, 8), kit.mats.gold);
  fl.position.y = H + 17;
  g.add(fl);
  return g;
}

// ════════════════════════════════════════════════════════════════════════════
//  PARIS
// ════════════════════════════════════════════════════════════════════════════
export function eiffelTower(kit, opts = {}) {
  const g = new THREE.Group();
  const mat = opts.material || kit.mats.iron || kit.mats.metal;
  const H = opts.height ?? 300;

  // Four splayed legs, then the tapering shaft — the classic exponential curve.
  const radiusAt = (t) => {
    const y = t * H;
    return 6 + 52 * Math.exp(-y / 62);
  };

  // Legs (below the first platform) get their own heavier lattice.
  const legTop = 0.19;
  const legs = latticeTower(mat, H * legTop, (t) => radiusAt(t * legTop), 5, { postR: 1.5, braceR: 0.55 });
  g.add(legs);

  // First platform
  const p1y = H * legTop;
  const p1r = radiusAt(legTop) + 4;
  g.add(mesh(trimBox(p1r * 2, 1.6, p1r * 2), mat, 0, p1y, 0));
  g.add(mesh(trimBox(p1r * 2 + 3, 0.5, p1r * 2 + 3), mat, 0, p1y + 1.4, 0));

  // Arches under the first platform
  for (let f = 0; f < 4; f++) {
    const a = (f / 4) * TAU;
    const arch = new THREE.Mesh(new THREE.TorusGeometry(radiusAt(0.06) * 0.86, 1.1, 6, 18, Math.PI), mat);
    arch.position.set(Math.sin(a) * 0.5, p1y * 0.42, Math.cos(a) * 0.5);
    arch.rotation.y = a;
    arch.castShadow = true;
    g.add(arch);
  }

  const mid = latticeTower(mat, H * 0.42, (t) => radiusAt(legTop + t * 0.42), 9, { postR: 0.85, braceR: 0.32 });
  mid.position.y = p1y;
  g.add(mid);

  const p2y = H * (legTop + 0.42);
  const p2r = radiusAt(legTop + 0.42) + 2.4;
  g.add(mesh(trimBox(p2r * 2, 1.3, p2r * 2), mat, 0, p2y, 0));

  const up = latticeTower(mat, H * 0.34, (t) => radiusAt(legTop + 0.42 + t * 0.34), 12, { postR: 0.45, braceR: 0.2 });
  up.position.y = p2y;
  g.add(up);

  const p3y = H * (legTop + 0.42 + 0.34);
  const p3r = radiusAt(0.95) + 1.6;
  g.add(mesh(new THREE.CylinderGeometry(p3r, p3r * 1.1, 5.5, 10), mat, 0, p3y + 2.5, 0));
  g.add(mesh(new THREE.CylinderGeometry(p3r * 0.8, p3r * 0.8, 3.5, 10), kit.mats.trim, 0, p3y + 7.5, 0));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(p3r * 0.8, 12, 8, 0, TAU, 0, Math.PI / 2), mat);
  dome.position.y = p3y + 9.2;
  g.add(dome);
  g.add(mesh(new THREE.CylinderGeometry(0.3, 0.7, H * 0.075, 8), mat, 0, p3y + 9.2 + H * 0.037, 0));
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), kit.mats.emissiveWarm);
  beacon.position.y = p3y + 9.2 + H * 0.078;
  g.add(beacon);

  return g;
}

export function arcDeTriomphe(kit, opts = {}) {
  const g = new THREE.Group();
  const stone = opts.facade || kit.mats.stone;
  const trim = kit.mats.trim;
  const W = 45, H = 50, D = 22;
  const archW = 14.6, archH = 29;

  // Two piers either side of the main arch.
  const pierW = (W - archW) / 2;
  for (const s of [-1, 1]) {
    g.add(mesh(trimBox(pierW, H, D), stone, s * (archW + pierW) / 2, H / 2, 0));
  }
  // Spandrel above the arch
  g.add(mesh(trimBox(archW, H - archH, D), stone, 0, archH + (H - archH) / 2, 0));
  // Vault
  const vault = new THREE.Mesh(new THREE.CylinderGeometry(archW / 2, archW / 2, D, 24, 1, true, 0, Math.PI), stone);
  vault.rotation.set(Math.PI / 2, 0, 0);
  vault.position.y = archH - archW / 2;
  vault.material = stone;
  vault.castShadow = true; vault.receiveShadow = true;
  g.add(vault);

  // Transverse arches through the piers
  for (const s of [-1, 1]) {
    const tw = 8.5;
    const v = new THREE.Mesh(new THREE.CylinderGeometry(tw / 2, tw / 2, pierW + 1, 16, 1, true, 0, Math.PI), stone);
    v.rotation.set(0, 0, Math.PI / 2);
    v.rotateX(Math.PI / 2);
    v.position.set(s * (archW + pierW) / 2, 14, 0);
    g.add(v);
  }

  // Attic storey + cornice
  g.add(mesh(trimBox(W + 3, 2.2, D + 3), trim, 0, H + 1.1, 0));
  g.add(mesh(trimBox(W, 7, D), stone, 0, H + 5.7, 0));
  g.add(mesh(trimBox(W + 2, 1.2, D + 2), trim, 0, H + 9.8, 0));
  // Relief panels
  for (const s of [-1, 1]) for (const z of [-1, 1]) {
    g.add(mesh(trimBox(pierW * 0.66, 13, 0.5), trim, s * (archW + pierW) / 2, 34, z * (D / 2 + 0.26)));
  }
  return g;
}

// ════════════════════════════════════════════════════════════════════════════
//  TOKYO
// ════════════════════════════════════════════════════════════════════════════
export function tokyoTower(kit, opts = {}) {
  const g = new THREE.Group();
  const H = opts.height ?? 250;
  const red = new THREE.MeshStandardMaterial({ color: 0xd8451f, roughness: 0.55, metalness: 0.35, envMapIntensity: 1.0 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe4e2dc, roughness: 0.6, metalness: 0.25 });
  const radiusAt = (t) => 4.5 + 38 * Math.exp(-(t * H) / 52);

  const legTop = 0.16;
  g.add(latticeTower(red, H * legTop, (t) => radiusAt(t * legTop), 4, { postR: 1.3, braceR: 0.5 }));

  const p1y = H * legTop;
  const p1r = radiusAt(legTop) + 3;
  g.add(mesh(trimBox(p1r * 2, 6, p1r * 2), white, 0, p1y + 3, 0));
  g.add(mesh(trimBox(p1r * 2 + 2, 0.8, p1r * 2 + 2), red, 0, p1y + 6.4, 0));

  const shaft = latticeTower(red, H * 0.52, (t) => radiusAt(legTop + t * 0.52), 11, { postR: 0.7, braceR: 0.27 });
  shaft.position.y = p1y + 6.8;
  g.add(shaft);

  const p2y = p1y + 6.8 + H * 0.52;
  const p2r = radiusAt(legTop + 0.52) + 2;
  g.add(mesh(new THREE.CylinderGeometry(p2r, p2r, 5, 12), white, 0, p2y + 2.5, 0));
  g.add(mesh(new THREE.CylinderGeometry(p2r * 1.06, p2r * 1.06, 0.6, 12), red, 0, p2y + 5.4, 0));

  const top = latticeTower(red, H * 0.16, (t) => radiusAt(0.68 + t * 0.16), 6, { postR: 0.35, braceR: 0.15 });
  top.position.y = p2y + 5.8;
  g.add(top);

  const mastY = p2y + 5.8 + H * 0.16;
  g.add(mesh(new THREE.CylinderGeometry(0.5, 1.4, H * 0.14, 8), red, 0, mastY + H * 0.07, 0));
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8), kit.mats.emissiveWarm);
  beacon.position.y = mastY + H * 0.145;
  g.add(beacon);
  return g;
}

/** Big animated-looking media screen for Shibuya-style facades. */
export function mediaScreen(w, h, texture, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: texture, emissive: 0xffffff, emissiveMap: texture,
    emissiveIntensity: opts.intensity ?? 3.2, roughness: 0.35, metalness: 0,
    toneMapped: true,
  });
  const g = new THREE.Group();
  const frame = mesh(trimBox(w + 0.5, h + 0.5, 0.4), new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.7 }));
  g.add(frame);
  g.add(mesh(new THREE.PlaneGeometry(w, h), mat, 0, 0, 0.22));
  return g;
}

export function torii(kit, opts = {}) {
  const g = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: 0xb2321f, roughness: 0.68 });
  const dark = kit.mats.dark;
  const W = opts.width ?? 9, H = opts.height ?? 8;
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.CylinderGeometry(0.42, 0.5, H, 12), red, s * W / 2, H / 2, 0, 0, 0, s * 0.03));
  }
  const top = mesh(trimBox(W + 3.4, 0.55, 1.0), red, 0, H + 0.6, 0);
  g.add(top);
  const cap = new THREE.Mesh(frustum(W + 4.2, 1.4, W + 3.0, 1.0, 0.55, 0.4), dark);
  cap.position.y = H + 0.9;
  g.add(cap);
  g.add(mesh(trimBox(W + 0.8, 0.42, 0.8), red, 0, H - 1.3, 0));
  g.add(mesh(trimBox(0.7, 1.2, 0.7), red, 0, H - 0.4, 0));
  return g;
}

// ════════════════════════════════════════════════════════════════════════════
//  BEIJING
// ════════════════════════════════════════════════════════════════════════════
/** CCTV Headquarters — two leaning towers joined by an L-shaped overhang. */
export function cctvTower(kit, opts = {}) {
  const g = new THREE.Group();
  const glass = opts.material || kit.mats.glassDark;
  const H = opts.height ?? 170;
  const w = 26, d = 32;
  const lean = 0.055;

  const leg = (sx) => {
    const seg = 10;
    const grp = new THREE.Group();
    for (let i = 0; i < seg; i++) {
      const t = i / seg;
      const hh = H * 0.78 / seg;
      const b = mesh(trimBox(w, hh, d), glass, sx * t * H * lean, hh * (i + 0.5), 0, 0, 0, 0);
      grp.add(b);
    }
    return grp;
  };
  const l1 = leg(1);
  l1.position.set(-38, 0, 0);
  g.add(l1);
  const l2 = leg(-1);
  l2.position.set(38, 0, 22);
  g.add(l2);

  // The cantilevered overhang that closes the loop.
  const topY = H * 0.78;
  g.add(mesh(trimBox(96, H * 0.16, d), glass, 0, topY + H * 0.08, 0));
  g.add(mesh(trimBox(w, H * 0.16, 30), glass, 38 - H * 0.78 * lean, topY + H * 0.08, 16));

  // Diagonal structural mesh, the building's signature.
  const strut = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.45, metalness: 0.7 });
  for (let i = 0; i < 26; i++) {
    const t = i / 26;
    const y = t * topY;
    for (const s of [-1, 1]) {
      const bar = mesh(trimBox(0.6, 14, 0.6), strut, s * 38 + s * t * H * lean * (s > 0 ? -1 : 1), y + 7, (s > 0 ? 22 : 0) + d / 2 + 0.4, 0, 0, 0.55 * (i % 2 ? 1 : -1));
      g.add(bar);
    }
  }
  return g;
}

/** Temple of Heaven style circular triple-eaved hall. */
export function circularTemple(kit, opts = {}) {
  const g = new THREE.Group();
  const stone = kit.mats.stone;
  const red = kit.mats.red;
  const blue = new THREE.MeshStandardMaterial({ color: 0x2b4a86, roughness: 0.5, metalness: 0.2, envMapIntensity: 0.9 });
  const gold = kit.mats.gold;
  const R = opts.radius ?? 18;

  for (let i = 0; i < 3; i++) {
    const rr = R + (2 - i) * 4.5;
    g.add(mesh(new THREE.CylinderGeometry(rr, rr + 1.2, 1.4, 40), stone, 0, 0.7 + i * 1.4, 0));
  }
  let y = 4.4;
  let cr = R;
  for (let tier = 0; tier < 3; tier++) {
    const wallH = 6.5 - tier * 0.8;
    g.add(mesh(new THREE.CylinderGeometry(cr * 0.86, cr * 0.86, wallH, 32), red, 0, y + wallH / 2, 0));
    const cols = 20 - tier * 4;
    for (let i = 0; i < cols; i++) {
      const a = (i / cols) * TAU;
      g.add(mesh(new THREE.CylinderGeometry(0.32, 0.36, wallH, 8), red,
        Math.cos(a) * cr * 0.9, y + wallH / 2, Math.sin(a) * cr * 0.9));
    }
    g.add(mesh(new THREE.CylinderGeometry(cr * 0.95, cr * 0.95, 0.7, 32), gold, 0, y + wallH + 0.35, 0));
    const eave = new THREE.Mesh(new THREE.ConeGeometry(cr + 2.6, 4.6, 32), blue);
    eave.position.y = y + wallH + 2.9;
    eave.castShadow = true; eave.receiveShadow = true;
    g.add(eave);
    y += wallH + 4.4;
    cr *= 0.74;
  }
  g.add(mesh(new THREE.CylinderGeometry(1.0, 1.6, 3.0, 12), gold, 0, y + 1.5, 0));
  g.add(mesh(new THREE.SphereGeometry(1.5, 14, 10), gold, 0, y + 3.6, 0));
  return g;
}

// ════════════════════════════════════════════════════════════════════════════
//  NEW YORK
// ════════════════════════════════════════════════════════════════════════════
export function decoTower(kit, opts = {}) {
  const g = new THREE.Group();
  const facade = opts.facade || kit.mats.stone;
  const trim = kit.mats.trim;
  const metal = kit.mats.metal;
  const H = opts.height ?? 220;
  let y = 0, w = opts.width ?? 54, d = opts.depth ?? 42;

  const setbacks = 6;
  for (let i = 0; i < setbacks; i++) {
    const th = (H * 0.82 / setbacks) * (i === 0 ? 1.6 : 1.0) * (1 - i * 0.06);
    const body = new THREE.Mesh(wallShell(w, th, d, 3.2, 3.8), facade);
    body.position.y = y;
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    g.add(mesh(trimBox(w + 1.2, 0.8, d + 1.2), trim, 0, y + th, 0));
    y += th + 0.4;
    w *= 0.80; d *= 0.82;
  }
  // Crown + mast
  const crown = new THREE.Mesh(frustum(w, d, w * 0.35, d * 0.35, H * 0.09, 0.3), metal);
  crown.position.y = y;
  crown.castShadow = true;
  g.add(crown);
  y += H * 0.09;
  for (let i = 0; i < 4; i++) {
    const r = w * (0.3 - i * 0.06);
    g.add(mesh(new THREE.CylinderGeometry(r, r * 1.25, H * 0.02, 12), metal, 0, y + H * 0.01, 0));
    y += H * 0.022;
  }
  g.add(mesh(new THREE.CylinderGeometry(0.55, 1.4, H * 0.11, 10), metal, 0, y + H * 0.055, 0));
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.0, 10, 8), kit.mats.emissiveWarm);
  beacon.position.y = y + H * 0.115;
  g.add(beacon);
  return g;
}

// ════════════════════════════════════════════════════════════════════════════
//  DUBAI
// ════════════════════════════════════════════════════════════════════════════
export function sailTower(kit, opts = {}) {
  const g = new THREE.Group();
  const H = opts.height ?? 200;
  const white = new THREE.MeshStandardMaterial({
    color: 0xe8eaee, roughness: 0.34, metalness: 0.1, envMapIntensity: 1.4, side: THREE.DoubleSide,
  });
  const glass = kit.mats.glassDark;

  // Two curved spine walls with the "sail" membrane between them.
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(H * 0.42, H * 0.30, H * 0.16, H);
  shape.lineTo(H * 0.03, H);
  shape.quadraticCurveTo(H * 0.14, H * 0.34, 0, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 3.5, bevelEnabled: false, curveSegments: 24 });
  geo.translate(0, 0, -1.75);
  for (const s of [-1, 1]) {
    const m = mesh(geo, white, 0, 0, s * 16);
    g.add(m);
  }
  // Glazed face
  const face = new THREE.Mesh(new THREE.PlaneGeometry(32, H * 0.94, 4, 20), glass);
  face.position.set(H * 0.10, H * 0.5, 0);
  face.rotation.y = Math.PI / 2;
  const p = face.geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) + H * 0.47) / (H * 0.94);
    p.setZ(i, -Math.sin(t * Math.PI) * H * 0.13);
  }
  p.needsUpdate = true;
  face.geometry.computeVertexNormals();
  face.castShadow = true;
  g.add(face);
  // Helipad
  g.add(mesh(new THREE.CylinderGeometry(9, 9, 1.0, 20), white, -6, H * 0.86, 0));
  return g;
}
