import * as THREE from 'three';
import { makeCarPaint, makeGlass, makeChrome, makeCarbon, makeRubber } from '../render/materials.js';
import { makeBarGlow, makeGlowSprite, canvas, toTexture } from '../render/textures.js';
import { LAYER } from '../render/postfx.js';
import { mergeSubtree } from '../world/batch.js';
import { clamp, lerp, TAU, smoothstep, makeRNG } from '../core/math.js';

// ────────────────────────────────────────────────────────────────────────────
//  Surface lofting
//  A car body is defined the way real surfacing works: a series of cross
//  sections down the length, skinned together.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build one cross-section outline (right half, bottom → top).
 * Returns an array of [x, y] with `RES` entries.
 */
const RES = 13;
function section(hw, yBot, yTop, opts = {}) {
  const {
    tuck = 0.86,        // how much the floor pulls in
    shoulder = 1.0,     // fullness at max width
    topW = 0.42,        // width fraction where the top surface starts
    crown = 1.0,        // roundness of the top
    beltY = 0.62,       // where max width sits between bottom and top
  } = opts;
  const h = yTop - yBot;
  const pts = [];
  // Underside
  pts.push([0, yBot]);
  pts.push([hw * tuck * 0.52, yBot - h * 0.008]);
  pts.push([hw * tuck * 0.88, yBot + h * 0.02]);
  pts.push([hw * 0.965, yBot + h * 0.10]);
  // Side
  pts.push([hw * shoulder, yBot + h * (beltY - 0.22)]);
  pts.push([hw * shoulder, yBot + h * beltY]);
  pts.push([hw * (shoulder * 0.985), yBot + h * (beltY + 0.14)]);
  pts.push([hw * (shoulder * 0.94), yBot + h * (beltY + 0.28)]);
  // Shoulder into the top surface
  pts.push([hw * (topW + (shoulder - topW) * 0.62), yBot + h * (beltY + 0.46 * crown)]);
  pts.push([hw * (topW + (shoulder - topW) * 0.30), yBot + h * (beltY + 0.70 * crown)]);
  pts.push([hw * topW * 1.02, yBot + h * (0.94)]);
  pts.push([hw * topW * 0.6, yTop - h * 0.012]);
  pts.push([0, yTop]);
  return pts;
}

/**
 * Skin an ordered list of {z, pts} sections into a closed shell.
 * Mirrors each section across x for the left-hand side.
 */
