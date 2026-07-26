import * as THREE from 'three';
import { Track } from './track.js';
import { GeoBatcher, InstanceSet } from './batch.js';
import { BuildingKit, makeBuilding, trimBox, frustum, wallShell } from './buildings.js';
import { PropKit } from './props.js';
import * as LM from './landmarks.js';
import { makeSignTexture, makePavement, canvas, toTexture, makeGlowSprite } from '../render/textures.js';
import { makeSurface } from '../render/materials.js';
import { LAYER } from '../render/postfx.js';
import { makeRNG, clamp, lerp, TAU, saturate } from '../core/math.js';

/**
 * Assembles a complete city from a theme.
 * Everything is generated once at load time and merged down to a handful of
 * draw calls; nothing here runs per frame.
 */
export class World {
  constructor(theme, onProgress = () => {}) {
    this.theme = theme;
    this.onProgress = onProgress;
    this.group = new THREE.Group();
    this.group.name = `world:${theme.id}`;
    this.roadMaterials = [];
    this.rng = makeRNG(theme.buildings?.seed ?? 1);
    this.disposables = [];
  }

  async build() {
    const P = this.onProgress;
    const theme = this.theme;

    P(0.05, 'PLOTTING CIRCUIT');
    this.track = new Track({ ...theme.track, name: theme.circuit });
    await tick();

    P(0.14, 'PAVING ROADS');
    const surf = this.track.buildSurface(theme);
    this.group.add(surf.group);
    this.roadMaterials = surf.roadMaterials;
    await tick();

    P(0.22, 'CASTING GROUND');
    this._buildGround();
    await tick();

    this._landmarkSpots = this._computeLandmarkSpots();

    P(0.32, 'RAISING ARCHITECTURE');
    this.kit = new BuildingKit(theme, makeRNG((theme.buildings?.seed ?? 1) * 7 + 3));
    this.props = new PropKit(theme, makeRNG((theme.buildings?.seed ?? 1) * 13 + 5));
    await tick();
    this._buildBuildings();
    await tick();

    P(0.58, 'DRESSING STREETS');
    this._buildProps();
    await tick();

    P(0.72, 'PLACING LANDMARKS');
    this._buildLandmarks();
    await tick();

    P(0.82, 'ADDING DETAIL');
    this._buildCrossings();
    this._buildSkylineRing();
    if (theme.river) this._buildRiver();
    await tick();

    P(0.9, 'BAKING LIGHTING');
    this.racingLine = this.track.buildRacingLine(1.0);
    this.speedProfile = this.track.buildSpeedProfile(theme.grip ?? 16.5, theme.vmax ?? 95);
    await tick();

    return this;
  }

  /** World-space keep-out circles so no lot is built on top of a landmark. */
  _computeLandmarkSpots() {
    const out = [];
    for (const L of this.theme.landmarks || []) {
      if (L.skip) continue;
      const a = this.track.at((L.s ?? 0) * this.track.length);
      const p = L.pos
        ? new THREE.Vector3(L.pos[0], 0, L.pos[2])
        : new THREE.Vector3().copy(a.pos).addScaledVector(a.right, L.lateral);
      out.push({ p, r: L.clear ?? DEFAULT_CLEAR[L.type] ?? 60 });
    }
    return out;
  }

