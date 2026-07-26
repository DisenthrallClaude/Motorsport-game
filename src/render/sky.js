import * as THREE from 'three';
import { SKY_VERT, SKY_FRAG } from './shaders.js';
import { LAYER } from './postfx.js';
import { DEG, clamp } from '../core/math.js';

/**
 * Analytic sky dome + sun rig.
 * The same shader also feeds a PMREM environment map so every PBR material in
 * the world gets physically consistent reflections for free.
 */
export class Sky {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 0.2, -1) },
        uZenith: { value: new THREE.Color(0.14, 0.28, 0.55) },
        uHorizon: { value: new THREE.Color(0.85, 0.86, 0.9) },
        uGround: { value: new THREE.Color(0.22, 0.22, 0.24) },
        uSunColor: { value: new THREE.Color(1.0, 0.78, 0.52) },
        uSunSize: { value: 0.021 },
        uSunIntensity: { value: 1.0 },
        uHaze: { value: 0.42 },
        uCloud: { value: 0.5 },
        uCloudSharp: { value: 0.55 },
        uCloudColor: { value: new THREE.Color(1.0, 0.97, 0.94) },
        uCloudDark: { value: new THREE.Color(0.32, 0.35, 0.42) },
        uTime: { value: 0 },
        uStars: { value: 0 },
        uExposure: { value: 1 },
      },
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.layers.set(LAYER.SKY);
    this.mesh.scale.setScalar(1);

    this.sunDir = new THREE.Vector3(0, 0.2, -1).normalize();

    // Sun light + its shadow camera.
    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 620;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.045;
    this.sun.shadow.blurSamples = 12;
    this.sunTarget = new THREE.Object3D();
    this.sun.target = this.sunTarget;

    // Broad sky/bounce fill, cheap and effective in a forward renderer.
    this.hemi = new THREE.HemisphereLight(0xbcd6ff, 0x3a3630, 1.0);
    // A second, opposite-side rim light. Sells the "expensive render" look.
    this.rim = new THREE.DirectionalLight(0xa9c8ff, 0.5);

    this.group = new THREE.Group();
    this.group.add(this.mesh, this.sun, this.sunTarget, this.hemi, this.rim);

    this._pmrem = null;
    this._envRT = null;
    this._envScene = null;
  }

  /** Apply a theme's atmosphere preset. */
  apply(p) {
    const u = this.material.uniforms;
    const az = p.sunAzimuth * DEG;
    const el = p.sunElevation * DEG;
    this.sunDir.set(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az)
    ).normalize();

    u.uSunDir.value.copy(this.sunDir);
    u.uZenith.value.setHex(p.zenith);
    u.uHorizon.value.setHex(p.horizon);
    u.uGround.value.setHex(p.groundHaze ?? 0x3a3a3c);
    u.uSunColor.value.setHex(p.sunColor);
    u.uSunSize.value = p.sunSize ?? 0.021;
    u.uSunIntensity.value = p.sunGlow ?? 1.0;
    u.uHaze.value = p.haze ?? 0.42;
    u.uCloud.value = p.cloud ?? 0.5;
    u.uCloudSharp.value = p.cloudSharp ?? 0.55;
    u.uCloudColor.value.setHex(p.cloudColor ?? 0xfff6ee);
    u.uCloudDark.value.setHex(p.cloudDark ?? 0x4c5464);
    u.uStars.value = p.stars ?? 0;
    u.uExposure.value = p.skyExposure ?? 1;

    this.sun.color.setHex(p.lightColor ?? p.sunColor);
    this.sun.intensity = p.sunIntensity ?? 3.0;
    this.hemi.color.setHex(p.hemiSky ?? 0xbcd6ff);
    this.hemi.groundColor.setHex(p.hemiGround ?? 0x3a3630);
    this.hemi.intensity = p.hemiIntensity ?? 1.0;
    this.rim.color.setHex(p.rimColor ?? 0xa9c8ff);
    this.rim.intensity = p.rimIntensity ?? 0.5;
    this.rim.position
      .set(-this.sunDir.x + 0.55, Math.max(0.62, this.sunDir.y * 0.5 + 0.72), -this.sunDir.z + 0.35)
      .normalize()
      .multiplyScalar(160);

    this.shadowRadius = p.shadowRadius ?? 90;
  }

  /** Keep the shadow frustum tight around the player for crisp contact shadows. */
  update(camera, focus, time) {
    this.material.uniforms.uTime.value = time;
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(camera.far * 0.92);

    const R = this.shadowRadius ?? 90;
    // Push the shadow box slightly ahead of the car in its travel direction.
    this.sunTarget.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 260);

    const cam = this.sun.shadow.camera;
    if (cam.right !== R) {
      cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R;
      cam.near = 40; cam.far = 260 + R * 2.2;
      cam.updateProjectionMatrix();
    }
    this.sun.target.updateMatrixWorld();
  }

  setShadowSize(px) {
    if (this.sun.shadow.mapSize.width === px) return;
    this.sun.shadow.mapSize.set(px, px);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
  }

  /** Bake the current sky into a PMREM cube for image-based lighting. */
  buildEnvironment(renderer) {
    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(renderer);
    if (!this._envScene) {
      this._envScene = new THREE.Scene();
      const m = this.material.clone();
      m.uniforms = this.material.uniforms; // share live uniforms
      this._envMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), m);
      this._envMesh.scale.setScalar(400);
      this._envScene.add(this._envMesh);
    }
    if (this._envRT) this._envRT.dispose();
    this._pmrem.compileEquirectangularShader();
    this._envRT = this._pmrem.fromScene(this._envScene, 0.02, 1, 900);
    return this._envRT.texture;
  }

  dispose() {
    this.material.dispose();
    this.mesh.geometry.dispose();
    if (this._envRT) this._envRT.dispose();
    if (this._pmrem) this._pmrem.dispose();
  }
}