function loft(sections, opts = {}) {
  const { capFront = true, capBack = true, uvScale = 0.35 } = opts;
  const pos = [], nor = [], uv = [], idx = [];
  const N = RES;
  const ring = N * 2 - 2;      // mirrored, without duplicating the two centre points

  const ringPoint = (s, i) => {
    // 0..N-1 = right side bottom→top, N..ring-1 = left side top→bottom
    if (i < N) return [s.pts[i][0], s.pts[i][1]];
    const j = ring - i;
    return [-s.pts[j][0], s.pts[j][1]];
  };

  for (let si = 0; si < sections.length; si++) {
    const s = sections[si];
    for (let i = 0; i < ring; i++) {
      const [x, y] = ringPoint(s, i);
      pos.push(x, y, s.z);
      uv.push((i / ring) * 3.0 * uvScale, s.z * uvScale);
    }
  }
  // Winding is chosen so the outward face points away from the car's axis:
  // the ring runs bottom-centre → right → top-centre → left, and sections
  // advance toward +Z.
  for (let si = 0; si < sections.length - 1; si++) {
    const a = si * ring, b = (si + 1) * ring;
    for (let i = 0; i < ring; i++) {
      const j = (i + 1) % ring;
      idx.push(a + i, a + j, b + i);
      idx.push(a + j, b + j, b + i);
    }
  }

  // Caps
  const cap = (si, flip) => {
    const base = pos.length / 3;
    const s = sections[si];
    let cxSum = 0, cySum = 0;
    for (let i = 0; i < ring; i++) {
      const [x, y] = ringPoint(s, i);
      pos.push(x, y, s.z);
      uv.push(x * uvScale, y * uvScale);
      cxSum += x; cySum += y;
    }
    const cIdx = pos.length / 3;
    pos.push(0, cySum / ring, s.z);
    uv.push(0, 0);
    for (let i = 0; i < ring; i++) {
      const j = (i + 1) % ring;
      if (flip) idx.push(base + j, cIdx, base + i);
      else idx.push(base + i, cIdx, base + j);
    }
  };
  if (capFront) cap(0, false);
  if (capBack) cap(sections.length - 1, true);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// ────────────────────────────────────────────────────────────────────────────
//  Wheels
// ────────────────────────────────────────────────────────────────────────────
function makeTire(radius, width, matRubber) {
  // Lathe the sidewall profile so the shoulders are properly rounded.
  const pts = [];
  const inner = radius * 0.66;
  pts.push(new THREE.Vector2(inner, -width / 2));
  pts.push(new THREE.Vector2(radius * 0.90, -width / 2));
  pts.push(new THREE.Vector2(radius * 0.985, -width / 2 * 0.86));
  pts.push(new THREE.Vector2(radius, -width / 2 * 0.62));
  pts.push(new THREE.Vector2(radius, width / 2 * 0.62));
  pts.push(new THREE.Vector2(radius * 0.985, width / 2 * 0.86));
  pts.push(new THREE.Vector2(radius * 0.90, width / 2));
  pts.push(new THREE.Vector2(inner, width / 2));
  const g = new THREE.LatheGeometry(pts, 34);
  g.rotateZ(Math.PI / 2);
  const m = new THREE.Mesh(g, matRubber);
  m.castShadow = true;
  return m;
}

function makeRim(radius, width, spokes, matRim, matDark) {
  const g = new THREE.Group();
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width * 0.94, 28, 1, true), matRim);
  barrel.rotation.z = Math.PI / 2;
  g.add(barrel);

  const face = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.99, radius * 0.99, 0.02, 28), matDark);
  face.rotation.z = Math.PI / 2;
  face.position.x = width * 0.30;
  g.add(face);

  // Spokes: a thin arm from the hub to the rim, repeated around the axis.
  for (let i = 0; i < spokes; i++) {
    const pivot = new THREE.Group();
    const arm = new THREE.Mesh(new THREE.BoxGeometry(width * 0.40, radius * 0.86, 0.062), matRim);
    arm.position.set(width * 0.17, radius * 0.43, 0);
    pivot.add(arm);
    // A second, slimmer arm splits off to give the classic Y-spoke look.
    const arm2 = new THREE.Mesh(new THREE.BoxGeometry(width * 0.30, radius * 0.34, 0.05), matRim);
    arm2.position.set(width * 0.24, radius * 0.78, radius * 0.14);
    arm2.rotation.x = -0.34;
    pivot.add(arm2);
    const arm3 = arm2.clone();
    arm3.position.z = -radius * 0.14;
    arm3.rotation.x = 0.34;
    pivot.add(arm3);
    pivot.rotation.x = (i / spokes) * TAU;
    g.add(pivot);
  }

  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.24, radius * 0.26, width * 0.5, 16), matRim);
  hub.rotation.z = Math.PI / 2;
  hub.position.x = width * 0.12;
  g.add(hub);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.13, radius * 0.13, 0.03, 14), matDark);
  cap.rotation.z = Math.PI / 2;
  cap.position.x = width * 0.36;
  g.add(cap);

  // Lug bolts
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 6), matDark);
    b.rotation.z = Math.PI / 2;
    b.position.set(width * 0.35, Math.cos(a) * radius * 0.17, Math.sin(a) * radius * 0.17);
    g.add(b);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function makeBrake(radius, matDisc, matCaliper, matGlow) {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.72, radius * 0.72, 0.045, 24), matDisc);
  disc.rotation.z = Math.PI / 2;
  g.add(disc);
  const hat = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.32, radius * 0.32, 0.09, 16), matDisc);
  hat.rotation.z = Math.PI / 2;
  g.add(hat);
  const cal = new THREE.Mesh(new THREE.BoxGeometry(0.11, radius * 0.52, radius * 0.30), matCaliper);
  cal.position.set(0.03, radius * 0.42, 0);
  cal.rotation.x = 0.5;
  g.add(cal);
  // Hot-disc glow ring, driven by brake load at runtime.
  const glow = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.55, radius * 0.16, 4, 20), matGlow);
  glow.rotation.y = Math.PI / 2;
  glow.visible = true;
  g.add(glow);
  g.userData.glow = glow;
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// ────────────────────────────────────────────────────────────────────────────
//  Number plate
// ────────────────────────────────────────────────────────────────────────────
function makePlateTexture(text = 'HORIZON') {
  const W = 512, H = 128;
  const cv = canvas(W, H);
  const g = cv.getContext('2d');
  g.fillStyle = '#e8c93a';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#2a2410';
  g.lineWidth = 5;
  g.strokeRect(4, 4, W - 8, H - 8);
  // EU band
  g.fillStyle = '#0b3d91';
  g.fillRect(6, 6, 52, H - 12);
  g.fillStyle = '#ffd400';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    g.beginPath();
    g.arc(32 + Math.cos(a) * 16, H / 2 - 12 + Math.sin(a) * 16, 2.2, 0, TAU);
    g.fill();
  }
  g.fillStyle = '#ffffff';
  g.font = 'bold 22px Barlow, sans-serif';
  g.textAlign = 'center';
  g.fillText('GB', 32, H - 18);
  // Plate text
  g.fillStyle = '#14120a';
  g.font = 'bold 76px "Barlow Condensed", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, (W + 52) / 2, H / 2 + 4);
  return toTexture(cv, { wrap: THREE.ClampToEdgeWrapping });
}

