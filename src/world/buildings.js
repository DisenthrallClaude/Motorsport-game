import * as THREE from 'three';
import { makeFacade, makePavement, makeSignTexture } from '../render/textures.js';
import { makeSurface } from '../render/materials.js';
import { clamp, lerp, TAU } from '../core/math.js';

// ────────────────────────────────────────────────────────────────────────────
//  Geometry helpers — every wall carries world-scaled UVs so one tileable
//  facade texture serves buildings of any size.
// ────────────────────────────────────────────────────────────────────────────

/** Four walls with UVs in units of (bay, floor). Origin at the base centre. */
export function wallShell(w, h, d, bay = 3.4, floor = 3.5, opts = {}) {
  const { top = true, bottom = false, vOffset = 0, inset = 0 } = opts;
  const pos = [], uv = [], nor = [], idx = [];
  const hw = w / 2 - inset, hd = d / 2 - inset;
  let vi = 0;

  const quad = (a, b, c, dd, n, uw, uh) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, dd.x, dd.y, dd.z);
    uv.push(0, vOffset, uw, vOffset, uw, vOffset + uh, 0, vOffset + uh);
    for (let i = 0; i < 4; i++) nor.push(n.x, n.y, n.z);
    idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    vi += 4;
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const uwW = w / bay, uwD = d / bay, uh = h / floor;

  // +Z, -Z, +X, -X
  quad(V(-hw, 0, hd), V(hw, 0, hd), V(hw, h, hd), V(-hw, h, hd), V(0, 0, 1), uwW, uh);
  quad(V(hw, 0, -hd), V(-hw, 0, -hd), V(-hw, h, -hd), V(hw, h, -hd), V(0, 0, -1), uwW, uh);
  quad(V(hw, 0, hd), V(hw, 0, -hd), V(hw, h, -hd), V(hw, h, hd), V(1, 0, 0), uwD, uh);
  quad(V(-hw, 0, -hd), V(-hw, 0, hd), V(-hw, h, hd), V(-hw, h, -hd), V(-1, 0, 0), uwD, uh);

  if (top) quad(V(-hw, h, -hd), V(hw, h, -hd), V(hw, h, hd), V(-hw, h, hd), V(0, 1, 0), uwW, uwD);
  if (bottom) quad(V(-hw, 0, hd), V(hw, 0, hd), V(hw, 0, -hd), V(-hw, 0, -hd), V(0, -1, 0), uwW, uwD);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/** A simple box with UVs scaled by size — for cornices, plinths, trim. */
export function trimBox(w, h, d, uvScale = 0.35) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * w * uvScale, uv.getY(i) * h * uvScale);
  }
  return g;
}

/** Truncated pyramid — mansard roofs, tapering towers, spire bases. */
export function frustum(wBot, dBot, wTop, dTop, h, uvScale = 0.3) {
  const pos = [], uv = [], idx = [];
  const b = [[-wBot / 2, 0, dBot / 2], [wBot / 2, 0, dBot / 2], [wBot / 2, 0, -dBot / 2], [-wBot / 2, 0, -dBot / 2]];
  const t = [[-wTop / 2, h, dTop / 2], [wTop / 2, h, dTop / 2], [wTop / 2, h, -dTop / 2], [-wTop / 2, h, -dTop / 2]];
  let vi = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const p = [b[i], b[j], t[j], t[i]];
    for (const v of p) pos.push(v[0], v[1], v[2]);
    const wide = Math.hypot(b[j][0] - b[i][0], b[j][2] - b[i][2]);
    uv.push(0, 0, wide * uvScale, 0, wide * uvScale, h * uvScale, 0, h * uvScale);
    idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    vi += 4;
  }
  // cap
  for (const v of t) pos.push(v[0], v[1], v[2]);
  uv.push(0, 0, wTop * uvScale, 0, wTop * uvScale, dTop * uvScale, 0, dTop * uvScale);
  idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Pitched (gable) roof. */
