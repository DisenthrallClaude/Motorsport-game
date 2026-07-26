import * as THREE from 'three';
import {
  FS_VERT, DN_VERT, DN_FRAG, SSAO_FRAG, BILATERAL_FRAG, BRIGHT_FRAG,
  DOWN_FRAG, UP_FRAG, GODRAY_FRAG, COMPOSITE_FRAG, FXAA_FRAG, COPY_FRAG,
} from './shaders.js';

// Render layers. An object assigned *only* to one of these can be excluded
// from the passes that don't want it.
export const LAYER = {
  SOLID: 0,   // everything that writes depth + normals
  SKY: 2,     // sky dome: no prepass, but yes in reflections
  FX: 3,      // transparent / particles: no prepass, no reflections
  MIRROR: 4,  // reflective surfaces: prepass yes, but must not reflect itself
};

export const QUALITY = {
  low:   { renderScale: 0.72, msaa: 0, ssao: false, aoScale: 0.5,  bloomMips: 4, rays: false, dnScale: 0.5,  reflScale: 0.0,  shadow: 1024, sharpen: 0.18, aniso: 4,  motion: 0.55, shadowFar: 130 },
  med:   { renderScale: 0.88, msaa: 0, ssao: true,  aoScale: 0.5,  bloomMips: 5, rays: true,  dnScale: 0.5,  reflScale: 0.4,  shadow: 1536, sharpen: 0.22, aniso: 8,  motion: 0.8,  shadowFar: 170 },
  high:  { renderScale: 1.0,  msaa: 4, ssao: true,  aoScale: 0.6,  bloomMips: 6, rays: true,  dnScale: 0.6,  reflScale: 0.55, shadow: 2048, sharpen: 0.28, aniso: 16, motion: 1.0,  shadowFar: 210 },
  ultra: { renderScale: 1.0,  msaa: 8, ssao: true,  aoScale: 0.75, bloomMips: 7, rays: true,  dnScale: 0.75, reflScale: 0.7,  shadow: 4096, sharpen: 0.32, aniso: 16, motion: 1.0,  shadowFar: 280 },
};

const HALF = THREE.HalfFloatType;