// ════════════════════════════════════════════════════════════════════════════
//  CAR
// ════════════════════════════════════════════════════════════════════════════
export const CAR_PRESETS = [
  { id: 'apex-gt', name: 'APEX GT-R', color: 0x15181d, accent: 0x0f1114, rim: 0x1e2126, wing: 'big',  plate: 'HORIZON' },
  { id: 'vermilion', name: 'VERMILION', color: 0x9c1410, accent: 0x14100e, rim: 0x2a2c30, wing: 'big', plate: 'APEX 01' },
  { id: 'arctic', name: 'ARCTIC', color: 0xdfe4ea, accent: 0x16181c, rim: 0x141518, wing: 'duck', plate: 'FROST' },
  { id: 'midnight', name: 'MIDNIGHT', color: 0x101828, accent: 0x0a0d14, rim: 0x8e939a, wing: 'big', plate: 'NOCTIS' },
  { id: 'citrus', name: 'CITRUS', color: 0xd86a10, accent: 0x161412, rim: 0x1a1c20, wing: 'duck', plate: 'BLAZE' },
  { id: 'viridian', name: 'VIRIDIAN', color: 0x0f4a3a, accent: 0x0c1210, rim: 0xb0b6bc, wing: 'big', plate: 'JADE' },
  { id: 'plasma', name: 'PLASMA', color: 0x5a1a7a, accent: 0x120d18, rim: 0x2a2030, wing: 'big', plate: 'VOLT' },
  { id: 'steel', name: 'STEEL', color: 0x6a7078, accent: 0x14161a, rim: 0x24262a, wing: 'duck', plate: 'IRON' },
];

export class CarModel {
  /**
   * @param {object} preset  entry from CAR_PRESETS
   * @param {boolean} isPlayer  the player's car gets the higher-detail rims
   */
  constructor(preset = CAR_PRESETS[0], isPlayer = true) {
    this.preset = preset;
    this.isPlayer = isPlayer;
    this.group = new THREE.Group();
    this.group.name = `car:${preset.id}`;
    // The body is modelled nose-toward −Z (the way you'd draw a side view),
    // but the physics drives +Z as forward, so the chassis lives one level
    // down and is flipped once here.
    this.chassis = new THREE.Group();
    this.chassis.rotation.y = Math.PI;
    this.group.add(this.chassis);

    // ── Dimensions (metres) ───────────────────────────────────────────────
    this.dims = {
      length: 4.92, width: 2.06, height: 1.16,
      wheelbase: 2.78, track: 1.72,
      wheelR: 0.355, wheelW: 0.335, wheelRF: 0.345, wheelWF: 0.295,
    };

    this._materials = [];
    this._build();
  }

  _mat(m) { this._materials.push(m); return m; }