export function gableRoof(w, d, h, overhang = 0.3) {
  const W = w / 2 + overhang, D = d / 2 + overhang;
  const pos = [
    -W, 0, D, W, 0, D, W, h, 0, -W, h, 0,
    W, 0, -D, -W, 0, -D, -W, h, 0, W, h, 0,
  ];
  const uv = [0, 0, w * 0.3, 0, w * 0.3, h * 0.3, 0, h * 0.3, 0, 0, w * 0.3, 0, w * 0.3, h * 0.3, 0, h * 0.3];
  const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  // gable ends
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ────────────────────────────────────────────────────────────────────────────
//  BuildingKit — owns the shared materials for one city theme
// ────────────────────────────────────────────────────────────────────────────
export class BuildingKit {
  constructor(theme, rng) {
    this.theme = theme;
    this.rng = rng;
    this.mats = {};
    this._build();
  }

  _build() {
    const t = this.theme;
    const B = t.buildings || {};
    const night = t.night ? (B.litRatio ?? 0.55) : 0;

    this.facades = (B.facades || []).map((f, i) => {
      const tex = makeFacade({
        size: 512,
        seed: 100 + i * 7 + (B.seed ?? 0),
        bays: f.bays ?? 4,
        style: f.style ?? 'stone',
        wallColor: f.wall,
        trimColor: f.trim ?? 0xcfc8bc,
        glassColor: f.glass ?? 0x1a2028,
        litRatio: f.lit ?? night,
        litColor: f.litColor ?? 0xffd39a,
        windowH: f.windowH ?? 0.56,
        windowW: f.windowW ?? 0.44,
        arched: !!f.arched,
        balcony: !!f.balcony,
        grime: f.grime ?? 0.5,
      });
      const m = makeSurface(tex, {
        roughness: f.roughness ?? 0.82,
        metalness: f.metalness ?? 0.0,
        envMapIntensity: f.env ?? 0.55,
        normalScale: f.normalScale ?? 1.0,
      });
      m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping;
      m.map.repeat.set(1, 1);
      if (m.normalMap) { m.normalMap.wrapS = m.normalMap.wrapT = THREE.RepeatWrapping; m.normalMap.repeat.set(1, 1); }
      if (m.roughnessMap) { m.roughnessMap.wrapS = m.roughnessMap.wrapT = THREE.RepeatWrapping; m.roughnessMap.repeat.set(1, 1); }
      if (m.emissiveMap) {
        m.emissiveMap.wrapS = m.emissiveMap.wrapT = THREE.RepeatWrapping;
        m.emissiveMap.repeat.set(1, 1);
        m.emissiveIntensity = f.emissive ?? 1.4;
      }
      m.userData.bay = f.bayWidth ?? 3.4;
      m.userData.floor = f.floorHeight ?? 3.6;
      m.userData.weight = f.weight ?? 1;
      return m;
    });

    // Shared trim / roof / detail materials.
    const mk = (color, rough, metal, env) => new THREE.MeshStandardMaterial({
      color, roughness: rough, metalness: metal ?? 0, envMapIntensity: env ?? 0.55, dithering: true,
    });
    this.mats.trim = mk(B.trimColor ?? 0xbdb5a7, 0.78);
    this.mats.stone = mk(B.stoneColor ?? 0xa39a8c, 0.85);
    this.mats.dark = mk(B.darkColor ?? 0x2a2a2e, 0.7);
    this.mats.roof = mk(B.roofColor ?? 0x3b3d42, 0.72, 0.15, 0.7);
    this.mats.metal = mk(B.metalColor ?? 0x6e737a, 0.42, 0.85, 1.1);
    this.mats.iron = mk(0x1b1c20, 0.55, 0.6, 0.8);
    this.mats.glassDark = new THREE.MeshStandardMaterial({
      color: B.glassColor ?? 0x121820, roughness: 0.08, metalness: 0.55,
      envMapIntensity: 2.0, dithering: true,
    });
    this.mats.shopGlass = new THREE.MeshStandardMaterial({
      color: 0x0d1218, roughness: 0.06, metalness: 0.3, envMapIntensity: 2.4,
    });
    this.mats.awning = mk(B.awningColor ?? 0x7a2230, 0.85);
    this.mats.copper = mk(0x4f7f6d, 0.62, 0.4, 0.9);
    this.mats.gold = new THREE.MeshStandardMaterial({ color: 0xd8a441, roughness: 0.28, metalness: 1.0, envMapIntensity: 1.8 });
    this.mats.red = mk(B.accentColor ?? 0x9c2a24, 0.72);
    this.mats.emissiveWarm = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a, emissive: 0xffc98a, emissiveIntensity: 2.2, roughness: 0.4,
    });
    this.mats.emissiveCool = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a, emissive: 0x9fd8ff, emissiveIntensity: 2.0, roughness: 0.4,
    });
  }

  pickFacade(rng) {
    if (!this.facades.length) return null;
    const total = this.facades.reduce((a, m) => a + m.userData.weight, 0);
    let r = rng() * total;
    for (const m of this.facades) {
      r -= m.userData.weight;
      if (r <= 0) return m;
    }
    return this.facades[0];
  }

  dispose() {
    for (const m of this.facades) m.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  Building generators — each returns a THREE.Group for the batcher
// ────────────────────────────────────────────────────────────────────────────
export function makeBuilding(kit, rng, spec) {
  const style = spec.style || 'block';
  switch (style) {
    case 'victorian': return victorian(kit, rng, spec);
    case 'haussmann': return haussmann(kit, rng, spec);
    case 'gothic': return gothicWing(kit, rng, spec);
    case 'glassTower': return glassTower(kit, rng, spec);
    case 'tokyoMid': return tokyoMid(kit, rng, spec);
    case 'brownstone': return brownstone(kit, rng, spec);
    case 'chineseMod': return chineseModern(kit, rng, spec);
    case 'chineseTrad': return chineseTraditional(kit, rng, spec);
    case 'desertTower': return desertTower(kit, rng, spec);
    default: return simpleBlock(kit, rng, spec);
  }
}

function mesh(geo, mat, x = 0, y = 0, z = 0, ry = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.y = ry;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Ground-floor retail: recessed dark glazing, stall riser, fascia, awning. */
function shopfront(kit, rng, w, d, h, opts = {}) {
  const g = new THREE.Group();
  const { awning = 0.35, sign = null, fasciaColor = null } = opts;
  // Pillars at the corners
  const pw = Math.min(0.55, w * 0.09);
  g.add(mesh(trimBox(pw, h, d * 0.06), kit.mats.trim, -w / 2 + pw / 2, h / 2, d / 2 - d * 0.03));
  g.add(mesh(trimBox(pw, h, d * 0.06), kit.mats.trim, w / 2 - pw / 2, h / 2, d / 2 - d * 0.03));
  // Glazing (inset)
  const gw = w - pw * 2;
  g.add(mesh(trimBox(gw, h * 0.74, 0.08), kit.mats.shopGlass, 0, h * 0.44, d / 2 - 0.22));
  // Stall riser
  g.add(mesh(trimBox(gw, h * 0.14, 0.16), kit.mats.dark, 0, h * 0.07, d / 2 - 0.14));
  // Fascia board
  const fascia = fasciaColor ? new THREE.MeshStandardMaterial({ color: fasciaColor, roughness: 0.7 }) : kit.mats.dark;
  g.add(mesh(trimBox(w, h * 0.16, 0.24), fascia, 0, h - h * 0.08, d / 2 - 0.05));
  if (sign) {
    const sm = new THREE.MeshStandardMaterial({
      map: sign, transparent: false, roughness: 0.55,
      emissive: 0xffffff, emissiveMap: sign, emissiveIntensity: kit.theme.night ? 1.6 : 0.12,
    });
    const sg = new THREE.PlaneGeometry(w * 0.82, h * 0.12);
    g.add(mesh(sg, sm, 0, h - h * 0.08, d / 2 + 0.09));
  }
  if (awning > 0 && rng() < awning) {
    const aw = new THREE.Mesh(frustum(w * 0.92, 0.1, w * 0.92, 1.5, 0.55, 0.5), kit.mats.awning);
    aw.position.set(0, h * 0.72, d / 2 + 0.75);
    aw.rotation.x = -0.42;
    aw.castShadow = true;
    g.add(aw);
  }
  return g;
}

/** Parapet + cornice + roof clutter shared by most styles. */
function roofDressing(kit, rng, w, d, y, opts = {}) {
  const g = new THREE.Group();
  const { parapet = 0.85, chimneys = 0, ac = 0, tanks = 0, aerials = 0, railing = false } = opts;
  if (parapet > 0) {
    const t = 0.28;
    g.add(mesh(trimBox(w, parapet, t), kit.mats.trim, 0, y + parapet / 2, d / 2 - t / 2));
    g.add(mesh(trimBox(w, parapet, t), kit.mats.trim, 0, y + parapet / 2, -d / 2 + t / 2));
    g.add(mesh(trimBox(t, parapet, d), kit.mats.trim, w / 2 - t / 2, y + parapet / 2, 0));
    g.add(mesh(trimBox(t, parapet, d), kit.mats.trim, -w / 2 + t / 2, y + parapet / 2, 0));
  }
  for (let i = 0; i < chimneys; i++) {
    const cw = 0.8 + rng() * 0.8, ch = 1.6 + rng() * 1.8;
    const cx = (rng() - 0.5) * (w - cw - 1);
    const cz = (rng() - 0.5) * (d - 1.4);
    g.add(mesh(trimBox(cw, ch, 1.0), kit.mats.stone, cx, y + ch / 2, cz));
    // Pots
    const pots = 2 + ((rng() * 3) | 0);
    for (let p = 0; p < pots; p++) {
      const pg = new THREE.CylinderGeometry(0.11, 0.13, 0.42, 8);
      g.add(mesh(pg, kit.mats.red, cx - cw / 2 + 0.18 + (p * (cw - 0.36)) / Math.max(1, pots - 1), y + ch + 0.21, cz));
    }
  }
  for (let i = 0; i < ac; i++) {
    const aw = 0.9 + rng() * 0.7;
    g.add(mesh(trimBox(aw, 0.55 + rng() * 0.4, aw * 0.8), kit.mats.metal,
      (rng() - 0.5) * (w - 2), y + 0.35, (rng() - 0.5) * (d - 2)));
  }
  for (let i = 0; i < tanks; i++) {
    const r = 0.7 + rng() * 0.5, hh = 1.6 + rng() * 1.2;
    const tg = new THREE.CylinderGeometry(r, r, hh, 12);
    const px = (rng() - 0.5) * (w - 3), pz = (rng() - 0.5) * (d - 3);
    g.add(mesh(tg, kit.mats.metal, px, y + hh / 2 + 1.0, pz));
    for (const s of [-1, 1]) for (const s2 of [-1, 1]) {
      g.add(mesh(trimBox(0.12, 1.0, 0.12), kit.mats.iron, px + s * r * 0.7, y + 0.5, pz + s2 * r * 0.7));
    }
  }
  for (let i = 0; i < aerials; i++) {
    const hh = 2 + rng() * 4;
    g.add(mesh(new THREE.CylinderGeometry(0.045, 0.06, hh, 5), kit.mats.iron,
      (rng() - 0.5) * (w - 1), y + hh / 2, (rng() - 0.5) * (d - 1)));
  }
  if (railing) {
    const rg = trimBox(w, 0.06, 0.06);
    g.add(mesh(rg, kit.mats.iron, 0, y + 1.0, d / 2 - 0.1));
    for (let x = -w / 2 + 0.4; x < w / 2; x += 0.9) {
      g.add(mesh(trimBox(0.05, 1.0, 0.05), kit.mats.iron, x, y + 0.5, d / 2 - 0.1));
    }
  }
  return g;
}

// ── LONDON: Victorian / Portland-stone commercial ──────────────────────────
function victorian(kit, rng, spec) {
  const g = new THREE.Group();
  const { w, d, h } = spec;
  const facade = spec.facade || kit.pickFacade(rng);
  const bay = facade.userData.bay, floorH = facade.userData.floor;
  const groundH = 4.2;
  const bodyH = Math.max(floorH * 2, h - groundH);
  const floors = Math.max(2, Math.round(bodyH / floorH));

  g.add(shopfront(kit, rng, w, d, groundH, {
    awning: spec.awning ?? 0.3,
    sign: spec.sign,
    fasciaColor: spec.fasciaColor,
  }));
  // Plinth band above the shopfront
  g.add(mesh(trimBox(w + 0.3, 0.4, d + 0.3), kit.mats.trim, 0, groundH + 0.2, 0));

  const body = new THREE.Mesh(wallShell(w, floors * floorH, d, bay, floorH), facade);
  body.position.y = groundH + 0.4;
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);

  const topY = groundH + 0.4 + floors * floorH;
  // Heavy cornice
  g.add(mesh(trimBox(w + 0.75, 0.5, d + 0.75), kit.mats.trim, 0, topY + 0.25, 0));
  g.add(mesh(trimBox(w + 0.45, 0.3, d + 0.45), kit.mats.trim, 0, topY + 0.62, 0));

  // Mansard attic storey on about half of them
  if (rng() < 0.55) {
    const mh = 2.6;
    const roofM = new THREE.Mesh(frustum(w + 0.2, d + 0.2, w - 2.2, d - 2.2, mh, 0.4), kit.mats.roof);
    roofM.position.y = topY + 0.78;
    roofM.castShadow = true; roofM.receiveShadow = true;
    g.add(roofM);
    // Dormer windows
    const dormers = Math.max(1, Math.floor(w / 3.4));
    for (let i = 0; i < dormers; i++) {
      const x = -w / 2 + (w / dormers) * (i + 0.5);
      const dz = d / 2 - 0.9;
      g.add(mesh(trimBox(1.15, 1.35, 0.9), kit.mats.roof, x, topY + 1.5, dz));
      g.add(mesh(trimBox(0.85, 0.95, 0.06), kit.mats.glassDark, x, topY + 1.5, dz + 0.47));
    }
    g.add(roofDressing(kit, rng, w - 2.2, d - 2.2, topY + 0.78 + mh, {
      parapet: 0, chimneys: 1 + ((rng() * 2) | 0),
    }));
  } else {
    g.add(roofDressing(kit, rng, w, d, topY + 0.78, {
      parapet: 0.9, chimneys: 1 + ((rng() * 3) | 0), ac: rng() < 0.3 ? 2 : 0,
    }));
  }
  return g;
}

// ── PARIS: Haussmann apartment block ───────────────────────────────────────
function haussmann(kit, rng, spec) {
  const g = new THREE.Group();
  const { w, d, h } = spec;
  const facade = spec.facade || kit.pickFacade(rng);
  const bay = facade.userData.bay, floorH = facade.userData.floor;
  const groundH = 4.6;
  const floors = clamp(Math.round((h - groundH - 3.2) / floorH), 4, 6);

  g.add(shopfront(kit, rng, w, d, groundH, { awning: 0.45, sign: spec.sign, fasciaColor: spec.fasciaColor }));
  g.add(mesh(trimBox(w + 0.35, 0.45, d + 0.35), kit.mats.trim, 0, groundH + 0.22, 0));

  const bodyH = floors * floorH;
  const body = new THREE.Mesh(wallShell(w, bodyH, d, bay, floorH), facade);
  body.position.y = groundH + 0.45;
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);

  // Continuous wrought-iron balconies on the 2nd and 5th floors (the rule).
  for (const f of [1, Math.min(floors - 1, 4)]) {
    const by = groundH + 0.45 + f * floorH + 0.1;
    g.add(mesh(trimBox(w + 0.5, 0.14, 0.5), kit.mats.trim, 0, by, d / 2 + 0.2));
    g.add(mesh(trimBox(w + 0.4, 0.08, 0.08), kit.mats.iron, 0, by + 0.92, d / 2 + 0.42));
    const bars = Math.floor(w / 0.22);
    for (let i = 0; i <= bars; i++) {
      const x = -w / 2 + (w / bars) * i;
      g.add(mesh(trimBox(0.035, 0.92, 0.035), kit.mats.iron, x, by + 0.46, d / 2 + 0.42));
    }
  }

  const topY = groundH + 0.45 + bodyH;
  g.add(mesh(trimBox(w + 0.9, 0.55, d + 0.9), kit.mats.trim, 0, topY + 0.28, 0));

  // Steep zinc mansard with dormers — the Paris skyline signature.
  const mh = 3.4;
  const roofM = new THREE.Mesh(frustum(w + 0.3, d + 0.3, w - 3.4, d - 3.4, mh, 0.35), kit.mats.roof);
  roofM.position.y = topY + 0.56;
  roofM.castShadow = true; roofM.receiveShadow = true;
  g.add(roofM);
  const dormers = Math.max(2, Math.floor(w / 3.0));
  for (let i = 0; i < dormers; i++) {
    const x = -w / 2 + (w / dormers) * (i + 0.5);
    const dz = d / 2 - 0.75;
    g.add(mesh(trimBox(1.05, 1.6, 1.1), kit.mats.roof, x, topY + 1.5, dz));
    g.add(mesh(trimBox(0.78, 1.15, 0.06), kit.mats.glassDark, x, topY + 1.5, dz + 0.57));
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 1.1, 10, 1, false, 0, Math.PI), kit.mats.roof);
    cap.rotation.set(Math.PI / 2, 0, 0);
    cap.position.set(x, topY + 2.3, dz);
    g.add(cap);
  }
  g.add(roofDressing(kit, rng, w - 3.4, d - 3.4, topY + 0.56 + mh, {
    parapet: 0, chimneys: 2 + ((rng() * 2) | 0),
  }));
  return g;
}

