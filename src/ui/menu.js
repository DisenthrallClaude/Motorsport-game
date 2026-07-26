import { THEMES } from '../data/themes.js';
import { makeRNG, TAU, lerp, clamp } from '../core/math.js';

/**
 * Destination select. Each card gets a procedurally drawn "postcard" built
 * from that city's own sky palette and landmark silhouettes, so the menu
 * previews match what you actually get in-game.
 */
export class Menu {
  constructor(onStart) {
    this.onStart = onStart;
    this.root = document.getElementById('menu');
    this.rail = document.getElementById('destRail');
    this.selected = 0;
    this.options = { laps: 2, rivals: 5, quality: 'high', assists: true };

    this._buildRail();
    this._bindOptions();
    document.getElementById('raceBtn').addEventListener('click', () => {
      this.onStart(THEMES[this.selected], { ...this.options });
    });
    this.select(0);
  }

  show(v) {
    this.root.classList.toggle('hidden', !v);
  }

  _buildRail() {
    this.cards = [];
    THEMES.forEach((t, i) => {
      const card = document.createElement('div');
      card.className = 'dest';
      const cv = document.createElement('canvas');
      cv.width = 440; cv.height = 280;
      drawPostcard(cv, t);
      card.appendChild(cv);
      const shade = document.createElement('div');
      shade.className = 'dest-shade';
      card.appendChild(shade);
      const nm = document.createElement('div');
      nm.className = 'dest-name';
      nm.textContent = t.name;
      card.appendChild(nm);
      const sub = document.createElement('div');
      sub.className = 'dest-sub';
      sub.textContent = t.circuit;
      card.appendChild(sub);
      const num = document.createElement('div');
      num.className = 'dest-num';
      num.textContent = String(i + 1).padStart(2, '0');
      card.appendChild(num);
      card.addEventListener('click', () => this.select(i));
      this.rail.appendChild(card);
      this.cards.push(card);
    });
  }

  _bindOptions() {
    const wire = (id, key, cast = (v) => v) => {
      const seg = document.getElementById(id);
      if (!seg) return;
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        [...seg.children].forEach((c) => c.classList.remove('on'));
        b.classList.add('on');
        this.options[key] = cast(b.dataset.v);
      });
    };
    wire('segLaps', 'laps', Number);
    wire('segRivals', 'rivals', Number);
    wire('segQual', 'quality');
    wire('segAssist', 'assists', (v) => v === 'on');
  }

  select(i) {
    this.selected = clamp(i, 0, THEMES.length - 1);
    this.cards.forEach((c, k) => c.classList.toggle('on', k === this.selected));
    const t = THEMES[this.selected];
    document.getElementById('mdCity').textContent = t.name;
    document.getElementById('mdCountry').textContent = t.country;
    document.getElementById('mdDesc').textContent = t.blurb;
    document.getElementById('mdWx').textContent = t.weatherLabel;
    document.getElementById('mdTime').textContent = t.timeLabel;

    // Estimate circuit length and corner count from the control points.
    const pts = t.track.points;
    let len = 0;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length];
      len += Math.hypot(b[0] - a[0], b[2] - a[2]);
    }
    len *= 1.06;   // splines are longer than their control polygon
    document.getElementById('mdLen').textContent = `${(len / 1000).toFixed(2)} KM`;
    document.getElementById('mdTurns').textContent = String(countTurns(pts));

    this.cards[this.selected].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
}

function countTurns(pts) {
  let turns = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length];
    const b = pts[i];
    const c = pts[(i + 1) % pts.length];
    const h1 = Math.atan2(b[0] - a[0], b[2] - a[2]);
    const h2 = Math.atan2(c[0] - b[0], c[2] - b[2]);
    let d = h2 - h1;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    if (Math.abs(d) > 0.20) turns++;
  }
  return turns;
}

