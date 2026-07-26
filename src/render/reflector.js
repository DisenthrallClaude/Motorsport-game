import * as THREE from 'three';
import { LAYER } from './postfx.js';

/**
 * Planar reflection probe for the road surface.
 *
 * Re-renders the world mirrored about a horizontal plane into an off-screen
 * target. Unlike screen-space reflections this captures geometry that is off
 * screen (building tops, the sky, cars beside you), which is exactly what the
 * wet-street reference shot needs.
 */
export class PlanarReflector {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.scale = opts.scale ?? 0.55;
    this.planeY = opts.planeY ?? 0;
    this.enabled = this.scale > 0.01;

    this.camera = new THREE.PerspectiveCamera();
    this.camera.layers.disableAll();
    this.camera.layers.enable(LAYER.SOLID);
    this.camera.layers.enable(LAYER.SKY);

    this.textureMatrix = new THREE.Matrix4();

    this._normal = new THREE.Vector3(0, 1, 0);
    this._plane = new THREE.Plane();
    this._reflectMat = new THREE.Matrix4();
    this._clipPlane = new THREE.Vector4();
    this._q = new THREE.Vector4();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._rotM = new THREE.Matrix4();
    this._projM = new THREE.Matrix4();

    this.rt = null;
    this._w = 0; this._h = 0;
  }

  setSize(w, h) {
    const rw = Math.max(4, Math.round(w * this.scale));
    const rh = Math.max(4, Math.round(h * this.scale));
    if (rw === this._w && rh === this._h && this.rt) return;
    this._w = rw; this._h = rh;
    if (this.rt) this.rt.dispose();
    this.rt = new THREE.WebGLRenderTarget(rw, rh, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.rt.texture.colorSpace = THREE.NoColorSpace;
  }

  get texture() { return this.rt ? this.rt.texture : null; }

  /**
   * Render one reflection frame.
   * `planeY` may move per-frame (roads have elevation) — we track the height
   * under the camera so reflections stay glued to the surface nearby.
   */
  render(scene, camera, planeY = this.planeY) {
    if (!this.enabled || !this.rt) return;
    this.planeY = planeY;

    const rc = this.camera;
    rc.fov = camera.fov;
    rc.aspect = camera.aspect;
    rc.near = camera.near;
    rc.far = Math.min(camera.far, 3000);

    // ── Build the mirror transform ──────────────────────────────────────────
    this._plane.setFromNormalAndCoplanarPoint(this._normal, this._v.set(0, planeY, 0));
    const n = this._plane.normal, d = this._plane.constant;
    // Householder reflection matrix for the plane.
    this._reflectMat.set(
      1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z, -2 * n.x * d,
      -2 * n.y * n.x, 1 - 2 * n.y * n.y, -2 * n.y * n.z, -2 * n.y * d,
      -2 * n.z * n.x, -2 * n.z * n.y, 1 - 2 * n.z * n.z, -2 * n.z * d,
      0, 0, 0, 1
    );

    camera.updateMatrixWorld();
    rc.matrixWorld.multiplyMatrices(this._reflectMat, camera.matrixWorld);
    // Mirroring flips handedness; flip X of the basis back so culling is sane.
    const e = rc.matrixWorld.elements;
    e[0] = -e[0]; e[1] = -e[1]; e[2] = -e[2];
    rc.matrixWorld.decompose(rc.position, rc.quaternion, rc.scale);
    rc.scale.set(1, 1, 1);
    rc.updateMatrixWorld(true);
    rc.matrixWorldInverse.copy(rc.matrixWorld).invert();
    rc.updateProjectionMatrix();

    // ── Oblique near-plane clipping: nothing below the mirror gets drawn ────
    this._plane.applyMatrix4(rc.matrixWorldInverse);
    this._clipPlane.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const proj = this._projM.copy(rc.projectionMatrix);
    const pe = proj.elements;
    this._q.x = (Math.sign(this._clipPlane.x) + pe[8]) / pe[0];
    this._q.y = (Math.sign(this._clipPlane.y) + pe[9]) / pe[5];
    this._q.z = -1.0;
    this._q.w = (1.0 + pe[10]) / pe[14];
    const cp = this._clipPlane.multiplyScalar(2.0 / this._clipPlane.dot(this._q));
    pe[2] = cp.x; pe[6] = cp.y; pe[10] = cp.z + 1.0; pe[14] = cp.w;
    rc.projectionMatrix.copy(proj);

    // ── Projective texture matrix used by the road shader ───────────────────
    this.textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0
    );
    this.textureMatrix.multiply(rc.projectionMatrix);
    this.textureMatrix.multiply(rc.matrixWorldInverse);

    // ── Draw ────────────────────────────────────────────────────────────────
    const r = this.renderer;
    const prevShadowAuto = r.shadowMap.autoUpdate;
    const prevTarget = r.getRenderTarget();
    r.shadowMap.autoUpdate = false;   // reuse the maps from the main pass
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(scene, rc);
    r.setRenderTarget(prevTarget);
    r.shadowMap.autoUpdate = prevShadowAuto;
  }

  dispose() {
    if (this.rt) this.rt.dispose();
  }
}