  _build() {
    const P = this.preset;
    const D = this.dims;
    const g = this.chassis;

    const paint = this._mat(makeCarPaint(P.color, { flake: this.isPlayer ? 0.6 : 0.35 }));
    const accent = this._mat(makeCarPaint(P.accent, { metalness: 0.4, roughness: 0.4, clearcoat: 0.5, flake: 0 }));
    const carbon = this._mat(makeCarbon(1));
    const glass = this._mat(makeGlass({ opacity: 0.58, roughness: 0.04 }));
    const chrome = this._mat(makeChrome(0xcfd4da, 0.12));
    const rimMat = this._mat(new THREE.MeshStandardMaterial({
      color: P.rim, metalness: 0.92, roughness: 0.24, envMapIntensity: 1.8,
    }));
    const rubber = this._mat(makeRubber(0x121316));
    const darkTrim = this._mat(new THREE.MeshStandardMaterial({ color: 0x0d0e11, roughness: 0.55, metalness: 0.2 }));
    const meshGrille = this._mat(new THREE.MeshStandardMaterial({ color: 0x0a0b0d, roughness: 0.75, metalness: 0.3 }));

    this.matHeadlight = this._mat(new THREE.MeshStandardMaterial({
      color: 0x0c0e12, emissive: 0xfff4e0, emissiveIntensity: 0.35, roughness: 0.12, metalness: 0.1,
    }));
    this.matTail = this._mat(new THREE.MeshStandardMaterial({
      color: 0x14060a, emissive: 0xff2418, emissiveIntensity: 1.0, roughness: 0.25,
    }));
    this.matBrakeGlow = this._mat(new THREE.MeshStandardMaterial({
      color: 0x120404, emissive: 0xff3a08, emissiveIntensity: 0.0, roughness: 0.6,
      transparent: true, opacity: 0.9,
    }));
    this.matReverse = this._mat(new THREE.MeshStandardMaterial({
      color: 0x101010, emissive: 0xffffff, emissiveIntensity: 0.0, roughness: 0.3,
    }));

    const hw = D.width / 2;

    // ── LOWER BODY ────────────────────────────────────────────────────────
    // Beltline height varies down the car; the greenhouse sits on top.
    const S = [
      { z: -2.46, hw: hw * 0.50, yb: 0.20, yt: 0.44, o: { tuck: 0.7, topW: 0.55, crown: 0.8, beltY: 0.55 } },
      { z: -2.34, hw: hw * 0.68, yb: 0.14, yt: 0.53, o: { tuck: 0.75, topW: 0.55, crown: 0.85, beltY: 0.5 } },
      { z: -2.10, hw: hw * 0.86, yb: 0.11, yt: 0.62, o: { tuck: 0.8, topW: 0.5, crown: 0.9, beltY: 0.5 } },
      { z: -1.80, hw: hw * 0.955, yb: 0.10, yt: 0.70, o: { tuck: 0.84, topW: 0.46, crown: 1.0, beltY: 0.55 } },
      { z: -1.45, hw: hw * 1.00, yb: 0.11, yt: 0.755, o: { tuck: 0.86, topW: 0.44, crown: 1.0, beltY: 0.6 } },
      { z: -1.10, hw: hw * 0.985, yb: 0.115, yt: 0.775, o: { tuck: 0.88, topW: 0.44, crown: 1.0, beltY: 0.62 } },
      { z: -0.70, hw: hw * 0.945, yb: 0.12, yt: 0.80, o: { tuck: 0.90, topW: 0.46, crown: 1.0, beltY: 0.64 } },
      { z: -0.25, hw: hw * 0.930, yb: 0.125, yt: 0.815, o: { tuck: 0.92, topW: 0.48, crown: 1.0, beltY: 0.66 } },
      { z: 0.20, hw: hw * 0.945, yb: 0.13, yt: 0.825, o: { tuck: 0.92, topW: 0.48, crown: 1.0, beltY: 0.66 } },
      { z: 0.62, hw: hw * 0.975, yb: 0.13, yt: 0.845, o: { tuck: 0.90, topW: 0.46, crown: 1.0, beltY: 0.64 } },
      { z: 1.05, hw: hw * 1.00, yb: 0.135, yt: 0.855, o: { tuck: 0.88, topW: 0.45, crown: 1.0, beltY: 0.62 } },
      { z: 1.50, hw: hw * 1.00, yb: 0.145, yt: 0.86, o: { tuck: 0.86, topW: 0.46, crown: 1.0, beltY: 0.6 } },
      { z: 1.92, hw: hw * 0.985, yb: 0.185, yt: 0.855, o: { tuck: 0.84, topW: 0.5, crown: 0.95, beltY: 0.58 } },
      { z: 2.24, hw: hw * 0.945, yb: 0.27, yt: 0.845, o: { tuck: 0.8, topW: 0.56, crown: 0.9, beltY: 0.56 } },
      { z: 2.44, hw: hw * 0.86, yb: 0.36, yt: 0.83, o: { tuck: 0.74, topW: 0.62, crown: 0.85, beltY: 0.54 } },
    ].map((s) => ({ z: s.z, pts: section(s.hw, s.yb, s.yt, s.o) }));

    const bodyGeo = loft(S, { uvScale: 0.4 });
    const body = new THREE.Mesh(bodyGeo, paint);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);
    this.bodyMesh = body;