// ── WESTMINSTER: gothic revival wing with pinnacles ────────────────────────
function gothicWing(kit, rng, spec) {
  const g = new THREE.Group();
  const { w, d, h } = spec;
  const facade = spec.facade || kit.pickFacade(rng);
  const bay = facade.userData.bay, floorH = facade.userData.floor;

  const body = new THREE.Mesh(wallShell(w, h, d, bay, floorH), facade);
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);

  // Buttress piers between the bays.
  const piers = Math.max(2, Math.round(w / bay));
  for (let i = 0; i <= piers; i++) {
    const x = -w / 2 + (w / piers) * i;
    g.add(mesh(trimBox(0.75, h, 0.6), kit.mats.stone, x, h / 2, d / 2 + 0.2));
    // Pinnacle on top of each pier
    const ph = 2.4 + rng() * 1.2;
    g.add(mesh(frustum(0.8, 0.8, 0.45, 0.45, ph * 0.45, 0.4), kit.mats.stone, x, h, d / 2 + 0.2));
    const spire = new THREE.Mesh(new THREE.ConeGeometry(0.34, ph * 0.75, 4), kit.mats.stone);
    spire.position.set(x, h + ph * 0.45 + ph * 0.37, d / 2 + 0.2);
    spire.rotation.y = Math.PI / 4;
    spire.castShadow = true;
    g.add(spire);
  }
  // Crenellated parapet
  const merlons = Math.floor(w / 1.1);
  for (let i = 0; i < merlons; i++) {
    const x = -w / 2 + (w / merlons) * (i + 0.5);
    if (i % 2 === 0) g.add(mesh(trimBox(w / merlons * 0.8, 0.75, 0.5), kit.mats.stone, x, h + 0.38, d / 2 - 0.05));
  }
  g.add(mesh(trimBox(w + 0.4, 0.35, d + 0.4), kit.mats.stone, 0, h + 0.17, 0));

  // Steep slate roof behind the parapet
  const roof = new THREE.Mesh(frustum(w - 1.2, d - 1.2, w * 0.15, d * 0.4, h * 0.16 + 2.5, 0.3), kit.mats.roof);
  roof.position.y = h + 0.35;
  roof.castShadow = true;
  g.add(roof);
  return g;
}