  // ── Ground plane + city-block filler ────────────────────────────────────
  _buildGround() {
    const t = this.theme;
    const b = this.track.bounds;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const size = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 1800;

    const pav = makePavement({
      style: t.road.pavementStyle ?? 'slab',
      color: t.road.groundColor ?? 0x6e6a64,
      seed: 99,
    });
    const mat = makeSurface(pav, {
      repeat: [size / 6, size / 6], roughness: 0.92, envMapIntensity: 0.35,
      color: t.road.groundTint ?? 0x8a8880,
    });
    const g = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 1, 1), mat);
    g.rotation.x = -Math.PI / 2;
    g.position.set(cx, -0.35, cz);
    g.receiveShadow = true;
    this.group.add(g);
    this.groundMesh = g;
  }

  // ── Buildings along both sides of the circuit ───────────────────────────
  _buildBuildings() {
    const theme = this.theme;
    const B = theme.buildings;
    const rng = makeRNG((B.seed ?? 1) * 977 + 17);
    const batcher = new GeoBatcher();
    const track = this.track;

    // Shop / neon sign textures reused across the whole city.
    const signTex = (B.signs || []).map((s, i) => makeSignTexture({
      w: 512, h: 96, text: s,
      bg: theme.night ? '#0a0a10' : '#14151a',
      color: theme.night
        ? '#' + (B.neonColors?.[i % (B.neonColors?.length || 1)] ?? 0xffffff).toString(16).padStart(6, '0')
        : '#e8e2d4',
      font: 'bold 58px Barlow Condensed, Impact, sans-serif',
      glow: !!theme.night,
    }));
    const vertTex = (B.verticalSigns || []).map((s, i) => makeSignTexture({
      w: 128, h: 384, text: s, vertical: true,
      bg: '#0a0a10',
      color: '#' + (B.neonColors?.[(i + 2) % (B.neonColors?.length || 1)] ?? 0xff2a6d).toString(16).padStart(6, '0'),
      glow: true, border: 'rgba(255,255,255,0.25)',
    }));
    this.disposables.push(...signTex, ...vertTex);

    const styleList = B.styles || [{ style: 'block', weight: 1, hMin: 16, hMax: 30 }];
    const totalW = styleList.reduce((a, s) => a + s.weight, 0);
    const pickStyle = () => {
      let r = rng() * totalW;
      for (const s of styleList) { r -= s.weight; if (r <= 0) return s; }
      return styleList[0];
    };

    // All row offsets below are measured outward from the kerb line; the
    // half-width of the road is added at placement time because the road
    // narrows through corners.
    const pavEdge = 0.34 + (theme.road.pavementWidth ?? 4.5) + 0.5;
    const rows = [
      { off: pavEdge + (B.setback ?? 1.5), depth: B.depth ?? 20, hScale: 1.0, front: true },
    ];
    for (let r = 1; r <= (B.backRows ?? 0); r++) {
      rows.push({
        off: pavEdge + (B.setback ?? 1.5) + (B.depth ?? 20) + r * ((B.backDepth ?? 26) + 6),
        depth: B.backDepth ?? 26,
        hScale: 1.0 + r * 0.35,
        front: false,
      });
    }

    let placed = 0;
    for (const side of [-1, 1]) {
      for (const row of rows) {
        let s = rng() * 20;
        let guard = 0;
        while (s < track.length && guard++ < 4000) {
          const a = track.at(s);
          const lotW = lerp(B.lotMin ?? 12, B.lotMax ?? 26, rng());
          const offset = a.width * 0.5 + row.off + row.depth / 2;
          // Inside-of-corner compression: shrink the step so lots never overlap.
          const compress = clamp(1 - a.curvature * offset * side, 0.25, 2.4);
          const step = lotW / compress;

          if (rng() < (B.gapChance ?? 0.05) || compress < 0.42) {
            s += Math.max(6, step * 0.6);
            continue;
          }

          const lotPos = new THREE.Vector3()
            .copy(a.pos)
            .addScaledVector(a.right, side * (a.width * 0.5 + row.off + row.depth / 2));
          let blocked = false;
          for (const spot of this._landmarkSpots) {
            const dx = lotPos.x - spot.p.x, dz = lotPos.z - spot.p.z;
            if (dx * dx + dz * dz < spot.r * spot.r) { blocked = true; break; }
          }
          if (blocked) { s += Math.max(8, step * 0.7); continue; }

          const st = pickStyle();
          const h = lerp(st.hMin, st.hMax, Math.pow(rng(), row.front ? 1.0 : 0.65)) * row.hScale;
          const depth = row.depth * lerp(0.85, 1.25, rng());

          const g = makeBuilding(this.kit, rng, {
            style: st.style,
            w: lotW * 0.97,
            d: depth,
            h,
            facade: this.kit.pickFacade(rng),
            sign: row.front && signTex.length && rng() < 0.75
              ? signTex[(rng() * signTex.length) | 0] : null,
            verticalSigns: row.front && vertTex.length && rng() < 0.55
              ? [vertTex[(rng() * vertTex.length) | 0], vertTex[(rng() * vertTex.length) | 0]] : null,
            signSide: side,
            awning: row.front ? 0.35 : 0,
          });

          g.position.copy(lotPos);
          g.position.y = a.pos.y - 0.05;
          // Turn the shopfront (local +Z) to face the road.
          g.rotation.y = a.heading + (side > 0 ? Math.PI / 2 : -Math.PI / 2);
          batcher.addObject(g);
          disposeTree(g);
          placed++;

          s += step;
        }
      }
    }

    const built = batcher.build('buildings');
    this.group.add(built);
    this.buildingCount = placed;
  }

  // ── Street furniture ────────────────────────────────────────────────────
  _buildProps() {
    const theme = this.theme;
    const P = theme.props || {};
    const track = this.track;
    const rng = makeRNG(4242 + (theme.buildings?.seed ?? 1));
    const batcher = new GeoBatcher();
    const kit = this.props;
    const pavEdge = (theme.road.pavementWidth ?? 4.5);
    // Distances from the kerb line outward across the pavement.
    const lampOff = 0.34 + pavEdge * 0.32;
    const outerOff = 0.34 + pavEdge * 0.76;

    // Convention: a prop's local +X points at the road, local +Z runs with
    // the traffic. Lamp arms, awnings and signage all lean the right way.
    // `lateral` is measured from the kerb, so props never end up in a lane.
    const place = (obj, s, lateral, side, extraRot = 0, y = 0) => {
      const a = track.at(s);
      obj.position.copy(a.pos).addScaledVector(a.right, side * (a.width * 0.5 + lateral));
      obj.position.y = a.pos.y + y;
      obj.rotation.y = a.heading + (side > 0 ? 0 : Math.PI) + extraRot;
      batcher.addObject(obj);
      disposeTree(obj);
    };

    // ── Lamp posts (alternating sides, like a real street) ─────────────────
    const lampStyle = P.lampStyle ?? 'modern';
    const lampSpacing = P.lampSpacing ?? 28;
    this.lampPositions = [];
    for (let s = 0, i = 0; s < track.length; s += lampSpacing, i++) {
      for (const side of [-1, 1]) {
        if ((i % 2 === 0) !== (side > 0)) continue;
        const lamp = kit.streetLamp(lampStyle);
        place(lamp, s, lampOff, side);
        const a = track.at(s);
        this.lampPositions.push(
          a.pos.clone()
            .addScaledVector(a.right, side * (a.width * 0.5 + lampOff) - kit.lampLightOffset(lampStyle) * side)
            .setY(a.pos.y + kit.lampLightHeight(lampStyle))
        );
      }
    }

    // ── Trees ──────────────────────────────────────────────────────────────
    if ((P.treeChance ?? 0) > 0) {
      const ts = P.treeSpacing ?? 30;
      for (let s = ts * 0.5; s < track.length; s += ts) {
        for (const side of [-1, 1]) {
          if (rng() > (P.treeChance ?? 0.5)) continue;
          const tr = kit.tree(P.treeStyle ?? 'plane', rng);
          tr.scale.setScalar(0.85 + rng() * 0.4);
          place(tr, s + (rng() - 0.5) * 5, outerOff, side, rng() * TAU);
          // Tree pit
          const pit = new THREE.Mesh(
            new THREE.CylinderGeometry(0.95, 0.95, 0.14, 10),
            kit.m.stone
          );
          place(pit, s + (rng() - 0.5) * 5, outerOff, side, 0, 0.07);
        }
      }
    }

    // ── Railings along the outside of the circuit ──────────────────────────
    if ((P.railingChance ?? 0) > 0) {
      const segLen = 8;
      for (let s = 0; s < track.length; s += segLen) {
        for (const side of [-1, 1]) {
          if (rng() > P.railingChance) continue;
          const r = kit.railing(segLen * 1.02, P.railingStyle ?? 'plain');
          place(r, s + segLen / 2, outerOff + 0.9, side, Math.PI / 2);
        }
      }
    }

    // ── Traffic lights + crossing furniture ───────────────────────────────
    const tlChance = P.trafficLightChance ?? 0.2;
    this.crossingS = [];
    for (let s = 60; s < track.length - 40; s += 110 + rng() * 90) {
      if (rng() > tlChance * 3) continue;
      this.crossingS.push(s);
      for (const side of [-1, 1]) {
        const tl = kit.trafficLight(rng() < 0.5 ? 0 : 2);
        place(tl, s - 3, 0.34 + 0.7, side, 0);
      }
    }

    // ── Small furniture scattered along the pavement ──────────────────────
    for (let s = 0; s < track.length; s += 12) {
      for (const side of [-1, 1]) {
        const r = rng();
        const jitter = (rng() - 0.5) * 6;
        if (P.benches && r < 0.06) place(kit.bench(), s + jitter, outerOff, side, Math.PI / 2);
        else if (P.bins && r < 0.13) place(kit.bin(theme.night ? 'plastic' : 'city'), s + jitter, outerOff, side);
        else if (P.phoneBoxes && r < 0.155) place(kit.phoneBox(), s + jitter, outerOff, side, rng() * 0.4 - 0.2);
        else if (P.postBoxes && r < 0.175) place(kit.postBox(), s + jitter, outerOff, side);
        else if (P.hydrants && r < 0.20) place(kit.hydrant(), s + jitter, lampOff * 0.6, side);
        else if (P.planters && r < 0.23) place(kit.planter(), s + jitter, outerOff, side);
        else if (P.vending && r < 0.23 + P.vending * 0.12) place(kit.vendingMachine(rng() < 0.5 ? 0xd42a2a : 0x1a6ad4), s + jitter, outerOff + 0.4, side, Math.PI);
        else if (P.bollards && r < 0.42) {
          for (let k = 0; k < 3; k++) place(kit.bollard(theme.id === 'london' ? 'iron' : 'steel'), s + jitter + k * 2.4, 0.34 + 0.55, side);
        }
      }
    }

    // ── Bus stops ─────────────────────────────────────────────────────────
    if (P.busStops) {
      for (let s = 140; s < track.length; s += 260 + rng() * 200) {
        const side = rng() < 0.5 ? -1 : 1;
        place(kit.busStop(), s, outerOff + 0.2, side, Math.PI / 2);
      }
    }

    // ── Flags on the buildings ────────────────────────────────────────────
    if (P.flags) {
      const flagTex = makeFlagTexture(P.flags);
      this.disposables.push(flagTex);
      for (let s = 40; s < track.length; s += 90 + rng() * 140) {
        const side = rng() < 0.5 ? -1 : 1;
        const f = kit.flagPole(flagTex, 0.62);
        place(f, s, 0.34 + pavEdge + (theme.buildings.setback ?? 1.5) - 0.5, side, 0, 6.5 + rng() * 3);
      }
    }

    // ── Scaffolding + cones for lived-in clutter ──────────────────────────
    if (P.scaffold) {
      for (let s = 70; s < track.length; s += 200 + rng() * 260) {
        if (rng() > P.scaffold * 3) continue;
        const side = rng() < 0.5 ? -1 : 1;
        place(kit.scaffold(10 + rng() * 8, 12 + rng() * 8, 1.6), s, outerOff + 1.4, side, Math.PI / 2);
      }
    }
    for (let s = 30; s < track.length; s += 180 + rng() * 220) {
      if (rng() < 0.45) {
        const side = rng() < 0.5 ? -1 : 1;
        // Cones coning off the edge of a lane — negative offsets sit inside
        // the carriageway rather than on the pavement.
        const n = 3 + ((rng() * 4) | 0);
        for (let k = 0; k < n; k++) {
          place(kit.cone(), s + k * 3.2, -1.4 - k * 0.32, side);
        }
      }
    }

    // ── Hanging lanterns (Beijing / Tokyo) ────────────────────────────────
    if (P.lanterns) {
      for (let s = 20; s < track.length; s += 14) {
        if (rng() > P.lanterns) continue;
        for (const side of [-1, 1]) {
          place(kit.lantern(theme.id === 'beijing' ? 0xd42a1a : 0xffd45a), s, outerOff + 0.6, side, 0, 3.6 + rng() * 0.8);
        }
      }
    }

    const built = batcher.build('props');
    this.group.add(built);
  }

  // ── Landmarks ───────────────────────────────────────────────────────────
  _buildLandmarks() {
    const theme = this.theme;
    const track = this.track;
    const kit = this.kit;
    const batcher = new GeoBatcher();
    const rng = makeRNG(9090);

    for (const L of theme.landmarks || []) {
      if (L.skip) continue;
      // `pos` pins a landmark in world space (used where it has to line up
      // with a specific view down a straight); otherwise it rides the spline.
      const s = (L.s ?? 0) * track.length;
      const a = track.at(s);
      const pos = L.pos
        ? new THREE.Vector3(L.pos[0], L.pos[1] ?? 0, L.pos[2])
        : new THREE.Vector3().copy(a.pos).addScaledVector(a.right, L.lateral);
      let obj = null;

      switch (L.type) {
        case 'bigBen':
          obj = LM.bigBen(kit, { scale: L.scale ?? 1, night: theme.night });
          break;
        case 'westminsterRange':
          obj = LM.westminsterRange(kit, { length: L.length ?? 150, height: L.height ?? 26 });
          break;
        case 'victoriaTower':
          obj = LM.victoriaTower(kit, {});
          break;
        case 'londonEye':
          obj = londonEye(kit);
          break;
        case 'eiffel':
          obj = LM.eiffelTower(kit, { height: L.height ?? 300, material: kit.mats.iron });
          break;
        case 'arc':
          obj = LM.arcDeTriomphe(kit, {});
          break;
        case 'tokyoTower':
          obj = LM.tokyoTower(kit, { height: L.height ?? 250 });
          break;
        case 'torii':
          obj = LM.torii(kit, { width: 11, height: 9 });
          break;
        case 'mediaWall':
          obj = mediaWall(kit, theme);
          break;
        case 'cctv':
          obj = LM.cctvTower(kit, { height: L.height ?? 170 });
          break;
        case 'gate':
          obj = makeBuilding(kit, rng, { style: 'chineseTrad', w: 62, d: 26, h: 26 });
          break;
        case 'temple':
          obj = LM.circularTemple(kit, { radius: 20 });
          break;
        case 'deco':
          obj = LM.decoTower(kit, { height: L.height ?? 220, facade: kit.pickFacade(rng) });
          break;
        case 'glassSlab':
          obj = makeBuilding(kit, rng, { style: 'glassTower', w: 46, d: 42, h: 150 });
          break;
        case 'sail':
          obj = LM.sailTower(kit, { height: L.height ?? 200 });
          break;
        case 'megaTower':
          obj = megaTower(kit, L.height ?? 380);
          break;
        default: break;
      }
      if (!obj) continue;
      obj.position.copy(pos);
      obj.position.y = (L.pos ? (L.pos[1] ?? 0) : a.pos.y) + (L.y ?? 0);
      obj.rotation.y = (L.pos ? 0 : a.heading) + (L.rotY ?? 0);
      batcher.addObject(obj);
      disposeTree(obj);
    }

    const built = batcher.build('landmarks');
    this.group.add(built);
  }

  // ── Zebra crossings + road decals ───────────────────────────────────────
  _buildCrossings() {
    if (!this.crossingS || !this.crossingS.length) return;
    const track = this.track;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xbdb9ad, roughness: 0.66, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      transparent: true, opacity: 0.62,
    });
    const batcher = new GeoBatcher();
    for (const s of this.crossingS) {
      const a = track.at(s);
      const hw = a.width * 0.5 - 0.3;
      const stripes = Math.floor((hw * 2) / 1.1);
      for (let i = 0; i < stripes; i++) {
        if (i % 2) continue;
        const off = -hw + (i + 0.5) * ((hw * 2) / stripes);
        const g = new THREE.PlaneGeometry((hw * 2) / stripes * 0.62, 3.4);
        const m = new THREE.Mesh(g, mat);
        m.rotation.x = -Math.PI / 2;
        m.position.copy(a.pos).addScaledVector(a.right, off);
        m.position.y = a.pos.y + 0.012;
        m.rotation.z = -a.heading;
        m.receiveShadow = false;
        batcher.addObject(m);
        g.dispose();
      }
      // Stop line
      const sl = new THREE.Mesh(new THREE.PlaneGeometry(a.width * 0.48, 0.42), mat);
      sl.rotation.x = -Math.PI / 2;
      sl.position.copy(a.pos).addScaledVector(a.right, a.width * 0.25).setY(a.pos.y + 0.012);
      sl.rotation.z = -a.heading;
      batcher.addObject(sl);
      sl.geometry.dispose();
    }
    const built = batcher.build('decals');
    built.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.layers.set(LAYER.MIRROR); } });
    this.group.add(built);
  }

  // ── Distant skyline so the horizon is never empty ──────────────────────
  _buildSkylineRing() {
    const theme = this.theme;
    const rng = makeRNG(777);
    const b = this.track.bounds;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const inner = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.62 + 240;

    const mat = new THREE.MeshStandardMaterial({
      color: theme.skylineColor ?? (theme.night ? 0x161a24 : 0x8a8f98),
      roughness: 0.92, metalness: 0.05, envMapIntensity: 0.4, fog: true,
    });
    const emissive = theme.night
      ? new THREE.MeshStandardMaterial({
        color: 0x0a0c12, emissive: 0xffd9a0, emissiveIntensity: 0.55, roughness: 0.8,
      })
      : null;

    const batcher = new GeoBatcher();
    const rings = 3;
    for (let r = 0; r < rings; r++) {
      const radius = inner + r * 190;
      const count = 60 + r * 26;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * TAU + rng() * 0.06;
        const rr = radius + (rng() - 0.5) * 130;
        const x = cx + Math.cos(a) * rr;
        const z = cz + Math.sin(a) * rr;
        const w = 26 + rng() * 60;
        const d = 26 + rng() * 60;
        const h = (26 + Math.pow(rng(), 2.1) * 190) * (1 + r * 0.28);
        const g = trimBox(w, h, d, 0.06);
        const m = new THREE.Matrix4().makeTranslation(x, h / 2 - 2, z);
        const rot = new THREE.Matrix4().makeRotationY(a);
        m.multiply(rot);
        batcher.add(g, mat, m, { castShadow: false, receiveShadow: false });
        if (emissive && rng() < 0.5) {
          const gg = trimBox(w * 0.9, h * 0.9, d * 0.9, 0.06);
          batcher.add(gg, emissive, new THREE.Matrix4().makeTranslation(x, h / 2 - 2, z), { castShadow: false, receiveShadow: false });
          gg.dispose();
        }
        g.dispose();
      }
    }
    const built = batcher.build('skyline');
    built.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    this.group.add(built);
  }

  // ── River (London) ──────────────────────────────────────────────────────
  _buildRiver() {
    const R = this.theme.river;
    const track = this.track;
    const from = R.sFrom * track.length, to = R.sTo * track.length;
    const steps = 26;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= steps; i++) {
      const s = lerp(from, to, i / steps);
      const a = track.at(s);
      const near = new THREE.Vector3().copy(a.pos).addScaledVector(a.right, R.side * R.distance);
      const far = new THREE.Vector3().copy(a.pos).addScaledVector(a.right, R.side * (R.distance + R.width));
      pos.push(near.x, -1.9, near.z, far.x, -1.9, far.z);
      uv.push(0, i * 3, 1, i * 3);
    }
    for (let i = 0; i < steps; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: R.color ?? 0x33404e, roughness: 0.12, metalness: 0.25, envMapIntensity: 1.8,
    });
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = false;
    this.group.add(m);
    this.riverMesh = m;
    this.riverMaterial = mat;

    // Embankment wall
    const wallPos = [], wallUv = [], wallIdx = [];
    for (let i = 0; i <= steps; i++) {
      const s = lerp(from, to, i / steps);
      const a = track.at(s);
      const top = new THREE.Vector3().copy(a.pos).addScaledVector(a.right, R.side * (R.distance - 0.2));
      wallPos.push(top.x, a.pos.y + 0.4, top.z, top.x, -2.4, top.z);
      wallUv.push(i * 2, 1, i * 2, 0);
    }
    for (let i = 0; i < steps; i++) {
      const a = i * 2;
      wallIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
    wg.setAttribute('uv', new THREE.Float32BufferAttribute(wallUv, 2));
    wg.setIndex(wallIdx);
    wg.computeVertexNormals();
    const wallMat = makeSurface(makePavement({ style: 'granite', color: 0x8e8a82, seed: 8 }), {
      repeat: [1, 1], roughness: 0.8, side: THREE.DoubleSide,
    });
    this.group.add(new THREE.Mesh(wg, wallMat));
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m && m.dispose());
      }
    });
    this.kit?.dispose();
    this.props?.dispose();
    this.disposables.forEach((d) => d.dispose && d.dispose());
  }
}