/** Paint a small stylised view of the city using its own theme colours. */
function drawPostcard(cv, theme) {
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const rng = makeRNG((theme.buildings?.seed ?? 1) * 31 + 7);
  const hex = (c) => `#${(c >>> 0).toString(16).padStart(6, '0')}`;

  // Sky gradient from the theme's zenith → horizon.
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, hex(theme.sky.zenith));
  sky.addColorStop(0.62, hex(theme.sky.horizon));
  sky.addColorStop(1, hex(theme.sky.groundHaze ?? theme.sky.horizon));
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);

  // Sun glow
  const sunX = W * (0.5 + Math.sin((theme.sky.sunAzimuth * Math.PI) / 180) * 0.32);
  const sunY = H * (0.72 - clamp(theme.sky.sunElevation / 60, -0.2, 1) * 0.5);
  const glow = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, W * 0.5);
  glow.addColorStop(0, hexA(theme.sky.sunColor, 0.85));
  glow.addColorStop(0.25, hexA(theme.sky.sunColor, 0.30));
  glow.addColorStop(1, hexA(theme.sky.sunColor, 0));
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  // Distant skyline
  const horizon = H * 0.74;
  const layers = 3;
  for (let l = layers - 1; l >= 0; l--) {
    const shade = theme.night ? 0.12 + l * 0.05 : 0.30 - l * 0.07;
    g.fillStyle = mixHex(theme.sky.horizon, theme.night ? 0x0a0d16 : 0x1a2028, 1 - shade);
    g.globalAlpha = 0.55 + l * 0.16;
    let x = -20;
    while (x < W + 20) {
      const w = 16 + rng() * 44;
      const h = (18 + Math.pow(rng(), 2) * 120) * (1 - l * 0.22);
      g.fillRect(x, horizon - h - l * 8, w, h + 40);
      if (theme.night && rng() < 0.7) {
        g.fillStyle = hexA(0xffd9a0, 0.30);
        for (let k = 0; k < 6; k++) {
          if (rng() < 0.45) g.fillRect(x + 3 + rng() * (w - 8), horizon - h + rng() * h, 2.5, 3.5);
        }
        g.fillStyle = mixHex(theme.sky.horizon, 0x0a0d16, 1 - shade);
      }
      x += w + 4 + rng() * 14;
    }
    g.globalAlpha = 1;
  }

  // A landmark silhouette so each city is instantly identifiable.
  g.fillStyle = theme.night ? 'rgba(12,14,22,0.92)' : 'rgba(26,30,38,0.72)';
  drawLandmarkSilhouette(g, theme.id, W * 0.68, horizon, H * 0.62);

  // Road running into the frame
  const roadTop = horizon - 2;
  g.beginPath();
  g.moveTo(W * 0.5 - 8, roadTop);
  g.lineTo(W * 0.5 + 8, roadTop);
  g.lineTo(W * 1.06, H);
  g.lineTo(W * -0.06, H);
  g.closePath();
  const rg = g.createLinearGradient(0, roadTop, 0, H);
  rg.addColorStop(0, mixHex(theme.sky.horizon, 0x1c1e22, 0.55));
  rg.addColorStop(1, hex(theme.road?.asphaltColor ?? 0x2c2d31));
  g.fillStyle = rg;
  g.fill();

  // Wet sheen / centre line
  if ((theme.road?.wetness ?? 0) > 0.4) {
    const sh = g.createLinearGradient(0, roadTop, 0, H);
    sh.addColorStop(0, hexA(theme.sky.horizon, 0.55));
    sh.addColorStop(0.5, hexA(theme.sky.sunColor, 0.16));
    sh.addColorStop(1, hexA(theme.sky.horizon, 0.02));
    g.globalCompositeOperation = 'screen';
    g.fillStyle = sh;
    g.fill();
    g.globalCompositeOperation = 'source-over';
  }
  g.strokeStyle = 'rgba(235,232,222,0.5)';
  g.lineWidth = 2;
  g.setLineDash([9, 12]);
  g.beginPath();
  g.moveTo(W * 0.5, roadTop);
  g.lineTo(W * 0.5, H);
  g.stroke();
  g.setLineDash([]);

  // Vignette
  const vg = g.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.95);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  g.fillStyle = vg;
  g.fillRect(0, 0, W, H);
}