// ── Modern curtain-wall tower ──────────────────────────────────────────────
function glassTower(kit, rng, spec) {
  const g = new THREE.Group();
  const { w, d, h } = spec;
  const facade = spec.facade || kit.pickFacade(rng);
  const bay = facade.userData.bay, floorH = facade.userData.floor;

  const tiers = 1 + ((rng() * 2.4) | 0);
  let y = 0, cw = w, cd = d;
  for (let i = 0; i < tiers; i++) {
    const th = i === tiers - 1 ? h - y : (h / tiers) * (0.6 + rng() * 0.7);
    if (th <= 1) break;
    const body = new THREE.Mesh(wallShell(cw, th, cd, bay, floorH), facade);
    body.position.y = y;
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    // Slab edge between tiers reads as a real floor plate.
    g.add(mesh(trimBox(cw + 0.35, 0.35, cd + 0.35), kit.mats.metal, 0, y + th, 0));
    y += th;
    cw *= 0.78 + rng() * 0.12;
    cd *= 0.78 + rng() * 0.12;
  }
  g.add(roofDressing(kit, rng, cw, cd, y, {
    parapet: 1.1, ac: 2 + ((rng() * 3) | 0), tanks: rng() < 0.4 ? 1 : 0, aerials: 1 + ((rng() * 2) | 0),
  }));
  // Crown lighting strip
  const crown = new THREE.Mesh(trimBox(cw + 0.3, 0.22, cd + 0.3), kit.mats.emissiveCool);
  crown.position.y = y + 1.2;
  g.add(crown);
  return g;
}