    // ── GREENHOUSE (cabin glass) ──────────────────────────────────────────
    const G = [
      { z: -1.00, hw: hw * 0.60, yb: 0.74, yt: 0.80, o: { tuck: 1.0, topW: 0.9, crown: 0.6, beltY: 0.5 } },
      { z: -0.72, hw: hw * 0.76, yb: 0.77, yt: 0.96, o: { tuck: 1.0, topW: 0.82, crown: 0.7, beltY: 0.45 } },
      { z: -0.30, hw: hw * 0.83, yb: 0.79, yt: 1.115, o: { tuck: 1.0, topW: 0.72, crown: 0.8, beltY: 0.5 } },
      { z: 0.12, hw: hw * 0.845, yb: 0.80, yt: 1.16, o: { tuck: 1.0, topW: 0.70, crown: 0.85, beltY: 0.55 } },
      { z: 0.48, hw: hw * 0.835, yb: 0.81, yt: 1.15, o: { tuck: 1.0, topW: 0.70, crown: 0.85, beltY: 0.58 } },
      { z: 0.86, hw: hw * 0.80, yb: 0.83, yt: 1.05, o: { tuck: 1.0, topW: 0.76, crown: 0.8, beltY: 0.55 } },
      { z: 1.10, hw: hw * 0.74, yb: 0.845, yt: 0.90, o: { tuck: 1.0, topW: 0.86, crown: 0.7, beltY: 0.5 } },
    ].map((s) => ({ z: s.z, pts: section(s.hw, s.yb, s.yt, s.o) }));
    const glassGeo = loft(G, { uvScale: 0.4 });
    const cabin = new THREE.Mesh(glassGeo, glass);
    cabin.castShadow = false;
    cabin.renderOrder = 3;
    g.add(cabin);
    this.cabinMesh = cabin;

    // Roof panel + A-pillars in body colour so the glass reads as glazing.
    const R = [
      { z: -0.34, hw: hw * 0.62, yb: 1.04, yt: 1.12, o: { tuck: 1, topW: 0.9, crown: 0.6, beltY: 0.5 } },
      { z: 0.10, hw: hw * 0.70, yb: 1.09, yt: 1.175, o: { tuck: 1, topW: 0.9, crown: 0.6, beltY: 0.5 } },
      { z: 0.50, hw: hw * 0.695, yb: 1.08, yt: 1.165, o: { tuck: 1, topW: 0.9, crown: 0.6, beltY: 0.5 } },
      { z: 0.80, hw: hw * 0.66, yb: 1.00, yt: 1.09, o: { tuck: 1, topW: 0.9, crown: 0.6, beltY: 0.5 } },
    ].map((s) => ({ z: s.z, pts: section(s.hw, s.yb, s.yt, s.o) }));
    const roof = new THREE.Mesh(loft(R, { uvScale: 0.4 }), paint);
    roof.castShadow = true;
    g.add(roof);

