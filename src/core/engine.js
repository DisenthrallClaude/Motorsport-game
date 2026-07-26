import * as THREE from 'three';
import { PostFX, LAYER, QUALITY } from '../render/postfx.js';
import { PlanarReflector } from '../render/reflector.js';
import { Sky, SunFlare } from '../render/sky.js';

/**
 * Owns the WebGL context, the camera rig, the sky, the reflection probe and
 * the post pipeline. Game code only touches `scene`, `camera` and `postfx.grade`.
 */
export class Engine {
  constructor(canvas, quality = 'high') {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // MSAA happens on the HDR target instead
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.setClearColor(0x05070c, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping happens by hand in the composite pass.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = true;

    this.capabilities = {
      webgl2: this.renderer.capabilities.isWebGL2,
      maxAniso: this.renderer.capabilities.getMaxAnisotropy(),
    };

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;

    this.camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.28, 2600);
    this.camera.layers.enableAll();
    this.camera.position.set(0, 3, 10);

    this.sky = new Sky();
    this.scene.add(this.sky.group);

    this.flare = new SunFlare();
    this.scene.add(this.flare.group);

    this.postfx = new PostFX(this.renderer, quality);
    this.reflector = new PlanarReflector(this.renderer, {
      scale: QUALITY[quality].reflScale,
    });

    this.time = 0;
    this.quality = quality;
    this._resizeHandler = () => this.resize();
    window.addEventListener('resize', this._resizeHandler);
    this.resize();

    this._stats = { frames: 0, acc: 0, fps: 60, avgMs: 16 };
    this._focus = new THREE.Vector3();
  }

  setQuality(name) {
    if (!QUALITY[name] || name === this.quality) return;
    this.quality = name;
    const q = QUALITY[name];
    this.postfx.setQuality(name);
    this.reflector.scale = q.reflScale;
    this.reflector.enabled = q.reflScale > 0.01;
    this.reflector._w = 0;
    this.sky.setShadowSize(q.shadow);
    this.renderer.shadowMap.enabled = true;
    this.resize();
    this.scene.traverse((o) => {
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.map) m.map.anisotropy = q.aniso;
          m.needsUpdate = false;
        }
      }
    });
  }

  resize() {
    const w = Math.max(320, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(240, this.canvas.clientHeight || window.innerHeight);
    this.cssW = w; this.cssH = h;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality === 'ultra' ? 2 : 1.5);
    this.renderer.setPixelRatio(dpr * QUALITY[this.quality].renderScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.postfx.setSize(w, h);
    this.reflector.setSize(this.postfx.width, this.postfx.height);
  }

  /** Apply a world theme's atmosphere + colour grade. */
  applyTheme(theme) {
    this.sky.apply(theme.sky);
    const g = this.postfx.grade;
    const gr = theme.grade || {};
    g.exposure = gr.exposure ?? 1.0;
    g.bloom = gr.bloom ?? 0.55;
    g.rays = gr.rays ?? 0.5;
    g.ao = gr.ao ?? 0.75;
    g.saturation = gr.saturation ?? 1.06;
    g.contrast = gr.contrast ?? 1.06;
    g.vignette = gr.vignette ?? 0.42;
    g.grain = gr.grain ?? 0.028;
    g.chroma = gr.chroma ?? 0.9;
    g.dof = gr.dof ?? 0.45;
    g.dofRange = gr.dofRange ?? 260;
    if (gr.lift) g.lift.set(...gr.lift);
    if (gr.gamma) g.gamma.set(...gr.gamma);
    if (gr.gain) g.gain.set(...gr.gain);
    g.fogColor.setHex(theme.fog?.color ?? 0x9fb0c4);
    g.fogSun.setHex(theme.fog?.sunColor ?? 0xffd9a8);
    g.fogDensity = theme.fog?.density ?? 0.003;
    g.fogHeight = theme.fog?.height ?? 90;

    this.sky.setShadowSize(QUALITY[this.quality].shadow);
    this.envMap = this.sky.buildEnvironment(this.renderer);
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = theme.envIntensity ?? 1.0;
    this.scene.background = null;
  }

  /** One rendered frame. */
  render(dt, focusPoint, roadY = 0) {
    this.time += dt;
    this._focus.copy(focusPoint || this.camera.position);
    this.sky.update(this.camera, this._focus, this.time);
    this.flare.update(this.camera, this.sky.sunDir, this.flareVisibility ?? 1);

    if (this.reflector.enabled) {
      this.reflector.render(this.scene, this.camera, roadY);
    }

    this.postfx.render(this.scene, this.camera, this.sky.sunDir, this.time, dt);

    // Rolling perf stats used by the adaptive-quality governor.
    this._stats.frames++;
    this._stats.acc += dt;
    if (this._stats.acc >= 0.5) {
      this._stats.fps = this._stats.frames / this._stats.acc;
      this._stats.avgMs = (this._stats.acc / this._stats.frames) * 1000;
      this._stats.frames = 0;
      this._stats.acc = 0;
    }
  }

  get fps() { return this._stats.fps; }

  dispose() {
    window.removeEventListener('resize', this._resizeHandler);
    this.postfx.dispose();
    this.reflector.dispose();
    this.sky.dispose();
    this.renderer.dispose();
  }
}

export { LAYER };
