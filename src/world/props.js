import * as THREE from 'three';
import { makeLeafCluster, makeBark, makeSignTexture, makeGlowSprite } from '../render/textures.js';
import { trimBox, frustum } from './buildings.js';
import { makeRNG, lerp, clamp, TAU } from '../core/math.js';

/**
 * Street furniture kit. Materials are shared across every instance so the
 * batcher can collapse thousands of props into a handful of draw calls.
 */
export class PropKit {
  constructor(theme, rng) {
    this.theme = theme;
    this.rng = rng || makeRNG(7);
    const P = theme.props || {};
    const mk = (c, r, m, e) => new THREE.MeshStandardMaterial({
      color: c, roughness: r, metalness: m ?? 0, envMapIntensity: e ?? 0.6, dithering: true,
    });

    this.m = {
      iron: mk(P.ironColor ?? 0x14161a, 0.52, 0.55, 0.9),
      darkMetal: mk(0x24262b, 0.44, 0.8, 1.0),
      steel: mk(0x8a9098, 0.35, 0.9, 1.2),
      paintedGreen: mk(0x22402f, 0.6, 0.3, 0.7),
      paintedRed: mk(P.redColor ?? 0xa5111a, 0.45, 0.2, 0.9),
      wood: mk(0x6b5238, 0.85),
      concrete: mk(0x8f8b84, 0.9),
      stone: mk(0x9a958c, 0.86),
      glassPane: new THREE.MeshStandardMaterial({
        color: 0x0e141c, roughness: 0.06, metalness: 0.2, envMapIntensity: 2.2,
        transparent: true, opacity: 0.5, depthWrite: false,
      }),
      lampGlass: new THREE.MeshStandardMaterial({
        color: 0x1a1a18, emissive: P.lampColor ?? 0xffcf8a,
        emissiveIntensity: theme.night ? 3.0 : 0.22, roughness: 0.28,
      }),
      bulbOff: new THREE.MeshStandardMaterial({ color: 0x2a2a28, roughness: 0.4 }),
      signWhite: mk(0xd8d6d0, 0.6),
      plastic: mk(0x2c2f34, 0.62),
      rubber: mk(0x1a1b1e, 0.92),
      gold: new THREE.MeshStandardMaterial({ color: 0xc9a349, roughness: 0.3, metalness: 1.0, envMapIntensity: 1.6 }),
      trafficRed: new THREE.MeshStandardMaterial({ color: 0x120404, emissive: 0xff2010, emissiveIntensity: 2.0, roughness: 0.3 }),
      trafficAmber: new THREE.MeshStandardMaterial({ color: 0x120c04, emissive: 0xff9010, emissiveIntensity: 0.35, roughness: 0.3 }),
      trafficGreen: new THREE.MeshStandardMaterial({ color: 0x041204, emissive: 0x30ff60, emissiveIntensity: 0.35, roughness: 0.3 }),
    };

    const bark = makeBark(3, P.barkColor ?? 0x4a3d30);
    this.m.bark = new THREE.MeshStandardMaterial({
      map: bark.map, normalMap: bark.normalMap, roughness: 0.92, envMapIntensity: 0.4,
    });
    this.m.bark.map.repeat.set(1, 3);
    this.m.bark.normalMap.repeat.set(1, 3);

    const leaf = makeLeafCluster({
      seed: 4, color: P.leafColor ?? 0x4a6b32, dark: P.leafDark ?? 0x1d2c14, autumn: P.autumn ?? 0,
    });
    this.m.leaf = new THREE.MeshStandardMaterial({
      map: leaf, transparent: false, alphaTest: 0.42, side: THREE.DoubleSide,
      roughness: 0.85, metalness: 0, envMapIntensity: 0.7, color: 0xffffff, dithering: true,
    });

    this._geoCache = new Map();
  }

  geo(key, factory) {
    if (!this._geoCache.has(key)) this._geoCache.set(key, factory());
    return this._geoCache.get(key);
  }