function makeRT(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: opts.type ?? HALF,
    format: THREE.RGBAFormat,
    minFilter: opts.min ?? THREE.LinearFilter,
    magFilter: opts.mag ?? THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: opts.depth ?? false,
    stencilBuffer: false,
    samples: opts.samples ?? 0,
    generateMipmaps: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

export class PostFX {
  constructor(renderer, quality = 'high') {
    this.renderer = renderer;
    this.q = QUALITY[quality] ?? QUALITY.high;
    this.qualityName = quality;
    this.width = 1;
    this.height = 1;
    this.enabled = true;

    // Shared fullscreen quad.
    this._quadGeo = new THREE.PlaneGeometry(1, 1);
    this._quadMesh = new THREE.Mesh(this._quadGeo, null);
    this._quadMesh.frustumCulled = false;
    this._quadScene = new THREE.Scene();
    this._quadScene.add(this._quadMesh);
    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._buildMaterials();

    this.prevVP = new THREE.Matrix4();
    this._vp = new THREE.Matrix4();
    this._sunScreen = new THREE.Vector2(0.5, 0.9);
    this._tmpV = new THREE.Vector3();

    // Grading defaults — overridden per world theme.
    this.grade = {
      exposure: 1.0,
      bloom: 0.55,
      rays: 0.5,
      ao: 0.75,
      saturation: 1.06,
      contrast: 1.06,
      lift: new THREE.Vector3(0.0, 0.0, 0.008),
      gamma: new THREE.Vector3(1.0, 1.0, 1.0),
      gain: new THREE.Vector3(1.0, 1.0, 1.0),
      vignette: 0.42,
      grain: 0.028,
      chroma: 0.9,
      fogColor: new THREE.Color(0.62, 0.68, 0.76),
      fogSun: new THREE.Color(1.0, 0.86, 0.66),
      fogDensity: 0.0030,
      fogHeight: 90,
      dof: 0.45,
      dofRange: 260,
      focus: 22,
    };

    this.motionScale = 1.0;
    this.bloomBoost = 1.0;
  }

  // ────────────────────────────────────────────────────────────────────────
  _buildMaterials() {
    const q = this.q;

    this.dnMaterial = new THREE.ShaderMaterial({
      vertexShader: DN_VERT,
      fragmentShader: DN_FRAG,
      side: THREE.FrontSide,
    });
    // Some world pieces are double sided; a mismatched prepass looks wrong.
    this.dnMaterialDouble = this.dnMaterial.clone();
    this.dnMaterialDouble.side = THREE.DoubleSide;

    this.ssaoMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: SSAO_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tDN: { value: null },
        uProjInfo: { value: new THREE.Vector2() },
        uProj: { value: new THREE.Matrix4() },
        uRes: { value: new THREE.Vector2() },
        uRadius: { value: 1.15 },
        uIntensity: { value: 1.45 },
        uBias: { value: 0.035 },
        uFar: { value: 4000 },
      },
    });

    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: BILATERAL_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tSrc: { value: null }, tDN: { value: null },
        uTexel: { value: new THREE.Vector2() }, uDir: { value: new THREE.Vector2(1, 0) },
      },
    });

    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tSrc: { value: null }, uThreshold: { value: 1.05 }, uKnee: { value: 0.62 }, uClamp: { value: 9.0 },
      },
    });

    this.downMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: DOWN_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
    });

    this.upMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: UP_FRAG, depthTest: false, depthWrite: false,
      transparent: true, blending: THREE.AdditiveBlending,
      uniforms: {
        tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 },
      },
    });

    this.rayMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: GODRAY_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tSrc: { value: null }, tDN: { value: null },
        uSun: { value: new THREE.Vector2(0.5, 0.9) },
        uDensity: { value: 0.72 }, uWeight: { value: 0.055 },
        uDecay: { value: 0.955 }, uExposure: { value: 0.55 },
        uFar: { value: 4000 }, uAspect: { value: 1.7 },
      },
    });

    this.compMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tScene: { value: null }, tBloom: { value: null }, tRays: { value: null },
        tAO: { value: null }, tDN: { value: null },
        uRes: { value: new THREE.Vector2() },
        uProjInfo: { value: new THREE.Vector2() },
        uInvView: { value: new THREE.Matrix4() },
        uPrevVP: { value: new THREE.Matrix4() },
        uFar: { value: 4000 }, uTime: { value: 0 },
        uBloom: { value: 0.55 }, uRays: { value: 0.5 }, uAOStrength: { value: 0.75 },
        uExposure: { value: 1.0 },
        uMotionAmount: { value: 1.0 }, uDofStrength: { value: 0.45 },
        uFocus: { value: 22 }, uDofRange: { value: 260 },
        uFogColor: { value: new THREE.Vector3(0.62, 0.68, 0.76) },
        uFogSun: { value: new THREE.Vector3(1.0, 0.86, 0.66) },
        uFogDensity: { value: 0.003 }, uFogHeight: { value: 90 },
        uSunScreen: { value: new THREE.Vector2(0.5, 0.9) },
        uVignette: { value: 0.42 }, uGrain: { value: 0.028 }, uChroma: { value: 0.9 },
        uSaturation: { value: 1.06 }, uContrast: { value: 1.06 },
        uLift: { value: new THREE.Vector3() },
        uGamma: { value: new THREE.Vector3(1, 1, 1) },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uSharpen: { value: q.sharpen },
      },
    });

    this.fxaaMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: FXAA_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
    });

    this.copyMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: COPY_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, uOpacity: { value: 1 } },
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  setQuality(name) {
    if (!QUALITY[name]) return;
    this.qualityName = name;
    this.q = QUALITY[name];
    this.compMat.uniforms.uSharpen.value = this.q.sharpen;
    this.setSize(this.cssWidth, this.cssHeight, true);
  }

  setSize(cssW, cssH, force = false) {
    this.cssWidth = cssW;
    this.cssHeight = cssH;
    const q = this.q;
    const dpr = Math.min(window.devicePixelRatio || 1, this.qualityName === 'ultra' ? 2 : 1.5);
    const w = Math.max(2, Math.round(cssW * dpr * q.renderScale));
    const h = Math.max(2, Math.round(cssH * dpr * q.renderScale));
    if (!force && w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;

    this._dispose();

    this.sceneRT = makeRT(w, h, { depth: true, samples: q.msaa });

    const dw = Math.round(w * q.dnScale), dh = Math.round(h * q.dnScale);
    this.dnRT = makeRT(dw, dh, { depth: true, min: THREE.NearestFilter, mag: THREE.NearestFilter });

    const aw = Math.round(w * q.aoScale), ah = Math.round(h * q.aoScale);
    this.aoRT = makeRT(aw, ah);
    this.aoRT2 = makeRT(aw, ah);
    if (!q.ssao) {
      // Constant-white AO so the composite can stay branch-free.
      this.aoWhite = makeRT(2, 2, { type: THREE.UnsignedByteType });
    }

    this.rayRT = makeRT(Math.round(w * 0.5), Math.round(h * 0.5));
    this.ldrRT = makeRT(w, h, { type: THREE.UnsignedByteType });

    this.bloomRTs = [];
    let bw = w >> 1, bh = h >> 1;
    for (let i = 0; i < q.bloomMips; i++) {
      if (bw < 4 || bh < 4) break;
      this.bloomRTs.push(makeRT(bw, bh));
      bw = Math.max(2, bw >> 1);
      bh = Math.max(2, bh >> 1);
    }
    this.brightRT = makeRT(w >> 1, h >> 1);

    this._clearedWhite = false;
  }

  _dispose() {
    const kill = (rt) => rt && rt.dispose();
    kill(this.sceneRT); kill(this.dnRT);
    kill(this.aoRT); kill(this.aoRT2); kill(this.rayRT); kill(this.ldrRT);
    kill(this.brightRT); kill(this.aoWhite);
    if (this.bloomRTs) this.bloomRTs.forEach(kill);
    this.bloomRTs = [];
  }

  _blit(material, target) {
    this._quadMesh.material = material;
    this.renderer.setRenderTarget(target ?? null);
    this.renderer.render(this._quadScene, this._quadCam);
  }

  // ────────────────────────────────────────────────────────────────────────
  //  The frame.
  // ────────────────────────────────────────────────────────────────────────
  render(scene, camera, sunDir, time, dt) {
    const r = this.renderer;
    const q = this.q;
    const prevAutoClear = r.autoClear;

    camera.updateMatrixWorld();
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    const projInfo = this._projInfo || (this._projInfo = new THREE.Vector2());
    projInfo.set(tanHalf * camera.aspect, tanHalf);

    // ── 1. Depth + normal prepass ──────────────────────────────────────────
    const mainMask = camera.layers.mask;
    camera.layers.disableAll();
    camera.layers.enable(LAYER.SOLID);
    camera.layers.enable(LAYER.MIRROR);
    scene.overrideMaterial = this.dnMaterial;
    r.setRenderTarget(this.dnRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(scene, camera);
    scene.overrideMaterial = null;
    camera.layers.mask = mainMask;

    // ── 2. SSAO ────────────────────────────────────────────────────────────
    let aoTex;
    if (q.ssao) {
      const u = this.ssaoMat.uniforms;
      u.tDN.value = this.dnRT.texture;
      u.uProjInfo.value.copy(projInfo);
      u.uProj.value.copy(camera.projectionMatrix);
      u.uRes.value.set(this.aoRT.width, this.aoRT.height);
      u.uFar.value = camera.far;
      this._blit(this.ssaoMat, this.aoRT);

      const b = this.blurMat.uniforms;
      b.tDN.value = this.dnRT.texture;
      b.tSrc.value = this.aoRT.texture;
      b.uTexel.value.set(1 / this.aoRT.width, 1 / this.aoRT.height);
      b.uDir.value.set(1, 0);
      this._blit(this.blurMat, this.aoRT2);
      b.tSrc.value = this.aoRT2.texture;
      b.uDir.value.set(0, 1);
      this._blit(this.blurMat, this.aoRT);
      aoTex = this.aoRT.texture;
    } else {
      if (!this._clearedWhite) {
        r.setRenderTarget(this.aoWhite);
        r.setClearColor(0xffffff, 1);
        r.clear(true, false, false);
        this._clearedWhite = true;
      }
      aoTex = this.aoWhite.texture;
    }

    // ── 3. Main HDR pass ───────────────────────────────────────────────────
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(scene, camera);
    // three resolves a multisampled target automatically on the next
    // setRenderTarget, so sceneRT.texture is safe to sample from here on.
    const sceneTex = this.sceneRT.texture;

    // ── 4. Sun screen position (rays + fog scattering) ─────────────────────
    this._tmpV.copy(sunDir).multiplyScalar(3000).add(camera.position);
    this._tmpV.project(camera);
    const sunBehind = this._tmpV.z > 1;
    this._sunScreen.set(this._tmpV.x * 0.5 + 0.5, this._tmpV.y * 0.5 + 0.5);

    // ── 5. Light shafts ────────────────────────────────────────────────────
    let rayStrength = this.grade.rays;
    if (q.rays && !sunBehind && rayStrength > 0.001) {
      const u = this.rayMat.uniforms;
      u.tSrc.value = sceneTex;
      u.tDN.value = this.dnRT.texture;
      u.uSun.value.copy(this._sunScreen);
      u.uFar.value = camera.far;
      u.uAspect.value = camera.aspect;
      this._blit(this.rayMat, this.rayRT);
    } else {
      rayStrength = 0;
      r.setRenderTarget(this.rayRT);
      r.setClearColor(0x000000, 1);
      r.clear(true, false, false);
    }

    // ── 6. Bloom pyramid ───────────────────────────────────────────────────
    this.brightMat.uniforms.tSrc.value = sceneTex;
    this._blit(this.brightMat, this.brightRT);

    let src = this.brightRT;
    for (let i = 0; i < this.bloomRTs.length; i++) {
      const dst = this.bloomRTs[i];
      this.downMat.uniforms.tSrc.value = src.texture;
      this.downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._blit(this.downMat, dst);
      src = dst;
    }
    // Upsample & accumulate back down the chain (additive blending).
    r.autoClear = false;
    for (let i = this.bloomRTs.length - 1; i > 0; i--) {
      const from = this.bloomRTs[i];
      const to = this.bloomRTs[i - 1];
      this.upMat.uniforms.tSrc.value = from.texture;
      this.upMat.uniforms.uTexel.value.set(1 / from.width, 1 / from.height);
      this.upMat.uniforms.uRadius.value = 1.0 + i * 0.16;
      this._blit(this.upMat, to);
    }
    r.autoClear = prevAutoClear;

    // ── 7. Composite ───────────────────────────────────────────────────────
    const g = this.grade;
    const cu = this.compMat.uniforms;
    cu.tScene.value = sceneTex;
    cu.tBloom.value = this.bloomRTs.length ? this.bloomRTs[0].texture : this.brightRT.texture;
    cu.tRays.value = this.rayRT.texture;
    cu.tAO.value = aoTex;
    cu.tDN.value = this.dnRT.texture;
    cu.uRes.value.set(this.width, this.height);
    cu.uProjInfo.value.copy(projInfo);
    cu.uInvView.value.copy(camera.matrixWorld);
    cu.uPrevVP.value.copy(this.prevVP);
    cu.uFar.value = camera.far;
    cu.uTime.value = time;
    cu.uBloom.value = g.bloom * this.bloomBoost;
    cu.uRays.value = rayStrength;
    cu.uAOStrength.value = q.ssao ? g.ao : 0;
    cu.uExposure.value = g.exposure;
    // Velocity is reconstructed per frame, so normalise it to a fixed shutter
    // time. Without this the blur explodes whenever the frame rate dips.
    const shutter = dt > 0 ? Math.min(1.25, (1 / 60) / dt) : 1;
    cu.uMotionAmount.value = q.motion * this.motionScale * shutter;
    cu.uDofStrength.value = g.dof;
    cu.uFocus.value = g.focus;
    cu.uDofRange.value = g.dofRange;
    cu.uFogColor.value.set(g.fogColor.r, g.fogColor.g, g.fogColor.b);
    cu.uFogSun.value.set(g.fogSun.r, g.fogSun.g, g.fogSun.b);
    cu.uFogDensity.value = g.fogDensity;
    cu.uFogHeight.value = g.fogHeight;
    cu.uSunScreen.value.set(
      sunBehind ? -5 : this._sunScreen.x,
      sunBehind ? -5 : this._sunScreen.y
    );
    cu.uVignette.value = g.vignette;
    cu.uGrain.value = g.grain;
    cu.uChroma.value = g.chroma * 0.011;
    cu.uSaturation.value = g.saturation;
    cu.uContrast.value = g.contrast;
    cu.uLift.value.copy(g.lift);
    cu.uGamma.value.copy(g.gamma);
    cu.uGain.value.copy(g.gain);
    this._blit(this.compMat, this.ldrRT);

    // ── 8. FXAA → screen ───────────────────────────────────────────────────
    this.fxaaMat.uniforms.tSrc.value = this.ldrRT.texture;
    this.fxaaMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this._blit(this.fxaaMat, null);

    // Stash this frame's view-projection for next frame's motion blur.
    this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.prevVP.copy(this._vp);
  }

  dispose() {
    this._dispose();
    this._quadGeo.dispose();
    [this.ssaoMat, this.blurMat, this.brightMat, this.downMat, this.upMat,
     this.rayMat, this.compMat, this.fxaaMat, this.copyMat, this.dnMaterial,
     this.dnMaterialDouble].forEach((m) => m && m.dispose());
  }
}
