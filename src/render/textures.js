import * as THREE from 'three';
import { makeRNG, fbm, noise2, ridge, worley, clamp, lerp, saturate } from '../core/math.js';

// ── Canvas helpers ──────────────────────────────────────────────────────────
const _cache = new Map();
export function cached(key, factory) {
  if (_cache.has(key)) return _cache.get(key);
  const v = factory();
  _cache.set(key, v);
  return v;
}
export function clearTextureCache() {
  for (const v of _cache.values()) {
    if (v && v.dispose) v.dispose();
    else if (v && typeof v === 'object') Object.values(v).forEach((t) => t && t.dispose && t.dispose());
  }
  _cache.clear();
}

function canvas(size, h = size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = h;
  return c;
}

function toTexture(cv, { srgb = true, repeat = 1, aniso = 16, wrap = THREE.RepeatWrapping } = {}) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = wrap;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Convert a height field (Float32Array, size×size, 0..1) into a normal map. */
function normalFromHeight(height, size, strength = 2.0, wrapEdges = true) {
  const cv = canvas(size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x, y) => {
    if (wrapEdges) { x = (x + size) % size; y = (y + size) % size; }
    else { x = clamp(x, 0, size - 1); y = clamp(y, 0, size - 1); }
    return height[y * size + x];
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = toTexture(cv, { srgb: false });
  return t;
}

function grayTexture(data, size, srgb = false) {
  const cv = canvas(size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = clamp(data[i], 0, 1) * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(cv, { srgb });
}

// ════════════════════════════════════════════════════════════════════════════
//  ASPHALT — the single most important surface in the game
// ════════════════════════════════════════════════════════════════════════════
export function makeAsphalt(opts = {}) {
  const {
    size = 512, seed = 7, base = 0x2a2b2e, aggregate = 0.42,
    crackAmount = 0.55, patchAmount = 0.5, tint = 0x000000,
  } = opts;
  const key = `asphalt:${size}:${seed}:${base}:${aggregate}:${crackAmount}:${patchAmount}:${tint}`;
  return cached(key, () => {
    const rng = makeRNG(seed);
    const cv = canvas(size);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const height = new Float32Array(size * size);
    const rough = new Float32Array(size * size);

    const br = (base >> 16) & 255, bg = (base >> 8) & 255, bb = base & 255;
    const tr = (tint >> 16) & 255, tg = (tint >> 8) & 255, tb = tint & 255;
    const S = 1 / size;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x * S, v = y * S;
        const i = y * size + x;

        // Aggregate: fine cellular stones embedded in bitumen.
        const w1 = worley(u * 58, v * 58);
        const w2 = worley(u * 128 + 31.7, v * 128 + 11.3);
        const stone = (1 - saturate(w1 * 2.6)) * 0.65 + (1 - saturate(w2 * 3.1)) * 0.35;

        // Large-scale mottling from resurfacing + oil.
        const mott = fbm(u * 4.5, v * 4.5, 4) * 0.5 + 0.5;
        const grime = fbm(u * 13 + 40, v * 13 + 40, 3) * 0.5 + 0.5;

        // Cracks: ridged noise thresholded into thin dark lines.
        const cr = ridge(u * 6.2 + 90, v * 6.2 + 90, 4);
        const crack = crackAmount * saturate((cr - 0.78) * 9.0);

        // Patch repairs: darker rectangles of newer tarmac.
        const pn = fbm(u * 2.1 + 200, v * 2.1 + 200, 2);
        const patch = patchAmount * saturate((pn - 0.16) * 4.0) * 0.35;

        let lum = 0.72 + stone * aggregate * 0.75 + (mott - 0.5) * 0.30 + (grime - 0.5) * 0.16;
        lum -= crack * 0.55;
        lum -= patch;
        lum = clamp(lum, 0.18, 1.9);

        const spec = rng() * 0.06;
        const idx = i * 4;
        d[idx] = clamp(br * lum + tr * 0.35 + spec * 40, 0, 255);
        d[idx + 1] = clamp(bg * lum + tg * 0.35 + spec * 40, 0, 255);
        d[idx + 2] = clamp(bb * lum + tb * 0.35 + spec * 44, 0, 255);
        d[idx + 3] = 255;

        height[i] = saturate(stone * 0.55 + (mott - 0.5) * 0.25 + 0.4 - crack * 1.4);
        // Fresh patches and worn stone read differently under a low sun.
        rough[i] = clamp(0.80 + (1 - stone) * 0.14 - patch * 0.22 + (grime - 0.5) * 0.10, 0.35, 0.99);
      }
    }
    ctx.putImageData(img, 0, 0);

    return {
      map: toTexture(cv),
      normalMap: normalFromHeight(height, size, 2.4),
      roughnessMap: grayTexture(rough, size),
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  ROAD SURFACE with lane markings baked across the width
//  u = across the road (0 = left kerb, 1 = right kerb), v = along the road.
// ════════════════════════════════════════════════════════════════════════════
export function makeRoadTexture(spec) {
  const {
    widthPx = 1024, lengthPx = 512, seed = 11,
    roadWidth = 15, tileLength = 12,
    base = 0x2c2d31, markings = 'uk', wear = 1.0,
  } = spec;
  const key = `road:${widthPx}:${lengthPx}:${seed}:${roadWidth}:${markings}:${base}:${wear}`;
  return cached(key, () => {
    const rng = makeRNG(seed);
    const W = widthPx, H = lengthPx;
    const cv = canvas(W, H);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const height = new Float32Array(W * H);
    const rough = new Float32Array(W * H);

    const br = (base >> 16) & 255, bg = (base >> 8) & 255, bb = base & 255;
    const pxPerM_x = W / roadWidth;
    const pxPerM_y = H / tileLength;

    // ── Base asphalt ────────────────────────────────────────────────────────
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const mx = x / pxPerM_x, my = y / pxPerM_y;     // metres
        const w1 = worley(mx * 3.4, my * 3.4);
        const w2 = worley(mx * 8.1 + 17, my * 8.1 + 7);
        const stone = (1 - saturate(w1 * 2.4)) * 0.6 + (1 - saturate(w2 * 3.0)) * 0.4;
        const mott = fbm(mx * 0.16, my * 0.16, 4) * 0.5 + 0.5;
        const grime = fbm(mx * 0.6 + 30, my * 0.6 + 30, 3) * 0.5 + 0.5;
        const cr = ridge(mx * 0.35 + 5, my * 0.35 + 5, 4);
        const crack = saturate((cr - 0.80) * 10) * wear;

        // Tyre polishing: two darker, smoother bands per lane.
        const acrossM = mx;
        let polish = 0;
        for (let ln = 0; ln < 8; ln++) {
          const c = 1.75 + ln * 1.75;
          const dd = Math.abs(acrossM - c);
          polish = Math.max(polish, saturate(1 - dd / 0.55));
        }
        polish *= 0.55 * wear;

        let lum = 0.74 + stone * 0.34 + (mott - 0.5) * 0.34 + (grime - 0.5) * 0.14;
        lum -= crack * 0.5;
        lum -= polish * 0.16;
        lum = clamp(lum, 0.2, 1.8);

        const idx = i * 4;
        const sp = rng() * 7;
        d[idx] = clamp(br * lum + sp, 0, 255);
        d[idx + 1] = clamp(bg * lum + sp, 0, 255);
        d[idx + 2] = clamp(bb * lum + sp * 1.1, 0, 255);
        d[idx + 3] = 255;
        height[i] = saturate(stone * 0.5 + (mott - 0.5) * 0.3 + 0.42 - crack * 1.6);
        rough[i] = clamp(0.86 + (1 - stone) * 0.10 - polish * 0.34 + (grime - 0.5) * 0.08, 0.3, 0.99);
      }
    }
    ctx.putImageData(img, 0, 0);

    // ── Markings, drawn in metres then scaled to pixels ──────────────────────
    ctx.save();
    ctx.scale(pxPerM_x, pxPerM_y);

    const paint = (x, w, color, alpha, dash) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      if (!dash) {
        ctx.fillRect(x - w / 2, 0, w, tileLength);
      } else {
        const [on, off] = dash;
        let y = 0;
        while (y < tileLength) {
          ctx.fillRect(x - w / 2, y, w, Math.min(on, tileLength - y));
          y += on + off;
        }
      }
    };

    const half = roadWidth / 2;
    if (markings === 'uk') {
      // Double yellow parking restriction hugging both kerbs.
      paint(0.55, 0.10, '#d8b13a', 0.85 * wear, null);
      paint(0.78, 0.10, '#d8b13a', 0.85 * wear, null);
      paint(roadWidth - 0.55, 0.10, '#d8b13a', 0.85 * wear, null);
      paint(roadWidth - 0.78, 0.10, '#d8b13a', 0.85 * wear, null);
      // White centre line (long dashes) + lane dividers.
      paint(half, 0.14, '#e8e6e0', 0.80 * wear, [4.0, 2.0]);
      paint(half - 3.5, 0.12, '#dedbd4', 0.62 * wear, [2.0, 4.0]);
      paint(half + 3.5, 0.12, '#dedbd4', 0.62 * wear, [2.0, 4.0]);
    } else if (markings === 'eu') {
      paint(half, 0.14, '#ecebe6', 0.82 * wear, [3.0, 3.0]);
      paint(half - 3.4, 0.11, '#dedbd4', 0.55 * wear, [1.5, 4.5]);
      paint(half + 3.4, 0.11, '#dedbd4', 0.55 * wear, [1.5, 4.5]);
      paint(0.45, 0.13, '#e6e4de', 0.55 * wear, null);
      paint(roadWidth - 0.45, 0.13, '#e6e4de', 0.55 * wear, null);
    } else if (markings === 'us') {
      paint(half - 0.09, 0.11, '#e2c243', 0.85 * wear, null);
      paint(half + 0.09, 0.11, '#e2c243', 0.85 * wear, null);
      paint(half - 3.6, 0.12, '#eeece6', 0.6 * wear, [3.0, 6.0]);
      paint(half + 3.6, 0.12, '#eeece6', 0.6 * wear, [3.0, 6.0]);
      paint(0.5, 0.14, '#eeece6', 0.62 * wear, null);
      paint(roadWidth - 0.5, 0.14, '#eeece6', 0.62 * wear, null);
    } else if (markings === 'jp') {
      paint(half, 0.15, '#f2f0ea', 0.85 * wear, [5.0, 5.0]);
      paint(half - 3.3, 0.11, '#e8e6e0', 0.5 * wear, [2.0, 4.0]);
      paint(half + 3.3, 0.11, '#e8e6e0', 0.5 * wear, [2.0, 4.0]);
      paint(0.6, 0.14, '#f2f0ea', 0.55 * wear, null);
      paint(roadWidth - 0.6, 0.14, '#f2f0ea', 0.55 * wear, null);
    } else if (markings === 'cn') {
      paint(half - 0.10, 0.12, '#e8d24a', 0.8 * wear, null);
      paint(half + 0.10, 0.12, '#e8d24a', 0.8 * wear, null);
      paint(half - 3.6, 0.12, '#f0eee8', 0.58 * wear, [4.0, 2.0]);
      paint(half + 3.6, 0.12, '#f0eee8', 0.58 * wear, [4.0, 2.0]);
      paint(0.5, 0.15, '#f0eee8', 0.6 * wear, null);
      paint(roadWidth - 0.5, 0.15, '#f0eee8', 0.6 * wear, null);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // ── Break up the paint with wear so it never looks like vector art ──────
    const mimg = ctx.getImageData(0, 0, W, H);
    const md = mimg.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const n = fbm(x / pxPerM_x * 2.4 + 300, y / pxPerM_y * 2.4 + 300, 3) * 0.5 + 0.5;
        const scuff = saturate((n - 0.42) * 2.4);
        const wearMul = lerp(1.0, 0.62 + scuff * 0.5, 0.55);
        // Only pull painted (bright) pixels toward the asphalt beneath them.
        const lum = (md[i] + md[i + 1] + md[i + 2]) / 3;
        if (lum > 70) {
          md[i] *= wearMul; md[i + 1] *= wearMul; md[i + 2] *= wearMul;
          const j = y * W + x;
          rough[j] = clamp(rough[j] * 0.82, 0.25, 0.99);   // paint is smoother
          height[j] = clamp(height[j] + 0.06, 0, 1);
        }
      }
    }
    ctx.putImageData(mimg, 0, 0);

    return {
      map: toTexture(cv, { wrap: THREE.RepeatWrapping }),
      normalMap: normalFromHeight(height, W, 1.9, false),
      roughnessMap: grayTexture(rough, W),
      width: W, height: H,
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  WET / PUDDLE MASK — drives roughness and reflection strength
// ════════════════════════════════════════════════════════════════════════════
export function makePuddleMask(size = 512, seed = 3, coverage = 0.5) {
  return cached(`puddle:${size}:${seed}:${coverage}`, () => {
    const cv = canvas(size);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size;
        let n = fbm(u * 3.2, v * 3.2, 5) * 0.5 + 0.5;
        n += (fbm(u * 9.0 + 20, v * 9.0 + 20, 3) * 0.5 + 0.5) * 0.35;
        n /= 1.35;
        const pud = saturate((n - (1.0 - coverage) * 0.62) * 3.4);
        const i = (y * size + x) * 4;
        const val = pud * 255;
        d[i] = d[i + 1] = d[i + 2] = val;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return toTexture(cv, { srgb: false });
  });
}

/** Animated ripple normals for rain hitting standing water. */
export function makeRippleNormal(size = 256, seed = 5) {
  return cached(`ripple:${size}:${seed}`, () => {
    const h = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size;
        h[y * size + x] = fbm(u * 14, v * 14, 4) * 0.5 + 0.5;
      }
    }
    return normalFromHeight(h, size, 1.1);
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  BUILDING FACADES
// ════════════════════════════════════════════════════════════════════════════
/**
 * A tileable facade: one floor tall, N window bays wide.
 * Returns {map, normalMap, roughnessMap, emissiveMap} — the emissive channel
 * carries lit windows for night themes.
 */
export function makeFacade(spec) {
  const {
    size = 512, seed = 1, bays = 4, style = 'stone',
    wallColor = 0x9a9187, trimColor = 0xb8b0a4,
    glassColor = 0x1c2530, litRatio = 0.0, litColor = 0xffd9a0,
    windowH = 0.58, windowW = 0.46, arched = false, balcony = false,
    grime = 0.5,
  } = spec;
  const key = `facade:${JSON.stringify(spec)}`;
  return cached(key, () => {
    const rng = makeRNG(seed);
    const S = size;
    const cv = canvas(S);
    const ctx = cv.getContext('2d');
    const rcv = canvas(S);
    const rctx = rcv.getContext('2d');
    const ecv = canvas(S);
    const ectx = ecv.getContext('2d');
    const height = new Float32Array(S * S);

    const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

    // ── Wall base ───────────────────────────────────────────────────────────
    ctx.fillStyle = hex(wallColor);
    ctx.fillRect(0, 0, S, S);
    rctx.fillStyle = '#b4b4b4';
    rctx.fillRect(0, 0, S, S);
    ectx.fillStyle = '#000';
    ectx.fillRect(0, 0, S, S);

    const wimg = ctx.getImageData(0, 0, S, S);
    const wd = wimg.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        let n = 0, hgt = 0.5;
        if (style === 'brick') {
          const rowH = 1 / 22, brickW = 1 / 9;
          const row = Math.floor(v / rowH);
          const off = (row % 2) * 0.5;
          const bx = (u / brickW + off) % 1;
          const by = (v / rowH) % 1;
          const mortar = (bx < 0.045 || bx > 0.955 || by < 0.10 || by > 0.90) ? 1 : 0;
          const vary = noise2(Math.floor(u / brickW) * 3.7 + row * 1.3, row * 2.1) * 0.5 + 0.5;
          n = mortar ? -0.28 : (vary - 0.5) * 0.34;
          hgt = mortar ? 0.25 : 0.72 + (vary - 0.5) * 0.1;
        } else if (style === 'stone') {
          const rowH = 1 / 9, blockW = 1 / 5;
          const row = Math.floor(v / rowH);
          const off = (row % 2) * 0.5;
          const bx = (u / blockW + off) % 1;
          const by = (v / rowH) % 1;
          const joint = (bx < 0.012 || bx > 0.988 || by < 0.03 || by > 0.97) ? 1 : 0;
          const vary = noise2(Math.floor(u / blockW) * 5.1 + row * 2.7, row * 1.9) * 0.5 + 0.5;
          const grainN = fbm(u * 24, v * 24, 3) * 0.5 + 0.5;
          n = joint ? -0.20 : (vary - 0.5) * 0.20 + (grainN - 0.5) * 0.12;
          hgt = joint ? 0.3 : 0.7 + (vary - 0.5) * 0.12;
        } else if (style === 'plaster') {
          const g = fbm(u * 18, v * 18, 4) * 0.5 + 0.5;
          const crack = saturate((ridge(u * 7 + 3, v * 7 + 3, 3) - 0.85) * 8);
          n = (g - 0.5) * 0.16 - crack * 0.3;
          hgt = 0.55 + (g - 0.5) * 0.2 - crack * 0.4;
        } else { // 'panel' — modern curtain wall
          const g = fbm(u * 40, v * 40, 3) * 0.5 + 0.5;
          n = (g - 0.5) * 0.06;
          hgt = 0.5;
        }

        // Weathering streaks running down from window sills.
        const streak = saturate(fbm(u * 40, v * 2.2, 3) * 0.5 + 0.5 - 0.44) * grime;
        n -= streak * 0.22 * v;

        const i = (y * S + x) * 4;
        const mul = 1 + n;
        wd[i] = clamp(wd[i] * mul, 0, 255);
        wd[i + 1] = clamp(wd[i + 1] * mul, 0, 255);
        wd[i + 2] = clamp(wd[i + 2] * mul, 0, 255);
        height[y * S + x] = hgt;
      }
    }
    ctx.putImageData(wimg, 0, 0);

    // ── Windows ─────────────────────────────────────────────────────────────
    const bayW = S / bays;
    const winW = bayW * windowW;
    const winH = S * windowH;
    const winY = S * 0.20;

    for (let b = 0; b < bays; b++) {
      const cx = b * bayW + bayW / 2;
      const x0 = cx - winW / 2;

      // Reveal / surround
      const pad = winW * 0.12;
      ctx.fillStyle = hex(trimColor);
      ctx.fillRect(x0 - pad, winY - pad, winW + pad * 2, winH + pad * 2);
      if (arched) {
        ctx.beginPath();
        ctx.arc(cx, winY - pad, winW / 2 + pad, Math.PI, 0);
        ctx.fill();
      }

      // Glass
      const lit = rng() < litRatio;
      const gc = lit ? litColor : glassColor;
      const grd = ctx.createLinearGradient(x0, winY, x0 + winW, winY + winH);
      if (lit) {
        grd.addColorStop(0, hex(gc));
        grd.addColorStop(1, hex(gc));
      } else {
        // Fake a sky reflection gradient in unlit glass.
        grd.addColorStop(0, hex(gc));
        grd.addColorStop(0.45, `rgba(${(gc >> 16) & 255},${(gc >> 8) & 255},${gc & 255},1)`);
        grd.addColorStop(1, '#0a0e14');
      }
      ctx.fillStyle = grd;
      ctx.fillRect(x0, winY, winW, winH);
      if (arched) {
        ctx.beginPath();
        ctx.arc(cx, winY, winW / 2, Math.PI, 0);
        ctx.fill();
      }

      // Glazing bars
      ctx.strokeStyle = hex(trimColor);
      ctx.lineWidth = Math.max(1.5, S / 340);
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(cx, winY); ctx.lineTo(cx, winY + winH);
      const rows = 2 + (rng() < 0.5 ? 1 : 0);
      for (let r = 1; r < rows; r++) {
        const y = winY + (winH * r) / rows;
        ctx.moveTo(x0, y); ctx.lineTo(x0 + winW, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Sill
      ctx.fillStyle = hex(trimColor);
      ctx.fillRect(x0 - pad * 1.9, winY + winH + pad, winW + pad * 3.8, S * 0.026);

      if (balcony) {
        ctx.strokeStyle = 'rgba(24,22,20,0.9)';
        ctx.lineWidth = Math.max(1.2, S / 420);
        const by0 = winY + winH * 0.42;
        const bh = winH * 0.42;
        ctx.strokeRect(x0 - pad * 2.4, by0, winW + pad * 4.8, bh);
        const bars = 14;
        ctx.beginPath();
        for (let i = 0; i <= bars; i++) {
          const bx = x0 - pad * 2.4 + ((winW + pad * 4.8) * i) / bars;
          ctx.moveTo(bx, by0); ctx.lineTo(bx, by0 + bh);
        }
        ctx.stroke();
        // Handrail
        ctx.fillStyle = 'rgba(30,28,26,0.95)';
        ctx.fillRect(x0 - pad * 2.8, by0 - S * 0.008, winW + pad * 5.6, S * 0.012);
      }

      // Emissive pass — only lit windows glow.
      if (lit) {
        ectx.fillStyle = hex(litColor);
        ectx.globalAlpha = 0.55 + rng() * 0.45;
        ectx.fillRect(x0, winY, winW, winH);
        if (arched) {
          ectx.beginPath();
          ectx.arc(cx, winY, winW / 2, Math.PI, 0);
          ectx.fill();
        }
        ectx.globalAlpha = 1;
      }

      // Roughness: glass is smooth, wall is not.
      rctx.fillStyle = lit ? '#5a5a5a' : '#2a2a2a';
      rctx.fillRect(x0 - pad, winY - pad, winW + pad * 2, winH + pad * 2);

      // Window recess in the height field.
      for (let y = Math.max(0, winY | 0); y < Math.min(S, (winY + winH) | 0); y++) {
        for (let x = Math.max(0, x0 | 0); x < Math.min(S, (x0 + winW) | 0); x++) {
          height[y * S + x] = 0.06;
        }
      }
    }

    // Floor band / cornice at the top of every storey.
    ctx.fillStyle = hex(trimColor);
    ctx.globalAlpha = 0.85;
    ctx.fillRect(0, 0, S, S * 0.045);
    ctx.fillRect(0, S - S * 0.035, S, S * 0.035);
    ctx.globalAlpha = 1;
    for (let y = 0; y < S * 0.045; y++) for (let x = 0; x < S; x++) height[y * S + x] = 0.95;

    return {
      map: toTexture(cv),
      normalMap: normalFromHeight(height, S, 1.5),
      roughnessMap: toTexture(rcv, { srgb: false }),
      emissiveMap: litRatio > 0 ? toTexture(ecv) : null,
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  PAVEMENT / KERB / COBBLE
// ════════════════════════════════════════════════════════════════════════════
export function makePavement(opts = {}) {
  const { size = 512, seed = 21, style = 'slab', color = 0x8e8a84 } = opts;
  return cached(`pave:${size}:${seed}:${style}:${color}`, () => {
    const S = size;
    const cv = canvas(S);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(S, S);
    const d = img.data;
    const height = new Float32Array(S * S);
    const rough = new Float32Array(S * S);
    const cr = (color >> 16) & 255, cg = (color >> 8) & 255, cb = color & 255;

    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        let lum = 1, h = 0.6, rg = 0.8;

        if (style === 'slab') {
          const n = 6;
          const bx = (u * n) % 1, by = (v * n) % 1;
          const joint = (bx < 0.025 || bx > 0.975 || by < 0.025 || by > 0.975) ? 1 : 0;
          const vary = noise2(Math.floor(u * n) * 3.3, Math.floor(v * n) * 7.1) * 0.5 + 0.5;
          const grain = fbm(u * 34, v * 34, 3) * 0.5 + 0.5;
          lum = joint ? 0.62 : 0.86 + (vary - 0.5) * 0.24 + (grain - 0.5) * 0.14;
          h = joint ? 0.2 : 0.75;
          rg = joint ? 0.92 : 0.80 - (grain - 0.5) * 0.1;
        } else if (style === 'cobble') {
          const w = worley(u * 22, v * 22);
          const edge = saturate((0.34 - w) * 6);
          const vary = noise2(u * 22, v * 22) * 0.5 + 0.5;
          lum = 0.55 + edge * 0.6 + (vary - 0.5) * 0.3;
          h = edge * 0.85 + 0.1;
          rg = 0.72 - edge * 0.14;
        } else if (style === 'granite') {
          const g = fbm(u * 60, v * 60, 4) * 0.5 + 0.5;
          const sp = worley(u * 90, v * 90);
          lum = 0.75 + (g - 0.5) * 0.4 + (1 - saturate(sp * 4)) * 0.28;
          h = 0.5 + (g - 0.5) * 0.2;
          rg = 0.55 + (g - 0.5) * 0.2;
        } else { // 'tile'
          const n = 10;
          const bx = (u * n) % 1, by = (v * n) % 1;
          const joint = (bx < 0.04 || by < 0.04) ? 1 : 0;
          const vary = noise2(Math.floor(u * n) * 4.1, Math.floor(v * n) * 2.9) * 0.5 + 0.5;
          lum = joint ? 0.7 : 0.9 + (vary - 0.5) * 0.16;
          h = joint ? 0.25 : 0.7;
          rg = joint ? 0.9 : 0.6;
        }

        const grime = fbm(u * 4 + 60, v * 4 + 60, 3) * 0.5 + 0.5;
        lum *= 0.88 + grime * 0.24;

        const i = (y * S + x) * 4;
        d[i] = clamp(cr * lum, 0, 255);
        d[i + 1] = clamp(cg * lum, 0, 255);
        d[i + 2] = clamp(cb * lum, 0, 255);
        d[i + 3] = 255;
        height[y * S + x] = h;
        rough[y * S + x] = clamp(rg, 0.2, 0.99);
      }
    }
    ctx.putImageData(img, 0, 0);
    return {
      map: toTexture(cv),
      normalMap: normalFromHeight(height, S, 2.0),
      roughnessMap: grayTexture(rough, S),
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  FOLIAGE
// ════════════════════════════════════════════════════════════════════════════
export function makeLeafCluster(opts = {}) {
  const { size = 256, seed = 4, color = 0x4a6b32, dark = 0x1d2c14, autumn = 0 } = opts;
  return cached(`leaf:${size}:${seed}:${color}:${dark}:${autumn}`, () => {
    const rng = makeRNG(seed);
    const S = size;
    const cv = canvas(S);
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, S, S);

    const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
    const autumnCols = ['#b5761f', '#c9932a', '#8f4a17', '#a8681c', '#6d7a24'];

    // Scatter leaf blobs in a rough disc so the cluster silhouette reads organic.
    const count = 240;
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.pow(rng(), 0.62) * S * 0.47;
      const x = S / 2 + Math.cos(a) * r;
      const y = S / 2 + Math.sin(a) * r * 0.92;
      const s = (1 - r / (S * 0.5)) * S * 0.085 + S * 0.018;
      const t = rng();
      let col;
      if (autumn > 0 && rng() < autumn) col = autumnCols[(rng() * autumnCols.length) | 0];
      else {
        const mix = t * 0.8;
        const r1 = lerp((dark >> 16) & 255, (color >> 16) & 255, mix);
        const g1 = lerp((dark >> 8) & 255, (color >> 8) & 255, mix);
        const b1 = lerp(dark & 255, color & 255, mix);
        col = `rgb(${r1 | 0},${g1 | 0},${b1 | 0})`;
      }
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.55 + rng() * 0.45;
      ctx.beginPath();
      ctx.ellipse(x, y, s, s * (0.6 + rng() * 0.5), rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Soften the outline so alpha-tested edges don't look like confetti.
    const img = ctx.getImageData(0, 0, S, S);
    const d = img.data;
    for (let i = 0; i < S * S; i++) {
      const a = d[i * 4 + 3];
      if (a > 0 && a < 90) d[i * 4 + 3] = 0;
    }
    ctx.putImageData(img, 0, 0);

    const t = toTexture(cv);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

export function makeBark(seed = 9, color = 0x4a3d30) {
  return cached(`bark:${seed}:${color}`, () => {
    const S = 256;
    const cv = canvas(S);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(S, S);
    const d = img.data;
    const height = new Float32Array(S * S);
    const cr = (color >> 16) & 255, cg = (color >> 8) & 255, cb = color & 255;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const n = ridge(u * 5, v * 34, 4);
        const g = fbm(u * 16, v * 40, 3) * 0.5 + 0.5;
        const lum = 0.6 + n * 0.7 + (g - 0.5) * 0.3;
        const i = (y * S + x) * 4;
        d[i] = clamp(cr * lum, 0, 255);
        d[i + 1] = clamp(cg * lum, 0, 255);
        d[i + 2] = clamp(cb * lum, 0, 255);
        d[i + 3] = 255;
        height[y * S + x] = saturate(n * 0.9 + (g - 0.5) * 0.3);
      }
    }
    ctx.putImageData(img, 0, 0);
    return { map: toTexture(cv), normalMap: normalFromHeight(height, S, 2.4) };
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  SIGNAGE / NEON / DECALS
// ════════════════════════════════════════════════════════════════════════════
export function makeSignTexture(opts = {}) {
  const {
    w = 512, h = 256, bg = '#0b0b10', text = 'TOKYO', color = '#ff2a6d',
    font = 'bold 120px Barlow Condensed, Impact, sans-serif',
    vertical = false, glow = true, sub = '', border = null,
  } = opts;
  const cv = canvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = Math.max(2, h * 0.03);
    ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - ctx.lineWidth * 2, h - ctx.lineWidth * 2);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = font;
  if (glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = Math.max(10, h * 0.14);
  }
  ctx.fillStyle = color;
  if (vertical) {
    const chars = [...text];
    const step = h / (chars.length + 0.4);
    ctx.font = `bold ${Math.min(step * 0.86, w * 0.72) | 0}px Barlow Condensed, Impact, sans-serif`;
    chars.forEach((ch, i) => ctx.fillText(ch, w / 2, step * (i + 0.7)));
  } else {
    ctx.fillText(text, w / 2, sub ? h * 0.40 : h / 2);
    if (sub) {
      ctx.font = `500 ${(h * 0.16) | 0}px Barlow, sans-serif`;
      ctx.fillText(sub, w / 2, h * 0.74);
    }
  }
  ctx.shadowBlur = 0;
  return toTexture(cv, { wrap: THREE.ClampToEdgeWrapping });
}

/** Water-spray / smoke sprite. */
export function makeSmokeSprite(seed = 2) {
  return cached(`smoke:${seed}`, () => {
    const S = 128;
    const cv = canvas(S);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x / S - 0.5) * 2, v = (y / S - 0.5) * 2;
        const r = Math.hypot(u, v);
        const n = fbm(x / S * 5 + seed * 13, y / S * 5 + seed * 7, 4) * 0.5 + 0.5;
        const a = saturate((1 - r) * 1.5) * (0.42 + n * 0.72);
        const i = (y * S + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = clamp(a * 255, 0, 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    const t = toTexture(cv);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Soft round sprite used for headlight/taillight glows and sparks. */
export function makeGlowSprite(hardness = 0.2) {
  return cached(`glow:${hardness}`, () => {
    const S = 128;
    const cv = canvas(S);
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(hardness, 'rgba(255,255,255,0.82)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.22)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    const t = toTexture(cv);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Long horizontal light-bar gradient (modern LED tail lights). */
export function makeBarGlow() {
  return cached('bargow', () => {
    const W = 256, H = 64;
    const cv = canvas(W, H);
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.42, 'rgba(255,255,255,0.85)');
    grd.addColorStop(0.5, 'rgba(255,255,255,1)');
    grd.addColorStop(0.58, 'rgba(255,255,255,0.85)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    const t = toTexture(cv);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Raindrop streak texture for the rain particle system. */
export function makeRainStreak() {
  return cached('rain', () => {
    const W = 16, H = 128;
    const cv = canvas(W, H);
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.35, 'rgba(210,228,255,0.55)');
    grd.addColorStop(0.75, 'rgba(230,240,255,0.85)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(W * 0.32, 0, W * 0.36, H);
    const t = toTexture(cv);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

export { toTexture, normalFromHeight, canvas };