function drawLandmarkSilhouette(g, id, x, baseY, size) {
  const s = size;
  g.save();
  g.translate(x, baseY);
  switch (id) {
    case 'london': {   // Elizabeth Tower
      const w = s * 0.13;
      g.fillRect(-w / 2, -s * 0.78, w, s * 0.78);
      g.fillRect(-w * 0.62, -s * 0.60, w * 1.24, s * 0.10);
      g.beginPath();
      g.moveTo(-w * 0.62, -s * 0.80);
      g.lineTo(w * 0.62, -s * 0.80);
      g.lineTo(0, -s * 1.10);
      g.closePath(); g.fill();
      g.fillRect(-w * 0.03, -s * 1.18, w * 0.06, s * 0.10);
      break;
    }
    case 'paris': {    // Eiffel
      g.beginPath();
      g.moveTo(-s * 0.20, 0);
      g.quadraticCurveTo(-s * 0.07, -s * 0.5, -s * 0.035, -s * 1.02);
      g.lineTo(s * 0.035, -s * 1.02);
      g.quadraticCurveTo(s * 0.07, -s * 0.5, s * 0.20, 0);
      g.closePath(); g.fill();
      g.fillRect(-s * 0.145, -s * 0.30, s * 0.29, s * 0.030);
      g.fillRect(-s * 0.085, -s * 0.62, s * 0.17, s * 0.026);
      g.fillRect(-s * 0.008, -s * 1.14, s * 0.016, s * 0.13);
      break;
    }
    case 'tokyo': {    // Tokyo Tower
      g.beginPath();
      g.moveTo(-s * 0.17, 0);
      g.quadraticCurveTo(-s * 0.055, -s * 0.5, -s * 0.028, -s * 0.94);
      g.lineTo(s * 0.028, -s * 0.94);
      g.quadraticCurveTo(s * 0.055, -s * 0.5, s * 0.17, 0);
      g.closePath(); g.fill();
      g.fillRect(-s * 0.11, -s * 0.34, s * 0.22, s * 0.05);
      g.fillRect(-s * 0.06, -s * 0.70, s * 0.12, s * 0.038);
      g.fillRect(-s * 0.006, -s * 1.08, s * 0.012, s * 0.15);
      break;
    }
    case 'beijing': {  // CCTV loop
      g.fillRect(-s * 0.34, -s * 0.62, s * 0.13, s * 0.62);
      g.fillRect(s * 0.19, -s * 0.62, s * 0.13, s * 0.62);
      g.fillRect(-s * 0.34, -s * 0.80, s * 0.66, s * 0.19);
      break;
    }
    case 'newyork': {  // Deco spire
      let y = 0, w = s * 0.30;
      for (let i = 0; i < 5; i++) {
        const h = s * (0.20 - i * 0.026);
        g.fillRect(-w / 2, -y - h, w, h);
        y += h; w *= 0.80;
      }
      g.fillRect(-s * 0.010, -y - s * 0.22, s * 0.020, s * 0.22);
      break;
    }
    case 'dubai': {    // Sail
      g.beginPath();
      g.moveTo(-s * 0.05, 0);
      g.quadraticCurveTo(s * 0.30, -s * 0.36, s * 0.10, -s * 1.02);
      g.lineTo(-s * 0.02, -s * 1.02);
      g.quadraticCurveTo(s * 0.09, -s * 0.40, -s * 0.05, 0);
      g.closePath(); g.fill();
      break;
    }
    default: break;
  }
  g.restore();
}

function hexA(c, a) {
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}
function mixHex(a, b, t) {
  const r = lerp((a >> 16) & 255, (b >> 16) & 255, t) | 0;
  const g = lerp((a >> 8) & 255, (b >> 8) & 255, t) | 0;
  const bl = lerp(a & 255, b & 255, t) | 0;
  return `rgb(${r},${g},${bl})`;
}