// ── TOKYO: dense mid-rise with vertical signage ────────────────────────────
function tokyoMid(kit, rng, spec) {
  const g = new THREE.Group();
  const { w, d, h } = spec;
  const facade = spec.facade || kit.pickFacade(rng);
  const bay = facade.userData.bay, floorH = facade.userData.floor;
  const groundH = 4.0;

  g.add(shopfront(kit, rng, w, d, groundH, { awning: 0.2, sign: spec.sign }));
  const bodyH = Math.max(floorH * 2, h - groundH);
  const body = new THREE.Mesh(wallShell(w, bodyH, d, bay, floorH), facade);
  body.position.y = groundH;
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);

  // Exterior stair + walkway, ubiquitous on Tokyo mid-rises.
  if (rng() < 0.5) {
    const sx = (rng() < 0.5 ? -1 : 1) * (w / 2 - 0.6);
    for (let f = 1; f * floorH < bodyH; f++) {
      const y = groundH + f * floorH;
      g.add(mesh(trimBox(1.5, 0.12, d * 0.8), kit.mats.metal, sx, y, 0));
      g.add(mesh(trimBox(0.06, 1.0, d * 0.8), kit.mats.iron, sx + 0.7, y + 0.5, 0));
    }
  }
  // Vertical sign tower on the street corner.
  if (spec.verticalSigns && spec.verticalSigns.length) {
    const count = Math.min(spec.verticalSigns.length, Math.max(1, Math.floor(bodyH / 4.2)));
    for (let i = 0; i < count; i++) {
      const tex = spec.verticalSigns[i];
      const sh = 3.4, sw = 1.15;
      const sm = new THREE.MeshStandardMaterial({
        map: tex, emissive: 0xffffff, emissiveMap: tex,
        emissiveIntensity: kit.theme.night ? 3.4 : 0.5, roughness: 0.5, side: THREE.DoubleSide,
      });
      const side = spec.signSide ?? 1;
      const box = new THREE.Mesh(trimBox(0.28, sh, sw), kit.mats.dark);
      const y = groundH + 1.4 + i * (sh + 0.4);
      box.position.set(side * (w / 2 + 0.2), y, d / 2 - 1.0);
      g.add(box);
      const face1 = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), sm);
      face1.position.set(side * (w / 2 + 0.36), y, d / 2 - 1.0);
      face1.rotation.y = side * Math.PI / 2;
      g.add(face1);
      const face2 = face1.clone();
      face2.position.x = side * (w / 2 + 0.04);
      face2.rotation.y = -side * Math.PI / 2;
      g.add(face2);
    }
  }
  g.add(roofDressing(kit, rng, w, d, groundH + bodyH, {
    parapet: 0.9, ac: 2 + ((rng() * 4) | 0), tanks: rng() < 0.55 ? 1 : 0, aerials: 1 + ((rng() * 3) | 0),
  }));
  return g;
}

