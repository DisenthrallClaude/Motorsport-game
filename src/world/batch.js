import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Collects thousands of small pieces of world geometry and emits one merged
 * mesh per material. A whole city ends up as ~20 draw calls instead of ~8000,
 * which is what makes the dense street dressing affordable.
 */
export class GeoBatcher {
  constructor() {
    this.buckets = new Map();   // material -> { geos: [], mat, shadow, layer }
    this._m = new THREE.Matrix4();
  }

  /**
   * @param {THREE.BufferGeometry} geo  source geometry (not consumed)
   * @param {THREE.Material} mat        shared material instance
   * @param {THREE.Matrix4|THREE.Object3D} xform placement
   */
  add(geo, mat, xform, opts = {}) {
    let b = this.buckets.get(mat);
    if (!b) {
      b = { geos: [], mat, castShadow: opts.castShadow ?? true, receiveShadow: opts.receiveShadow ?? true, layer: opts.layer, renderOrder: opts.renderOrder ?? 0 };
      this.buckets.set(mat, b);
    }
    const g = geo.clone();
    if (xform) {
      if (xform.isMatrix4) g.applyMatrix4(xform);
      else { xform.updateMatrixWorld(true); g.applyMatrix4(xform.matrixWorld); }
    }
    // Merging requires identical attribute sets.
    if (!g.attributes.uv) {
      const count = g.attributes.position.count;
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    }
    if (!g.index) {
      const count = g.attributes.position.count;
      const idx = new Uint32Array(count);
      for (let i = 0; i < count; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    b.geos.push(g);
    return this;
  }

  /** Place a mesh (and its children) into the batch, keeping materials. */
  addObject(obj) {
    obj.updateMatrixWorld(true);
    obj.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.length === 1) {
        this.add(o.geometry, mats[0], o.matrixWorld, {
          castShadow: o.castShadow, receiveShadow: o.receiveShadow,
        });
      } else if (o.geometry.groups && o.geometry.groups.length) {
        // Split multi-material geometry into per-material slices.
        for (const grp of o.geometry.groups) {
          const sliced = sliceGeometry(o.geometry, grp.start, grp.count);
          if (sliced) this.add(sliced, mats[grp.materialIndex] || mats[0], o.matrixWorld, {
            castShadow: o.castShadow, receiveShadow: o.receiveShadow,
          });
        }
      }
    });
    return this;
  }

  /** Merge every bucket and return a group. */
  build(name = 'batch') {
    const group = new THREE.Group();
    group.name = name;
    for (const b of this.buckets.values()) {
      if (!b.geos.length) continue;
      let merged;
      try {
        merged = BufferGeometryUtils.mergeGeometries(b.geos, false);
      } catch (e) {
        merged = null;
      }
      if (!merged) {
        // Fall back to individual meshes rather than dropping the geometry.
        for (const g of b.geos) {
          const m = new THREE.Mesh(g, b.mat);
          m.castShadow = b.castShadow; m.receiveShadow = b.receiveShadow;
          if (b.layer !== undefined) m.layers.set(b.layer);
          group.add(m);
        }
        continue;
      }
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, b.mat);
      mesh.castShadow = b.castShadow;
      mesh.receiveShadow = b.receiveShadow;
      mesh.renderOrder = b.renderOrder;
      if (b.layer !== undefined) mesh.layers.set(b.layer);
      group.add(mesh);
      for (const g of b.geos) g.dispose();
    }
    this.buckets.clear();
    return group;
  }

  get pieceCount() {
    let n = 0;
    for (const b of this.buckets.values()) n += b.geos.length;
    return n;
  }
}

function sliceGeometry(geo, start, count) {
  if (!geo.index) return null;
  const idx = geo.index.array;
  const used = new Map();
  const newIdx = [];
  for (let i = start; i < start + count; i++) {
    const v = idx[i];
    if (!used.has(v)) used.set(v, used.size);
    newIdx.push(used.get(v));
  }
  const g = new THREE.BufferGeometry();
  for (const name of Object.keys(geo.attributes)) {
    const src = geo.attributes[name];
    const itemSize = src.itemSize;
    const arr = new Float32Array(used.size * itemSize);
    for (const [oldV, newV] of used) {
      for (let c = 0; c < itemSize; c++) arr[newV * itemSize + c] = src.array[oldV * itemSize + c];
    }
    g.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
  }
  g.setIndex(newIdx);
  return g;
}

/**
 * InstancedMesh helper for repeated identical props (lamps, bollards, trees).
 * Cheaper than merging when the same mesh appears hundreds of times.
 */
export class InstanceSet {
  constructor(geometry, material, max) {
    this.geometry = geometry;
    this.material = material;
    this.max = max;
    this.matrices = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
  }

  place(pos, rotY = 0, scale = 1, tiltX = 0, tiltZ = 0) {
    this._e.set(tiltX, rotY, tiltZ, 'YXZ');
    this._q.setFromEuler(this._e);
    this._s.setScalar(1);
    if (typeof scale === 'number') this._s.setScalar(scale);
    else this._s.copy(scale);
    this._m.compose(pos, this._q, this._s);
    this.matrices.push(this._m.clone());
    return this;
  }

  build(castShadow = true, receiveShadow = true) {
    if (!this.matrices.length) return null;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, this.matrices.length);
    for (let i = 0; i < this.matrices.length; i++) mesh.setMatrixAt(i, this.matrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.frustumCulled = true;
    mesh.computeBoundingSphere();
    return mesh;
  }
}