// ── Extra landmark helpers that need world context ─────────────────────────
function londonEye(kit) {
  const g = new THREE.Group();
  const metal = kit.mats.metal;
  const R = 60;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 1.2, 8, 60), metal);
  rim.position.y = R + 8;
  rim.castShadow = true;
  g.add(rim);
  const rim2 = new THREE.Mesh(new THREE.TorusGeometry(R - 3.5, 0.8, 6, 48), metal);
  rim2.position.y = R + 8;
  g.add(rim2);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 6, 12), metal);
  hub.rotation.x = Math.PI / 2;
  hub.position.y = R + 8;
  g.add(hub);
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * TAU;
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, R, 5), metal);
    spoke.position.set(Math.cos(a) * R / 2, R + 8 + Math.sin(a) * R / 2, 0);
    spoke.rotation.z = -a + Math.PI / 2;
    g.add(spoke);
    if (i % 2 === 0) {
      const cap = new THREE.Mesh(new THREE.CapsuleGeometry(1.5, 2.6, 4, 8), kit.mats.glassDark);
      cap.rotation.z = Math.PI / 2;
      cap.position.set(Math.cos(a) * (R + 2.6), R + 8 + Math.sin(a) * (R + 2.6), 0);
      g.add(cap);
    }
  }
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.2, R + 14, 8), metal);
    leg.position.set(s * 16, (R + 14) / 2, s * 8);
    leg.rotation.z = -s * 0.24;
    leg.rotation.x = -s * 0.12;
    leg.castShadow = true;
    g.add(leg);
  }
  return g;
}