// ── NEW YORK: brownstone with stoop + fire escape ──────────────────────────
function brownstone(kit, rng, spec) {
  const g = new THREE.Group();
  const { w, d, h } = spec;
  const facade = spec.facade || kit.pickFacade(rng);
  const bay = facade.userData.bay, floorH = facade.userData.floor;
  const floors = clamp(Math.round(h / floorH), 3, 6);
  const bodyH = floors * floorH;

  const body = new THREE.Mesh(wallShell(w, bodyH, d, bay, floorH), facade);
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);

  // Stoop
  const steps = 7;
  for (let i = 0; i < steps; i++) {
    g.add(mesh(trimBox(2.4, 0.2, 0.34), kit.mats.stone,
      -w / 4, 0.1 + i * 0.2, d / 2 + 1.4 - i * 0.34));
  }
  for (const s of [-1, 1]) {
    g.add(mesh(trimBox(0.22, 1.3, 2.4), kit.mats.iron, -w / 4 + s * 1.3, 1.4, d / 2 + 0.6));
  }
  // Fire escape zig-zag
  for (let f = 1; f < floors; f++) {
    const y = f * floorH;
    g.add(mesh(trimBox(w * 0.5, 0.08, 1.3), kit.mats.iron, w * 0.15, y, d / 2 + 0.65));
    g.add(mesh(trimBox(w * 0.5, 0.9, 0.06), kit.mats.iron, w * 0.15, y + 0.45, d / 2 + 1.28));
    const lad = new THREE.Mesh(trimBox(0.5, floorH * 1.15, 0.06), kit.mats.iron);
    lad.position.set(w * 0.15 + (f % 2 ? 1 : -1) * w * 0.16, y + floorH / 2, d / 2 + 1.0);
    lad.rotation.x = 0.32;
    g.add(lad);
  }
  g.add(mesh(trimBox(w + 0.6, 0.45, d + 0.6), kit.mats.trim, 0, bodyH + 0.22, 0));
  g.add(roofDressing(kit, rng, w, d, bodyH + 0.45, {
    parapet: 0.8, tanks: rng() < 0.5 ? 1 : 0, ac: 1 + ((rng() * 2) | 0), aerials: rng() < 0.5 ? 1 : 0,
  }));
  return g;
}

