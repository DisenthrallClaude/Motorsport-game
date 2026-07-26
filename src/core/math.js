// ────────────────────────────────────────────────────────────────────────────
//  Small math / random toolkit shared by every subsystem.
//  Everything here is deterministic where it matters so a given track seed
//  always rebuilds the exact same city.
// ────────────────────────────────────────────────────────────────────────────

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);
export const saturate = (v) => clamp(v, 0, 1);
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/** Frame-rate independent exponential smoothing. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Shortest signed angular difference, result in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Move `cur` toward `target` by at most `maxStep`. */
export function approach(cur, target, maxStep) {
  const d = target - cur;
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}

// ── Deterministic PRNG (mulberry32) ─────────────────────────────────────────
export function makeRNG(seed = 1) {
  let a = seed >>> 0;
  const fn = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  fn.range = (lo, hi) => lo + fn() * (hi - lo);
  fn.int = (lo, hi) => Math.floor(lo + fn() * (hi - lo + 1));
  fn.pick = (arr) => arr[Math.floor(fn() * arr.length) % arr.length];
  fn.chance = (p) => fn() < p;
  fn.sign = () => (fn() < 0.5 ? -1 : 1);
  /** Weighted pick — weights is an array of numbers matching arr. */
  fn.weighted = (arr, weights) => {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = fn() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  };
  return fn;
}

// ── Value noise (smooth, tileable-ish) ──────────────────────────────────────
const NOISE_SIZE = 256;
function buildPermutation(seed) {
  const rng = makeRNG(seed);
  const p = new Uint8Array(NOISE_SIZE * 2);
  const src = new Uint8Array(NOISE_SIZE);
  for (let i = 0; i < NOISE_SIZE; i++) src[i] = i;
  for (let i = NOISE_SIZE - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = src[i]; src[i] = src[j]; src[j] = t;
  }
  for (let i = 0; i < NOISE_SIZE * 2; i++) p[i] = src[i & 255];
  return p;
}

const PERM = buildPermutation(1337);
const GRAD2 = new Float32Array(NOISE_SIZE * 2);
for (let i = 0; i < NOISE_SIZE; i++) {
  const a = (i / NOISE_SIZE) * TAU + 0.31;
  GRAD2[i * 2] = Math.cos(a);
  GRAD2[i * 2 + 1] = Math.sin(a);
}

/** 2D gradient noise in roughly [-1, 1]. */
export function noise2(x, y) {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = smootherstep(xf);
  const v = smootherstep(yf);

  const dot = (gi, dx, dy) => GRAD2[gi * 2] * dx + GRAD2[gi * 2 + 1] * dy;
  const aa = PERM[PERM[xi] + yi];
  const ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi];
  const bb = PERM[PERM[xi + 1] + yi + 1];

  const x1 = lerp(dot(aa, xf, yf), dot(ba, xf - 1, yf), u);
  const x2 = lerp(dot(ab, xf, yf - 1), dot(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v);
}

/** Fractal Brownian motion on top of noise2. */
export function fbm(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal — good for cracked asphalt & marble veins. */
export function ridge(x, y, octaves = 4) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(x * freq, y * freq));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Cheap hash → [0,1). Stable across runs. */
export function hash2(x, y) {
  let h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}

/** Worley / cellular noise F1 distance, used for cobbles and puddles. */
export function worley(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 8;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const px = cx + hash2(cx, cy);
      const py = cy + hash2(cy * 7.3, cx * 3.1);
      const dx = px - x, dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

// ── Colour helpers ──────────────────────────────────────────────────────────
export function hexLerp(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return ((lerp(ar, br, t) | 0) << 16) | ((lerp(ag, bg, t) | 0) << 8) | (lerp(ab, bb, t) | 0);
}

export function hsl(h, s, l) {
  h = ((h % 1) + 1) % 1;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
  };
  return `rgb(${Math.round(f(0) * 255)},${Math.round(f(8) * 255)},${Math.round(f(4) * 255)})`;
}

// ── Formatting ──────────────────────────────────────────────────────────────
export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function formatDelta(sec) {
  const sign = sec >= 0 ? '+' : '-';
  const a = Math.abs(sec);
  return `${sign}${a.toFixed(3)}`;
}