    // A-pillars
    for (const s of [-1, 1]) {
      const pil = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.44, 0.10), accent);
      pil.position.set(s * hw * 0.70, 0.95, -0.52);
      pil.rotation.set(-0.62, s * 0.16, s * 0.10);
      pil.castShadow = true;
      g.add(pil);
      // B-pillar / flying buttress
      const but = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.30, 0.62), paint);
      but.position.set(s * hw * 0.76, 0.96, 0.80);
      but.rotation.set(0.30, 0, s * 0.06);
      but.castShadow = true;
      g.add(but);
    }

    // ── AERO: splitter, skirts, diffuser ──────────────────────────────────
    const splitter = new THREE.Mesh(new THREE.BoxGeometry(D.width * 0.99, 0.045, 0.62), carbon);
    splitter.position.set(0, 0.095, -2.16);
    splitter.castShadow = true;
    g.add(splitter);
    for (const s of [-1, 1]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.13, 0.42), carbon);
      fin.position.set(s * hw * 0.72, 0.16, -2.10);
      fin.rotation.y = s * 0.12;
      g.add(fin);
      const fin2 = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.10, 0.34), carbon);
      fin2.position.set(s * hw * 0.46, 0.15, -2.16);
      g.add(fin2);
    }

    for (const s of [-1, 1]) {
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 2.10), carbon);
      skirt.position.set(s * hw * 0.985, 0.115, 0.12);
      skirt.castShadow = true;
      g.add(skirt);
      // Side air blade
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.20, 0.85), carbon);
      blade.position.set(s * hw * 0.94, 0.42, 0.66);
      blade.rotation.y = s * 0.08;
      g.add(blade);
    }

    // Rear diffuser with vertical strakes
    const diff = new THREE.Mesh(new THREE.BoxGeometry(D.width * 0.90, 0.30, 0.72), carbon);
    diff.position.set(0, 0.26, 2.16);
    diff.rotation.x = -0.20;
    diff.castShadow = true;
    g.add(diff);
    for (let i = -3; i <= 3; i++) {
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.24, 0.70), carbon);
      st.position.set(i * hw * 0.24, 0.28, 2.16);
      st.rotation.x = -0.20;
      g.add(st);
    }

    // ── REAR WING ─────────────────────────────────────────────────────────
    const wingBig = this.preset.wing !== 'duck';
    if (wingBig) {
      const wingY = 1.06, wingZ = 2.02;
      const el = new THREE.Mesh(new THREE.BoxGeometry(D.width * 0.96, 0.055, 0.36), carbon);
      el.position.set(0, wingY, wingZ);
      el.rotation.x = -0.18;
      el.castShadow = true;
      g.add(el);
      const el2 = new THREE.Mesh(new THREE.BoxGeometry(D.width * 0.90, 0.035, 0.16), carbon);
      el2.position.set(0, wingY + 0.10, wingZ + 0.16);
      el2.rotation.x = -0.32;
      g.add(el2);
      // Swan-neck supports
      for (const s of [-1, 1]) {
        const sup = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.34, 0.10), carbon);
        sup.position.set(s * hw * 0.52, wingY - 0.17, wingZ - 0.06);
        sup.rotation.x = 0.16;
        sup.castShadow = true;
        g.add(sup);
      }
      // Endplates
      for (const s of [-1, 1]) {
        const ep = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.30, 0.62), carbon);
        ep.position.set(s * D.width * 0.485, wingY + 0.03, wingZ + 0.04);
        ep.castShadow = true;
        g.add(ep);
      }
    } else {
      const duck = new THREE.Mesh(new THREE.BoxGeometry(D.width * 0.86, 0.06, 0.30), carbon);
      duck.position.set(0, 0.90, 2.24);
      duck.rotation.x = -0.30;
      g.add(duck);
    }

    // Roof scoop / engine intake
    const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.62), accent);
    scoop.position.set(0, 1.13, 0.86);
    scoop.rotation.x = 0.12;
    scoop.castShadow = true;
    g.add(scoop);
    const scoopMouth = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.06), meshGrille);
    scoopMouth.position.set(0, 1.15, 0.56);
    g.add(scoopMouth);

    // Engine cover louvres
    for (let i = 0; i < 6; i++) {
      const lv = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.028, 0.11), accent);
      lv.position.set(0, 0.885 - i * 0.006, 1.06 + i * 0.145);
      lv.rotation.x = -0.42;
      g.add(lv);
    }

    // ── FRONT END: intakes, grille, headlights ────────────────────────────
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(D.width * 0.60, 0.20, 0.14), meshGrille);
    mouth.position.set(0, 0.33, -2.32);
    g.add(mouth);
    for (const s of [-1, 1]) {
      const duct = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.24, 0.14), meshGrille);
      duct.position.set(s * hw * 0.66, 0.36, -2.24);
      duct.rotation.y = s * 0.18;
      g.add(duct);
      // Canard
      const can = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.02, 0.12), carbon);
      can.position.set(s * hw * 0.82, 0.50, -2.16);
      can.rotation.set(0, s * 0.2, -s * 0.22);
      g.add(can);
    }

    // Y-shaped headlight signature
    this.headlights = [];
    for (const s of [-1, 1]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.085, 0.10), this.matHeadlight);
      hl.position.set(s * hw * 0.62, 0.615, -2.18);
      hl.rotation.set(0, s * 0.26, -s * 0.10);
      g.add(hl);
      this.headlights.push(hl);
      const hl2 = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.08), this.matHeadlight);
      hl2.position.set(s * hw * 0.74, 0.53, -2.12);
      hl2.rotation.set(0, s * 0.3, -s * 0.35);
      g.add(hl2);
      this.headlights.push(hl2);
      // Housing
      const hh = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.13, 0.06), darkTrim);
      hh.position.set(s * hw * 0.62, 0.61, -2.15);
      hh.rotation.set(0, s * 0.26, -s * 0.10);
      g.add(hh);
    }

    // ── REAR: full-width LED bar + hex clusters (the reference signature) ──
    const bar = new THREE.Mesh(new THREE.BoxGeometry(D.width * 0.86, 0.055, 0.05), this.matTail);
    bar.position.set(0, 0.735, 2.415);
    g.add(bar);
    this.tailBar = bar;
    const barHousing = new THREE.Mesh(new THREE.BoxGeometry(D.width * 0.90, 0.11, 0.04), darkTrim);
    barHousing.position.set(0, 0.735, 2.40);
    g.add(barHousing);

    this.tailLights = [bar];
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const t = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.048, 0.04), this.matTail);
        t.position.set(s * (hw * 0.34 + i * 0.15), 0.635, 2.405);
        t.rotation.z = s * 0.12;
        g.add(t);
        this.tailLights.push(t);
      }
    }
    // Reverse lights
    for (const s of [-1, 1]) {
      const rv = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.045, 0.035), this.matReverse);
      rv.position.set(s * hw * 0.52, 0.545, 2.40);
      g.add(rv);
    }

    // Rear grille mesh + exhausts
    const rgrille = new THREE.Mesh(new THREE.BoxGeometry(D.width * 0.62, 0.24, 0.06), meshGrille);
    rgrille.position.set(0, 0.50, 2.39);
    g.add(rgrille);
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.062, 0.14, 12), chrome);
        ex.rotation.x = Math.PI / 2;
        ex.position.set(s * (0.20 + i * 0.15), 0.375, 2.36);
        g.add(ex);
      }
    }
    this.exhaustPositions = [
      new THREE.Vector3(-0.28, 0.375, 2.44),
      new THREE.Vector3(0.28, 0.375, 2.44),
    ];

    // Number plate
    const plateTex = makePlateTexture(P.plate ?? 'HORIZON');
    this._plateTex = plateTex;
    const plateMat = this._mat(new THREE.MeshStandardMaterial({
      map: plateTex, roughness: 0.42, metalness: 0.0,
    }));
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.13), plateMat);
    plate.position.set(0, 0.615, 2.418);
    g.add(plate);

    // Mirrors
    for (const s of [-1, 1]) {
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.16, 6), accent);
      stalk.position.set(s * hw * 0.90, 0.86, -0.72);
      stalk.rotation.z = s * 0.9;
      g.add(stalk);
      const mir = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.075, 0.06), accent);
      mir.position.set(s * hw * 1.03, 0.895, -0.74);
      mir.rotation.y = s * 0.18;
      mir.castShadow = true;
      g.add(mir);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.055), chrome);
      face.position.set(s * hw * 1.045, 0.895, -0.71);
      face.rotation.y = Math.PI + s * 0.18;
      g.add(face);
    }

    // Windscreen wiper + shark fin antenna
    const wiper = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.012, 0.02), darkTrim);
    wiper.position.set(-0.15, 0.815, -0.86);
    wiper.rotation.z = 0.08;
    g.add(wiper);

    // ── WHEELS ────────────────────────────────────────────────────────────
    const discMat = this._mat(new THREE.MeshStandardMaterial({ color: 0x4a4d52, metalness: 0.85, roughness: 0.42 }));
    const calMat = this._mat(new THREE.MeshStandardMaterial({ color: 0xc8341c, metalness: 0.4, roughness: 0.42 }));

    this.wheels = [];
    const spokes = this.isPlayer ? 10 : 7;
    const wheelDefs = [
      { x: -1, z: -D.wheelbase / 2, front: true },
      { x: 1, z: -D.wheelbase / 2, front: true },
      { x: -1, z: D.wheelbase / 2, front: false },
      { x: 1, z: D.wheelbase / 2, front: false },
    ];
    for (const wd of wheelDefs) {
      const r = wd.front ? D.wheelRF : D.wheelR;
      const w = wd.front ? D.wheelWF : D.wheelW;
      const steer = new THREE.Group();          // steering pivot
      const spin = new THREE.Group();           // rolling pivot
      steer.add(spin);
      spin.add(makeTire(r, w, rubber));
      const rim = makeRim(r * 0.66, w * 0.92, spokes, rimMat, darkTrim);
      rim.scale.x = wd.x;
      spin.add(rim);
      const brake = makeBrake(r, discMat, calMat, this.matBrakeGlow);
      brake.scale.x = wd.x;
      steer.add(brake);

      steer.position.set(wd.x * (D.track / 2 + (wd.front ? 0.0 : 0.03)), r, wd.z);
      steer.userData.noMerge = true;   // steers and spins at runtime
      spin.userData.noMerge = true;
      g.add(steer);
      this.wheels.push({
        steer, spin, front: wd.front, side: wd.x, radius: r,
        restY: r, brake,
      });
    }

    // Wheel arch liners so you never see daylight through the bodywork.
    for (const wd of wheelDefs) {
      const r = wd.front ? D.wheelRF : D.wheelR;
      const arch = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 1.16, r * 1.16, 0.34, 14, 1, true, 0, Math.PI),
        darkTrim
      );
      arch.rotation.z = Math.PI / 2;
      arch.rotation.y = Math.PI;
      arch.position.set(wd.x * (D.track / 2 + 0.02), r, wd.z);
      g.add(arch);
    }

    // ── Under-car shadow catcher (grounds the car when shadows are cheap) ──
    const shadowTex = makeGlowSprite(0.05);
    this._shadowTex = shadowTex;
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(D.width * 1.45, D.length * 1.05),
      this._mat(new THREE.MeshBasicMaterial({
        map: shadowTex, transparent: true, opacity: 0.42, color: 0x000000,
        depthWrite: false, blending: THREE.NormalBlending,
      }))
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.02;
    blob.renderOrder = 1;
    blob.layers.set(LAYER.FX);
    blob.userData.noMerge = true;
    g.add(blob);
    this.shadowBlob = blob;

    g.traverse((o) => {
      if (o.isMesh && o !== cabin && o !== blob) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    // Transparent glass has to stay its own draw call so it sorts correctly.
    cabin.userData.noMerge = true;
    this.group.updateMatrixWorld(true);

    // ── Collapse the ~250 body pieces into one mesh per material ──────────
    mergeSubtree(g);
    for (const w of this.wheels) {
      // Tyre + rim collapse into the spinning pivot; the brake assembly
      // collapses into the steering pivot. `spin` stays flagged so the second
      // call leaves the rolling parts where they are.
      mergeSubtree(w.spin);
      mergeSubtree(w.steer);
    }
    this.group.updateMatrixWorld(true);
  }

  /**
   * Runtime light state.
   * Kept deliberately modest: the composite tonemaps ACES-style and anything
   * much over ~2.5 blooms into a white blob instead of reading as a red lamp.
   */
  setLights({ headlights = 0, brake = 0, reverse = 0, brakeHeat = 0 }) {
    this.matHeadlight.emissiveIntensity = 0.15 + headlights * 3.4;
    this.matTail.emissiveIntensity = 0.85 + brake * 2.4 + headlights * 0.45;
    this.matReverse.emissiveIntensity = reverse * 2.6;
    this.matBrakeGlow.emissiveIntensity = brakeHeat * 2.0;
    this.matBrakeGlow.opacity = clamp(brakeHeat, 0, 1) * 0.85;
  }

  dispose() {
    this.group.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); });
    this._materials.forEach((m) => m.dispose());
    this._plateTex?.dispose();
  }
}