// ── BEIJING: modern stone-and-glass block with red accents ─────────────────
function chineseModern(kit, rng, spec) {
  const g = new THREE.Group();
  const { w, d, h } = spec;
  const facade = spec.facade || kit.pickFacade(rng);
  const bay = facade.userData.bay, floorH = facade.userData.floor;
  const groundH = 5.0;

  g.add(mesh(trimBox(w + 0.4, groundH, d + 0.4), kit.mats.stone, 0, groundH / 2, 0));
  g.add(mesh(trimBox(w * 0.7, groundH * 0.7, 0.2), kit.mats.shopGlass, 0, groundH * 0.42, d / 2 + 0.24));

  const bodyH = Math.max(floorH * 3, h - groundH);
  const body = new THREE.Mesh(wallShell(w, bodyH, d, bay, floorH), facade);
  body.position.y = groundH;
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);

  // Deep horizontal shading fins.
  const floors = Math.round(bodyH / floorH);
  for (let f = 1; f < floors; f++) {
    g.add(mesh(trimBox(w + 0.5, 0.16, d + 0.5), kit.mats.trim, 0, groundH + f * floorH, 0));
  }
  const topY = groundH + bodyH;
  g.add(mesh(trimBox(w + 0.8, 0.6, d + 0.8), kit.mats.stone, 0, topY + 0.3, 0));
  // A clipped, tiled eave nodding to traditional roofs.
  const eave = new THREE.Mesh(frustum(w + 1.4, d + 1.4, w * 0.55, d * 0.55, 1.9, 0.4), kit.mats.red);
  eave.position.y = topY + 0.6;
  eave.castShadow = true;
  g.add(eave);
  g.add(roofDressing(kit, rng, w * 0.55, d * 0.55, topY + 2.5, { parapet: 0.5, ac: 2, aerials: 1 }));
  return g;
}