function mediaWall(kit, theme) {
  const g = new THREE.Group();
  const colors = theme.buildings.neonColors || [0xff2a6d, 0x2af0ff, 0xffd400];
  const words = ['SHIBUYA', 'ネオン', 'TOKYO', '渋谷', 'NIGHT', 'APEX'];
  const rng = makeRNG(31);
  for (let i = 0; i < 5; i++) {
    const w = 9 + rng() * 12, h = 5 + rng() * 8;
    const tex = makeSignTexture({
      w: 512, h: 256,
      text: words[i % words.length],
      bg: '#07070c',
      color: '#' + colors[i % colors.length].toString(16).padStart(6, '0'),
      font: 'bold 110px Barlow Condensed, Impact, sans-serif',
      glow: true, sub: i % 2 ? 'LIVE' : '',
    });
    const scr = LM.mediaScreen(w, h, tex, { intensity: 3.6 });
    scr.position.set((rng() - 0.5) * 8, 8 + i * 9 + rng() * 3, 0);
    scr.rotation.y = (rng() - 0.5) * 0.4;
    g.add(scr);
  }
  const backing = new THREE.Mesh(trimBox(30, 60, 16), kit.mats.dark);
  backing.position.set(0, 30, -9);
  g.add(backing);
  return g;
}