/**
 * Screen-space sun flare drawn as a camera-locked sprite stack.
 * Cheap, and it adds a lot to the "looking into the sun" shots.
 */
export class SunFlare {
  constructor() {
    const tex = makeFlareTexture();
    this.group = new THREE.Group();
    this.group.layers.set(LAYER.FX);
    this.sprites = [];
    const specs = [
      { s: 3.4, o: 0.0, c: 0xfff0d8, a: 0.55 },
      { s: 1.1, o: 0.32, c: 0xffd9a8, a: 0.16 },
      { s: 0.55, o: 0.62, c: 0xa8d8ff, a: 0.13 },
      { s: 1.6, o: 1.15, c: 0xffb0d0, a: 0.09 },
      { s: 0.35, o: 1.5, c: 0xd8ffe0, a: 0.11 },
    ];
    for (const sp of specs) {
      const mat = new THREE.SpriteMaterial({
        map: tex, color: sp.c, transparent: true, opacity: sp.a,
        blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, toneMapped: false,
      });
      const s = new THREE.Sprite(mat);
      s.scale.setScalar(sp.s);
      s.userData.offset = sp.o;
      s.userData.base = sp.a;
      s.layers.set(LAYER.FX);
      this.sprites.push(s);
      this.group.add(s);
    }
    this._v = new THREE.Vector3();
    this._raycaster = new THREE.Raycaster();
  }

  update(camera, sunDir, occlusion = 1) {
    this._v.copy(sunDir).multiplyScalar(1000).add(camera.position).project(camera);
    const onScreen = this._v.z < 1 && Math.abs(this._v.x) < 1.6 && Math.abs(this._v.y) < 1.6;
    const edge = 1 - clamp((Math.max(Math.abs(this._v.x), Math.abs(this._v.y)) - 0.5) / 1.0, 0, 1);
    const vis = onScreen ? edge * occlusion : 0;

    this.group.visible = vis > 0.002;
    if (!this.group.visible) return;

    // Lay the ghosts out along the screen-space line through the frame centre.
    const dist = 12;
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const hh = tan * dist, hw = hh * camera.aspect;
    for (const s of this.sprites) {
      const t = 1 - s.userData.offset * 2;
      const x = this._v.x * t, y = this._v.y * t;
      s.position.set(x * hw, y * hh, -dist);
      s.material.opacity = s.userData.base * vis;
    }
    this.group.position.copy(camera.position);
    this.group.quaternion.copy(camera.quaternion);
  }
}

function makeFlareTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.12, 'rgba(255,255,255,0.72)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.18)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