// ── BEIJING: traditional hall / gate with upturned eaves ───────────────────
function chineseTraditional(kit, rng, spec) {
  const g = new THREE.Group();
  const { w, d, h } = spec;
  const plinthH = Math.max(1.2, h * 0.14);
  g.add(mesh(trimBox(w + 2.0, plinthH, d + 2.0), kit.mats.stone, 0, plinthH / 2, 0));

  const wallH = h - plinthH - 2.2;
  g.add(mesh(trimBox(w, wallH, d), kit.mats.red, 0, plinthH + wallH / 2, 0));

  // Columns along the front
  const cols = Math.max(4, Math.round(w / 3.2));
  for (let i = 0; i <= cols; i++) {
    const x = -w / 2 + (w / cols) * i;
    const cg = new THREE.CylinderGeometry(0.34, 0.38, wallH, 10);
    g.add(mesh(cg, kit.mats.red, x, plinthH + wallH / 2, d / 2 + 0.5));
  }
  // Bracket set (dougong) band
  g.add(mesh(trimBox(w + 1.6, 0.75, d + 1.6), kit.mats.gold, 0, plinthH + wallH + 0.37, 0));

  // Double-eave roof: two stacked, flared slabs.
  const eaveY = plinthH + wallH + 0.75;
  const roofMat = kit.mats.roof;
  const lower = new THREE.Mesh(frustum(w + 4.2, d + 4.2, w * 0.62, d * 0.62, 2.2, 0.3), roofMat);
  lower.position.y = eaveY;
  lower.castShadow = true; lower.receiveShadow = true;
  g.add(lower);
  // Upturned corner tips
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.5, 4), roofMat);
    tip.position.set(sx * (w / 2 + 2.1), eaveY + 0.5, sz * (d / 2 + 2.1));
    tip.rotation.set(sx * 0.42, Math.PI / 4, sz * 0.42);
    tip.castShadow = true;
    g.add(tip);
  }
  const upperBase = eaveY + 2.2;
  g.add(mesh(trimBox(w * 0.66, 1.6, d * 0.66), kit.mats.red, 0, upperBase + 0.8, 0));
  const upper = new THREE.Mesh(frustum(w * 0.9, d * 0.9, w * 0.16, d * 0.16, 2.4, 0.3), roofMat);
  upper.position.y = upperBase + 1.6;
  upper.castShadow = true;
  g.add(upper);
  const ridge = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), kit.mats.gold);
  ridge.position.y = upperBase + 4.1;
  g.add(ridge);
  return g;
}

// ── DUBAI: sculpted desert tower ───────────────────────────────────────────
function desertTower(kit, rng, spec) {
  const g = new THREE.Group();
  const { w, d, h } = spec;
  const facade = spec.facade || kit.pickFacade(rng);
  const bay = facade.userData.bay, floorH = facade.userData.floor;
  const tiers = 3 + ((rng() * 3) | 0);
  let y = 0, cw = w, cd = d;
  for (let i = 0; i < tiers; i++) {
    const th = (h / tiers) * (0.75 + rng() * 0.5);
    const body = new THREE.Mesh(wallShell(cw, th, cd, bay, floorH), facade);
    body.position.y = y;
    body.rotation.y = i * 0.09;
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    const band = mesh(trimBox(cw + 0.3, 0.3, cd + 0.3), kit.mats.metal, 0, y + th, 0);
    band.rotation.y = i * 0.09;
    g.add(band);
    y += th;
    cw *= 0.8; cd *= 0.8;
  }
  const spire = new THREE.Mesh(new THREE.ConeGeometry(Math.max(cw, cd) * 0.45, h * 0.22, 8), kit.mats.metal);
  spire.position.y = y + h * 0.11;
  spire.castShadow = true;
  g.add(spire);
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.12, h * 0.08, 6), kit.mats.emissiveWarm);
  tip.position.y = y + h * 0.22 + h * 0.04;
  g.add(tip);
  return g;
}

// ── Generic filler ─────────────────────────────────────────────────────────
function simpleBlock(kit, rng, spec) {
  const g = new THREE.Group();
  const { w, d, h } = spec;
  const facade = spec.facade || kit.pickFacade(rng);
  const bay = facade.userData.bay, floorH = facade.userData.floor;
  const body = new THREE.Mesh(wallShell(w, h, d, bay, floorH), facade);
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);
  g.add(mesh(trimBox(w + 0.4, 0.35, d + 0.4), kit.mats.trim, 0, h + 0.17, 0));
  g.add(roofDressing(kit, rng, w, d, h + 0.35, {
    parapet: 0.7, ac: (rng() * 3) | 0, aerials: rng() < 0.4 ? 1 : 0,
  }));
  return g;
}
