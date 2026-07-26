import { clamp, lerp, TAU, formatTime, damp } from '../core/math.js';

/**
 * In-race HUD.
 * DOM handles the text (crisp at any DPI), canvas handles the tach dial and
 * the rotating minimap.
 */
export class HUD {
  constructor() {
    this.root = document.getElementById('hud');
    this.el = {
      timeLeft: document.getElementById('hTimeLeft'),
      star3: document.getElementById('hStar3'),
      current: document.getElementById('hCurrent'),
      objective: document.getElementById('hObjective'),
      lap: document.getElementById('hLap'),
      lapLine: document.getElementById('hLapLine'),
      pos: document.getElementById('hPos'),
      dist: document.getElementById('hDist'),
      speed: document.getElementById('hSpeed'),
      gear: document.getElementById('hGear'),
      notice: document.getElementById('hNotice'),
      count: document.getElementById('hCount'),
      skill: document.getElementById('hSkill'),
      boost: document.getElementById('hBoost'),
      name: document.getElementById('hName'),
      abs: document.getElementById('aABS'),
      tcr: document.getElementById('aTCR'),
      stm: document.getElementById('aSTM'),
    };

    this.tach = document.getElementById('tach');
    this.tctx = this.tach.getContext('2d');
    this.map = document.getElementById('minimap');
    this.mctx = this.map.getContext('2d');

    this._needle = 0;
    this._speedShown = 0;
    this._lastSpeedTxt = '';
    this._lastPos = '';
    this._noticeTimer = 0;
    this._mapPath = null;
    this._mapBounds = null;

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const [cv, css] of [[this.tach, this.tach.clientWidth], [this.map, this.map.clientWidth]]) {
      const size = Math.max(80, css || 200);
      if (cv.width !== Math.round(size * dpr)) {
        cv.width = Math.round(size * dpr);
        cv.height = Math.round(size * dpr);
      }
    }
  }

  show(v) { this.root.classList.toggle('hidden', !v); }
  fade(v) { this.root.classList.toggle('fade', !!v); }

  setTrack(track) {
    this._mapPath = track.minimapPath(4);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of this._mapPath) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    this._mapBounds = { minX, maxX, minZ, maxZ };
    this._track = track;
  }

  setDriverName(n) { if (this.el.name) this.el.name.textContent = n; }

  notice(text, ms = 1800) {
    const n = this.el.notice;
    n.textContent = text;
    n.classList.add('show');
    clearTimeout(this._noticeTO);
    this._noticeTO = setTimeout(() => n.classList.remove('show'), ms);
  }

  countdown(text, isGo = false) {
    const c = this.el.count;
    c.textContent = text;
    c.classList.toggle('go', isGo);
    c.classList.remove('pop');
    void c.offsetWidth;   // restart the animation
    c.classList.add('pop');
  }

  skill(label, points) {
    const d = document.createElement('div');
    d.className = 'sf';
    d.innerHTML = points ? `${label}<b>+${points}</b>` : label;
    this.el.skill.appendChild(d);
    setTimeout(() => d.remove(), 1600);
    while (this.el.skill.children.length > 5) this.el.skill.firstChild.remove();
  }

  /**
   * @param {object} s  full HUD state
   */
  update(dt, s) {
    const E = this.el;

    // ── Objective panel ──────────────────────────────────────────────────
    if (s.timeLeft !== undefined) E.timeLeft.textContent = formatTime(s.timeLeft);
    if (s.starTime !== undefined) E.star3.textContent = formatTime(s.starTime);
    E.current.textContent = formatTime(s.current || 0);
    if (s.objective && E.objective.textContent !== s.objective) E.objective.textContent = s.objective;
    if (s.lapText) {
      E.lap.textContent = s.lapText;
      E.lapLine.style.display = '';
    } else {
      E.lapLine.style.display = 'none';
    }

    // ── Position ─────────────────────────────────────────────────────────
    const posTxt = `${s.position}<em>/</em>${s.fieldSize}`;
    if (posTxt !== this._lastPos) { E.pos.innerHTML = posTxt; this._lastPos = posTxt; }

    // ── Distance ─────────────────────────────────────────────────────────
    if (s.distance !== undefined) {
      const mi = s.distance / 1609.34;
      E.dist.textContent = mi >= 10 ? `${mi.toFixed(0)} MI` : `${mi.toFixed(1)} MI`;
    }

    // ── Speed / gear ─────────────────────────────────────────────────────
    this._speedShown = damp(this._speedShown, s.mph, 22, dt);
    const sp = Math.max(0, Math.round(this._speedShown));
    const spTxt = String(sp).padStart(3, '0');
    if (spTxt !== this._lastSpeedTxt) { E.speed.textContent = spTxt; this._lastSpeedTxt = spTxt; }

    const gearTxt = s.reversing ? 'R' : String(s.gear);
    if (E.gear.textContent !== gearTxt) E.gear.textContent = gearTxt;
    E.gear.classList.toggle('red', s.rpm > s.redline * 0.94);

    E.boost.style.width = `${clamp(s.boost / s.boostMax, 0, 1) * 100}%`;

    E.abs.classList.toggle('on', !!s.abs);
    E.tcr.classList.toggle('on', !!s.tcs);
    E.stm.classList.toggle('on', !!s.stm);

    // ── Canvases ─────────────────────────────────────────────────────────
    this._needle = damp(this._needle, clamp(s.rpm / s.redline, 0, 1.02), 16, dt);
    this.drawTach(this._needle, s);
    this.drawMinimap(s);
  }

  // ── TACH ────────────────────────────────────────────────────────────────
  drawTach(t, s) {
    const cv = this.tach, g = this.tctx;
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const cx = W * 0.5, cy = H * 0.5;
    const R = Math.min(W, H) * 0.47;

    const A0 = Math.PI * 0.75;          // lower-left
    const SWEEP = Math.PI * 1.5;        // 270° clockwise to lower-right
    const ang = (u) => A0 + u * SWEEP;

    // Backing wash so the dial reads over a bright road.
    const grd = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.05);
    grd.addColorStop(0, 'rgba(6,7,10,0.30)');
    grd.addColorStop(1, 'rgba(6,7,10,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(cx, cy, R * 1.05, 0, TAU); g.fill();

    const REDLINE_U = 0.815;

    // ── Fine tick ring ───────────────────────────────────────────────────
    const ticks = 90;
    for (let i = 0; i <= ticks; i++) {
      const u = i / ticks;
      const a = ang(u);
      const major = i % 10 === 0;
      const mid = i % 5 === 0;
      const len = major ? R * 0.135 : mid ? R * 0.085 : R * 0.055;
      const w = major ? R * 0.020 : mid ? R * 0.012 : R * 0.0075;
      const inRed = u >= REDLINE_U;
      g.strokeStyle = inRed
        ? (t >= u ? 'rgba(255,70,52,0.98)' : 'rgba(228,58,42,0.86)')
        : (t >= u ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.34)');
      g.lineWidth = w;
      g.lineCap = 'butt';
      const r0 = R * 0.995;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * (r0 - len), cy + Math.sin(a) * (r0 - len));
      g.stroke();
    }

    // ── Redline arc ──────────────────────────────────────────────────────
    g.strokeStyle = 'rgba(226,44,32,0.95)';
    g.lineWidth = R * 0.035;
    g.beginPath();
    g.arc(cx, cy, R * 0.905, ang(REDLINE_U), ang(1.0));
    g.stroke();

    // ── Numerals ─────────────────────────────────────────────────────────
    const fs = R * 0.145;
    g.font = `500 ${fs}px 'Barlow Condensed','Arial Narrow',sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let n = 0; n <= 9; n++) {
      const u = n / 9;
      const a = ang(u);
      const rr = R * 0.755;
      g.fillStyle = u >= REDLINE_U ? 'rgba(255,86,66,0.92)' : 'rgba(255,255,255,0.66)';
      g.fillText(String(n), cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }

    // ── Needle ───────────────────────────────────────────────────────────
    const na = ang(clamp(t, 0, 1));
    g.save();
    g.translate(cx, cy);
    g.rotate(na);
    g.shadowColor = 'rgba(0,0,0,0.65)';
    g.shadowBlur = R * 0.06;
    g.fillStyle = t >= REDLINE_U ? '#ff5a44' : '#ffffff';
    g.beginPath();
    g.moveTo(-R * 0.055, -R * 0.021);
    g.lineTo(R * 0.965, -R * 0.010);
    g.lineTo(R * 0.965, R * 0.010);
    g.lineTo(-R * 0.055, R * 0.021);
    g.closePath();
    g.fill();
    g.restore();

    // Hub
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(10,11,14,0.55)';
    g.beginPath(); g.arc(cx, cy, R * 0.30, 0, TAU); g.fill();
  }

  // ── MINIMAP ─────────────────────────────────────────────────────────────
  drawMinimap(s) {
    if (!this._mapPath) return;
    const cv = this.map, g = this.mctx;
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) / 2 - 1;

    // Circular mask
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.clip();

    // Backing
    const grd = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    grd.addColorStop(0, 'rgba(8,10,14,0.44)');
    grd.addColorStop(0.72, 'rgba(8,10,14,0.34)');
    grd.addColorStop(1, 'rgba(8,10,14,0.02)');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);

    // World → map: rotate so the player's heading points up.
    const scale = (R * 2) / (s.mapRange ?? 420);
    const hd = s.heading ?? 0;
    const cos = Math.cos(-hd), sin = Math.sin(-hd);
    const px = s.playerX ?? 0, pz = s.playerZ ?? 0;
    // Player sits below centre so you see more of the road ahead.
    const originY = cy + R * 0.30;

    const proj = (x, z) => {
      const dx = (x - px) * scale, dz = (z - pz) * scale;
      // World +Z maps to screen −Y after the heading rotation.
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      return [cx + rx, originY - rz];
    };

    // ── Route ────────────────────────────────────────────────────────────
    const path = this._mapPath;
    // Casing
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = R * 0.145;
    g.beginPath();
    for (let i = 0; i < path.length; i++) {
      const [x, y] = proj(path[i][0], path[i][1]);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();

    // Full route (dimmed)
    g.strokeStyle = 'rgba(225,235,245,0.34)';
    g.lineWidth = R * 0.095;
    g.stroke();

    // Upcoming section highlighted, the way a nav route reads.
    if (this._track) {
      const tk = this._track;
      const s0 = s.trackS ?? 0;
      g.strokeStyle = '#54dcf0';
      g.lineWidth = R * 0.105;
      g.shadowColor = 'rgba(84,220,240,0.7)';
      g.shadowBlur = R * 0.14;
      g.beginPath();
      const ahead = (s.mapRange ?? 420) * 0.85;
      for (let d = -14; d <= ahead; d += 8) {
        const a = tk.at(s0 + d);
        const [x, y] = proj(a.pos.x, a.pos.z);
        if (d === -14) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      g.shadowBlur = 0;
    }

    // ── Rivals ───────────────────────────────────────────────────────────
    for (const r of s.rivals || []) {
      const [x, y] = proj(r.x, r.z);
      g.fillStyle = r.isPlayer ? '#fff' : 'rgba(255,255,255,0.82)';
      g.beginPath();
      g.arc(x, y, R * 0.052, 0, TAU);
      g.fill();
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.beginPath();
      g.arc(x, y, R * 0.052, 0, TAU);
      g.lineWidth = R * 0.014;
      g.strokeStyle = 'rgba(0,0,0,0.75)';
      g.stroke();
    }

    g.restore();

    // ── Ring ─────────────────────────────────────────────────────────────
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = Math.max(1, R * 0.014);
    g.beginPath(); g.arc(cx, cy, R - g.lineWidth / 2, 0, TAU); g.stroke();

    // ── Player arrow ─────────────────────────────────────────────────────
    g.save();
    g.translate(cx, originY);
    g.shadowColor = 'rgba(0,0,0,0.75)';
    g.shadowBlur = R * 0.1;
    g.fillStyle = '#ffffff';
    const a = R * 0.135;
    g.beginPath();
    g.moveTo(0, -a * 1.5);
    g.lineTo(a * 0.95, a * 0.95);
    g.lineTo(0, a * 0.42);
    g.lineTo(-a * 0.95, a * 0.95);
    g.closePath();
    g.fill();
    g.restore();
  }
}