function megaTower(kit, height) {
  const g = new THREE.Group();
  const glass = kit.mats.glassDark;
  const metal = kit.mats.metal;
  const tiers = 12;
  let y = 0, r = 34;
  for (let i = 0; i < tiers; i++) {
    const th = height * 0.075;
    const geo = new THREE.CylinderGeometry(r * 0.86, r, th, 3 + (i % 2 ? 3 : 0), 1);
    const m = new THREE.Mesh(geo, i % 2 ? glass : metal);
    m.position.y = y + th / 2;
    m.rotation.y = i * 0.22;
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    y += th;
    r *= 0.90;
  }
  const spire = new THREE.Mesh(new THREE.ConeGeometry(r * 0.8, height * 0.18, 8), metal);
  spire.position.y = y + height * 0.09;
  g.add(spire);
  return g;
}

// ── Flag textures ──────────────────────────────────────────────────────────
function makeFlagTexture(country) {
  const W = 256, H = 152;
  const cv = canvas(W, H);
  const g = cv.getContext('2d');
  const rect = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };

  if (country === 'uk') {
    rect(0, 0, W, H, '#012169');
    g.strokeStyle = '#fff'; g.lineWidth = H * 0.20;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(W, H); g.moveTo(W, 0); g.lineTo(0, H); g.stroke();
    g.strokeStyle = '#C8102E'; g.lineWidth = H * 0.10;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(W, H); g.moveTo(W, 0); g.lineTo(0, H); g.stroke();
    rect(0, H * 0.4, W, H * 0.2, '#fff');
    rect(W * 0.4, 0, W * 0.2, H, '#fff');
    rect(0, H * 0.44, W, H * 0.12, '#C8102E');
    rect(W * 0.44, 0, W * 0.12, H, '#C8102E');
  } else if (country === 'fr') {
    rect(0, 0, W / 3, H, '#002395');
    rect(W / 3, 0, W / 3, H, '#ffffff');
    rect((2 * W) / 3, 0, W / 3, H, '#ED2939');
  } else if (country === 'cn') {
    rect(0, 0, W, H, '#DE2910');
    g.fillStyle = '#FFDE00';
    const star = (cx, cy, r, rot) => {
      g.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = rot + (i * TAU) / 5 - Math.PI / 2;
        g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        const a2 = a + TAU / 10;
        g.lineTo(cx + Math.cos(a2) * r * 0.4, cy + Math.sin(a2) * r * 0.4);
      }
      g.closePath(); g.fill();
    };
    star(W * 0.16, H * 0.28, H * 0.16, 0);
    star(W * 0.32, H * 0.12, H * 0.055, 0.4);
    star(W * 0.40, H * 0.24, H * 0.055, 0.7);
    star(W * 0.40, H * 0.42, H * 0.055, 1.0);
    star(W * 0.32, H * 0.55, H * 0.055, 1.3);
  } else if (country === 'us') {
    for (let i = 0; i < 13; i++) rect(0, (H / 13) * i, W, H / 13, i % 2 ? '#fff' : '#B22234');
    rect(0, 0, W * 0.42, (H / 13) * 7, '#3C3B6E');
    g.fillStyle = '#fff';
    for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) {
      g.beginPath();
      g.arc(W * 0.05 + c * W * 0.065, H * 0.06 + r * H * 0.09, 2.6, 0, TAU);
      g.fill();
    }
  } else if (country === 'ae') {
    rect(0, 0, W, H / 3, '#00732F');
    rect(0, H / 3, W, H / 3, '#ffffff');
    rect(0, (2 * H) / 3, W, H / 3, '#000000');
    rect(0, 0, W * 0.25, H, '#FF0000');
  } else {
    rect(0, 0, W, H, '#cccccc');
  }
  return toTexture(cv, { wrap: THREE.ClampToEdgeWrapping });
}

const DEFAULT_CLEAR = {
  bigBen: 46, westminsterRange: 110, victoriaTower: 46, londonEye: 80,
  eiffel: 130, arc: 70, tokyoTower: 110, torii: 24, mediaWall: 34,
  cctv: 130, gate: 70, temple: 60, deco: 70, glassSlab: 50,
  sail: 90, megaTower: 90,
};

function disposeTree(obj) {
  obj.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
}

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}