  // ── Street lamps ────────────────────────────────────────────────────────
  streetLamp(style = 'victorian') {
    const g = new THREE.Group();
    const M = this.m;
    if (style === 'victorian') {
      // Ornate cast-iron column with a lantern head (London / Westminster).
      g.add(m(new THREE.CylinderGeometry(0.30, 0.38, 0.7, 10), M.iron, 0, 0.35));
      g.add(m(new THREE.CylinderGeometry(0.16, 0.24, 0.5, 10), M.iron, 0, 0.9));
      g.add(m(new THREE.CylinderGeometry(0.085, 0.14, 4.4, 10), M.iron, 0, 3.35));
      g.add(m(new THREE.CylinderGeometry(0.15, 0.10, 0.3, 10), M.iron, 0, 5.65));
      // Lantern
      g.add(m(frustum(0.55, 0.55, 0.30, 0.30, 0.72, 1), M.lampGlass, 0, 5.8));
      g.add(m(frustum(0.34, 0.34, 0.06, 0.06, 0.42, 1), M.iron, 0, 6.52));
      g.add(m(new THREE.SphereGeometry(0.08, 8, 6), M.gold, 0, 7.0));
      // Cross-bar finials
      for (const s of [-1, 1]) {
        g.add(m(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 6), M.iron, s * 0.25, 5.3, 0, 0, 0, Math.PI / 2));
      }
    } else if (style === 'paris') {
      g.add(m(new THREE.CylinderGeometry(0.26, 0.34, 0.55, 10), M.paintedGreen, 0, 0.28));
      g.add(m(new THREE.CylinderGeometry(0.09, 0.15, 4.8, 10), M.paintedGreen, 0, 2.95));
      const arm = m(new THREE.CylinderGeometry(0.06, 0.06, 1.3, 8), M.paintedGreen, 0.45, 5.35, 0, 0, 0, Math.PI / 2.6);
      g.add(arm);
      g.add(m(frustum(0.5, 0.5, 0.22, 0.22, 0.6, 1), M.lampGlass, 0.95, 5.05));
      g.add(m(frustum(0.56, 0.56, 0.1, 0.1, 0.3, 1), M.paintedGreen, 0.95, 5.62));
    } else if (style === 'modern') {
      g.add(m(new THREE.CylinderGeometry(0.16, 0.22, 0.45, 10), M.darkMetal, 0, 0.22));
      g.add(m(new THREE.CylinderGeometry(0.075, 0.13, 7.4, 10), M.darkMetal, 0, 3.9));
      const arm = m(new THREE.CylinderGeometry(0.065, 0.065, 2.0, 8), M.darkMetal, 0.85, 7.5, 0, 0, 0, Math.PI / 2 - 0.18);
      g.add(arm);
      g.add(m(trimBox(0.62, 0.14, 0.34), M.darkMetal, 1.72, 7.32));
      g.add(m(trimBox(0.5, 0.05, 0.26), M.lampGlass, 1.72, 7.24));
    } else { // 'tokyo'
      g.add(m(new THREE.CylinderGeometry(0.13, 0.18, 0.4, 8), M.steel, 0, 0.2));
      g.add(m(new THREE.CylinderGeometry(0.07, 0.11, 6.4, 8), M.steel, 0, 3.4));
      g.add(m(new THREE.CylinderGeometry(0.055, 0.055, 1.4, 8), M.steel, 0.6, 6.5, 0, 0, 0, Math.PI / 2 - 0.12));
      g.add(m(new THREE.CylinderGeometry(0.30, 0.16, 0.35, 10), M.steel, 1.24, 6.35));
      g.add(m(new THREE.CylinderGeometry(0.26, 0.26, 0.06, 10), M.lampGlass, 1.24, 6.16));
    }
    return g;
  }

  /** Height of the emissive head, so we can register a point light there. */
  lampLightHeight(style) {
    return style === 'modern' ? 7.3 : style === 'tokyo' ? 6.2 : style === 'paris' ? 5.1 : 5.9;
  }
  lampLightOffset(style) {
    return style === 'modern' ? 1.72 : style === 'tokyo' ? 1.24 : style === 'paris' ? 0.95 : 0;
  }

  // ── Traffic light ───────────────────────────────────────────────────────
  trafficLight(state = 0) {
    const g = new THREE.Group();
    const M = this.m;
    g.add(m(new THREE.CylinderGeometry(0.2, 0.26, 0.4, 8), M.darkMetal, 0, 0.2));
    g.add(m(new THREE.CylinderGeometry(0.075, 0.1, 3.4, 8), M.darkMetal, 0, 1.9));
    g.add(m(trimBox(0.42, 1.15, 0.34), M.darkMetal, 0, 4.15));
    const lamps = [M.trafficRed, M.trafficAmber, M.trafficGreen];
    for (let i = 0; i < 3; i++) {
      const lit = i === state;
      const mat = lit ? lamps[i] : M.bulbOff;
      const l = m(new THREE.CylinderGeometry(0.115, 0.115, 0.06, 12), mat, 0, 4.55 - i * 0.36, 0.19, Math.PI / 2);
      l.rotation.x = Math.PI / 2;
      g.add(l);
      // Hood
      g.add(m(new THREE.CylinderGeometry(0.15, 0.15, 0.14, 12, 1, true, 0, Math.PI), M.darkMetal,
        0, 4.6 - i * 0.36, 0.2, Math.PI / 2, 0, 0));
    }
    return g;
  }

  // ── Trees ───────────────────────────────────────────────────────────────
  /** Crossed alpha-tested canopy planes — cheap, and reads well in motion. */
  tree(style = 'plane', rng = this.rng) {
    const g = new THREE.Group();
    const M = this.m;
    const h = style === 'palm' ? 7 + rng() * 3 : 7.5 + rng() * 4.5;
    const trunkR = style === 'palm' ? 0.22 : 0.28 + rng() * 0.13;

    if (style === 'palm') {
      const seg = 7;
      for (let i = 0; i < seg; i++) {
        const t = i / seg;
        const lean = Math.sin(t * 1.7) * 0.9;
        const c = new THREE.Mesh(
          new THREE.CylinderGeometry(trunkR * (1 - t * 0.4), trunkR * (1 - (t - 1 / seg) * 0.4), h / seg, 8),
          M.bark
        );
        c.position.set(lean, (h / seg) * (i + 0.5), 0);
        c.rotation.z = -Math.sin(t * 1.7) * 0.12;
        c.castShadow = true;
        g.add(c);
      }
      const fronds = 9;
      for (let i = 0; i < fronds; i++) {
        const a = (i / fronds) * TAU + rng();
        const f = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.5), M.leaf);
        f.position.set(Math.sin(1.7) * 0.9 + Math.cos(a) * 2.0, h - 0.2 - rng() * 0.4, Math.sin(a) * 2.0);
        f.rotation.set(-0.55 - rng() * 0.3, -a + Math.PI / 2, 0);
        f.castShadow = true;
        g.add(f);
      }
      return g;
    }

    // Trunk with a slight taper and a couple of limbs.
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(trunkR * 0.6, trunkR, h * 0.62, 9), M.bark);
    trunk.position.y = h * 0.31;
    trunk.castShadow = true; trunk.receiveShadow = true;
    g.add(trunk);
    const limbs = 3 + ((rng() * 3) | 0);
    for (let i = 0; i < limbs; i++) {
      const a = (i / limbs) * TAU + rng() * 0.8;
      const ll = h * (0.22 + rng() * 0.18);
      const limb = new THREE.Mesh(new THREE.CylinderGeometry(trunkR * 0.18, trunkR * 0.42, ll, 6), M.bark);
      limb.position.set(Math.cos(a) * ll * 0.28, h * 0.62 + ll * 0.32, Math.sin(a) * ll * 0.28);
      limb.rotation.set(Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6);
      limb.castShadow = true;
      g.add(limb);
    }

    // Canopy: several rotated quads at varying heights forms a convincing mass.
    const cw = (style === 'columnar' ? 3.2 : 6.2) + rng() * 2.2;
    const ch = (style === 'columnar' ? 8.0 : 5.4) + rng() * 1.6;
    const planes = style === 'columnar' ? 5 : 7;
    for (let i = 0; i < planes; i++) {
      const t = i / planes;
      const s = 0.72 + Math.sin(t * Math.PI) * 0.5;
      const p = new THREE.Mesh(new THREE.PlaneGeometry(cw * s, ch * 0.52 * s), M.leaf);
      p.position.set(
        (rng() - 0.5) * cw * 0.28,
        h * 0.62 + ch * 0.34 + (rng() - 0.5) * ch * 0.42,
        (rng() - 0.5) * cw * 0.28
      );
      p.rotation.set((rng() - 0.5) * 0.5, (i / planes) * Math.PI + rng() * 0.4, (rng() - 0.5) * 0.4);
      p.castShadow = true; p.receiveShadow = true;
      g.add(p);
    }
    return g;
  }

  // ── Railings & fences ───────────────────────────────────────────────────
  /** Ornate embankment railing (Thames / Seine). Length along +X. */
  railing(length, style = 'ornate') {
    const g = new THREE.Group();
    const M = this.m;
    const posts = Math.max(2, Math.round(length / 2.2));
    const step = length / posts;
    for (let i = 0; i <= posts; i++) {
      const x = -length / 2 + step * i;
      if (style === 'ornate') {
        g.add(m(new THREE.CylinderGeometry(0.075, 0.10, 1.25, 8), M.iron, x, 0.62));
        g.add(m(new THREE.SphereGeometry(0.10, 8, 6), M.iron, x, 1.30));
      } else {
        g.add(m(new THREE.CylinderGeometry(0.05, 0.06, 1.1, 6), M.iron, x, 0.55));
      }
    }
    // Rails
    g.add(m(trimBox(length, 0.07, 0.07), M.iron, 0, 1.16));
    g.add(m(trimBox(length, 0.05, 0.05), M.iron, 0, 0.68));
    if (style === 'ornate') {
      const bars = Math.max(4, Math.round(length / 0.28));
      for (let i = 0; i <= bars; i++) {
        const x = -length / 2 + (length / bars) * i;
        g.add(m(new THREE.CylinderGeometry(0.022, 0.022, 1.05, 5), M.iron, x, 0.55));
      }
      g.add(m(trimBox(length, 0.045, 0.045), M.iron, 0, 0.30));
    } else {
      const bars = Math.max(4, Math.round(length / 0.4));
      for (let i = 0; i <= bars; i++) {
        const x = -length / 2 + (length / bars) * i;
        g.add(m(new THREE.CylinderGeometry(0.018, 0.018, 0.95, 4), M.iron, x, 0.52));
      }
    }
    return g;
  }

  crowdBarrier(length = 2.2) {
    const g = new THREE.Group();
    const M = this.m;
    g.add(m(trimBox(length, 0.06, 0.06), M.steel, 0, 1.05));
    g.add(m(trimBox(length, 0.05, 0.05), M.steel, 0, 0.62));
    for (const s of [-1, 1]) {
      g.add(m(new THREE.CylinderGeometry(0.035, 0.035, 1.1, 6), M.steel, s * length / 2, 0.55));
      g.add(m(trimBox(0.05, 0.05, 0.7), M.steel, s * length / 2, 0.04));
    }
    const bars = 8;
    for (let i = 1; i < bars; i++) {
      g.add(m(new THREE.CylinderGeometry(0.016, 0.016, 0.44, 4), M.steel, -length / 2 + (length / bars) * i, 0.83));
    }
    return g;
  }

  // ── Small street furniture ──────────────────────────────────────────────
  bollard(style = 'iron') {
    const g = new THREE.Group();
    const M = this.m;
    if (style === 'iron') {
      g.add(m(new THREE.CylinderGeometry(0.10, 0.16, 0.95, 10), M.iron, 0, 0.48));
      g.add(m(new THREE.SphereGeometry(0.115, 10, 7), M.iron, 0, 0.98));
    } else {
      g.add(m(new THREE.CylinderGeometry(0.075, 0.085, 1.0, 10), M.steel, 0, 0.5));
      g.add(m(new THREE.CylinderGeometry(0.08, 0.08, 0.07, 10), M.paintedRed, 0, 0.9));
    }
    return g;
  }

  bench() {
    const g = new THREE.Group();
    const M = this.m;
    for (let i = 0; i < 4; i++) {
      g.add(m(trimBox(1.75, 0.06, 0.11), M.wood, 0, 0.44 + i * 0.0, -0.24 + i * 0.14));
    }
    for (let i = 0; i < 3; i++) {
      const s = m(trimBox(1.75, 0.11, 0.05), M.wood, 0, 0.62 + i * 0.16, 0.26);
      s.rotation.x = -0.16;
      g.add(s);
    }
    for (const s of [-1, 1]) {
      g.add(m(trimBox(0.09, 0.44, 0.62), M.iron, s * 0.78, 0.22, 0));
      g.add(m(trimBox(0.09, 0.55, 0.09), M.iron, s * 0.78, 0.7, 0.28));
    }
    return g;
  }

  bin(style = 'city') {
    const g = new THREE.Group();
    const M = this.m;
    if (style === 'city') {
      g.add(m(new THREE.CylinderGeometry(0.32, 0.28, 0.9, 12), M.iron, 0, 0.45));
      g.add(m(new THREE.CylinderGeometry(0.35, 0.35, 0.07, 12), M.iron, 0, 0.92));
      g.add(m(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 6), M.iron, 0, 0.25));
    } else {
      g.add(m(trimBox(0.55, 0.9, 0.45), M.plastic, 0, 0.45));
      g.add(m(trimBox(0.6, 0.06, 0.5), M.darkMetal, 0, 0.93));
    }
    return g;
  }

  postBox() {
    const g = new THREE.Group();
    const M = this.m;
    g.add(m(new THREE.CylinderGeometry(0.32, 0.34, 1.55, 14), M.paintedRed, 0, 0.78));
    g.add(m(new THREE.SphereGeometry(0.33, 14, 8, 0, TAU, 0, Math.PI / 2), M.paintedRed, 0, 1.55));
    g.add(m(trimBox(0.34, 0.055, 0.06), M.iron, 0, 1.3, 0.33));
    return g;
  }

  phoneBox() {
    const g = new THREE.Group();
    const M = this.m;
    const red = M.paintedRed;
    g.add(m(trimBox(1.05, 0.14, 1.05), red, 0, 0.07));
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      g.add(m(trimBox(0.13, 2.5, 0.13), red, sx * 0.46, 1.3, sz * 0.46));
    }
    for (const [dx, dz, ry] of [[0, 0.5, 0], [0, -0.5, 0], [0.5, 0, Math.PI / 2], [-0.5, 0, Math.PI / 2]]) {
      g.add(m(trimBox(0.86, 1.85, 0.04), M.glassPane, dx, 1.42, dz, ry));
      g.add(m(trimBox(0.9, 0.42, 0.1), red, dx, 0.38, dz, ry));
    }
    g.add(m(trimBox(1.16, 0.3, 1.16), red, 0, 2.66));
    g.add(m(frustum(1.14, 1.14, 0.62, 0.62, 0.42, 1), red, 0, 2.81));
    g.add(m(new THREE.SphereGeometry(0.11, 8, 6), M.gold, 0, 3.3));
    return g;
  }

  busStop() {
    const g = new THREE.Group();
    const M = this.m;
    g.add(m(trimBox(4.2, 0.1, 1.5), M.darkMetal, 0, 2.55));
    for (const s of [-1, 1]) {
      g.add(m(trimBox(0.1, 2.5, 0.1), M.darkMetal, s * 2.0, 1.25, -0.65));
      g.add(m(trimBox(0.1, 2.5, 0.1), M.darkMetal, s * 2.0, 1.25, 0.65));
    }
    g.add(m(trimBox(4.0, 2.2, 0.05), M.glassPane, 0, 1.35, -0.68));
    g.add(m(trimBox(1.1, 1.9, 0.09), M.darkMetal, 1.5, 1.2, 0.68));
    g.add(m(trimBox(3.6, 0.08, 0.4), M.plastic, -0.3, 0.62, -0.45));
    return g;
  }

  signPost(tex, w = 1.4, h = 0.42, height = 2.5) {
    const g = new THREE.Group();
    const M = this.m;
    g.add(m(new THREE.CylinderGeometry(0.05, 0.06, height, 8), M.steel, 0, height / 2));
    const mat = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.5, metalness: 0.05,
      emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: this.theme.night ? 0.5 : 0.06,
      side: THREE.DoubleSide,
    });
    g.add(m(new THREE.PlaneGeometry(w, h), mat, 0, height - h / 2 - 0.05, 0.04));
    g.add(m(trimBox(w, h, 0.045), M.signWhite, 0, height - h / 2 - 0.05, 0));
    return g;
  }

  hydrant() {
    const g = new THREE.Group();
    const M = this.m;
    g.add(m(new THREE.CylinderGeometry(0.16, 0.2, 0.62, 10), M.paintedRed, 0, 0.31));
    g.add(m(new THREE.SphereGeometry(0.17, 10, 7), M.paintedRed, 0, 0.66));
    for (const s of [-1, 1]) g.add(m(new THREE.CylinderGeometry(0.07, 0.07, 0.14, 8), M.paintedRed, s * 0.19, 0.42, 0, 0, 0, Math.PI / 2));
    g.add(m(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 8), M.paintedRed, 0, 0.8));
    return g;
  }

  planter() {
    const g = new THREE.Group();
    const M = this.m;
    g.add(m(frustum(1.3, 1.3, 1.0, 1.0, 0.72, 1), M.stone, 0, 0));
    g.add(m(new THREE.SphereGeometry(0.62, 10, 8), this.m.leaf, 0, 1.0));
    return g;
  }

  cone() {
    const g = new THREE.Group();
    g.add(m(trimBox(0.42, 0.05, 0.42), this.m.plastic, 0, 0.025));
    const c = m(new THREE.ConeGeometry(0.19, 0.72, 10), new THREE.MeshStandardMaterial({
      color: 0xd8541c, roughness: 0.65,
    }), 0, 0.4);
    g.add(c);
    g.add(m(new THREE.CylinderGeometry(0.145, 0.16, 0.1, 10), this.m.signWhite, 0, 0.42));
    return g;
  }

  vendingMachine(color = 0xd42a2a) {
    const g = new THREE.Group();
    const M = this.m;
    const body = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2 });
    g.add(m(trimBox(1.05, 1.85, 0.72), body, 0, 0.93));
    const face = new THREE.MeshStandardMaterial({
      color: 0x101014, emissive: 0xfff0d0, emissiveIntensity: this.theme.night ? 3.0 : 0.4, roughness: 0.25,
    });
    g.add(m(trimBox(0.85, 1.1, 0.04), face, 0, 1.25, 0.37));
    g.add(m(trimBox(0.9, 0.3, 0.05), M.darkMetal, 0, 0.55, 0.37));
    return g;
  }

  lantern(color = 0xd42a1a) {
    const g = new THREE.Group();
    const lm = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: this.theme.night ? 2.6 : 0.5, roughness: 0.55,
    });
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 10), lm);
    s.scale.set(1, 0.78, 1);
    g.add(s);
    g.add(m(new THREE.CylinderGeometry(0.1, 0.1, 0.1, 8), this.m.gold, 0, 0.29));
    g.add(m(new THREE.CylinderGeometry(0.1, 0.1, 0.1, 8), this.m.gold, 0, -0.29));
    for (let i = 0; i < 5; i++) {
      g.add(m(trimBox(0.02, 0.28, 0.02), this.m.gold, (i - 2) * 0.05, -0.46, 0));
    }
    return g;
  }

  flagPole(tex, angle = 0.7) {
    const g = new THREE.Group();
    const M = this.m;
    const pole = m(new THREE.CylinderGeometry(0.045, 0.055, 3.4, 8), M.gold, 0, 0);
    pole.rotation.z = -Math.PI / 2 + angle;
    pole.position.set(Math.cos(angle) * 1.7, Math.sin(angle) * 1.7, 0);
    g.add(pole);
    const fm = new THREE.MeshStandardMaterial({
      map: tex, side: THREE.DoubleSide, roughness: 0.85, metalness: 0,
    });
    const flag = m(new THREE.PlaneGeometry(1.9, 1.1, 6, 3), fm,
      Math.cos(angle) * 2.35, Math.sin(angle) * 2.35 - 0.55, 0);
    // Gentle wave baked into the vertices.
    const p = flag.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      p.setZ(i, Math.sin((x + 0.95) * 2.4) * 0.14 * ((x + 0.95) / 1.9));
    }
    p.needsUpdate = true;
    flag.geometry.computeVertexNormals();
    g.add(flag);
    return g;
  }

  /** Scaffolding — great for adding believable urban clutter. */
  scaffold(w = 6, h = 12, d = 1.4) {
    const g = new THREE.Group();
    const M = this.m;
    const bays = Math.max(2, Math.round(w / 2.2));
    const lifts = Math.max(2, Math.round(h / 2.0));
    for (let i = 0; i <= bays; i++) {
      const x = -w / 2 + (w / bays) * i;
      for (const z of [-d / 2, d / 2]) {
        g.add(m(new THREE.CylinderGeometry(0.045, 0.045, h, 6), M.steel, x, h / 2, z));
      }
    }
    for (let j = 1; j <= lifts; j++) {
      const y = (h / lifts) * j;
      g.add(m(trimBox(w, 0.05, 0.05), M.steel, 0, y, -d / 2));
      g.add(m(trimBox(w, 0.05, 0.05), M.steel, 0, y, d / 2));
      g.add(m(trimBox(w, 0.04, d), M.wood, 0, y + 0.03, 0));
      g.add(m(trimBox(w, 0.05, 0.05), M.steel, 0, y + 1.0, d / 2));
    }
    return g;
  }

  dispose() {
    for (const mat of Object.values(this.m)) mat.dispose && mat.dispose();
    for (const g of this._geoCache.values()) g.dispose && g.dispose();
  }
}

function m(geo, mat, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0) {
  const o = new THREE.Mesh(geo, mat);
  o.position.set(x, y, z);
  o.rotation.set(rx, ry, rz);
  o.castShadow = true;
  o.receiveShadow = true;
  return o;
}

export { m as propMesh };
