// Isolated car viewer for material / geometry work.
//   ?post=0   bypass the post pipeline (raw three render)
//   ?a=0.9    orbit angle in radians
//   ?d=8      camera distance
import * as THREE from 'three';
import { Engine } from '../src/core/engine.js';
import { CarModel, CAR_PRESETS } from '../src/vehicle/carmodel.js';
import { THEMES } from '../src/data/themes.js';

const q = new URLSearchParams(location.search);
const eng = new Engine(document.getElementById('stage'), q.get('q') || 'high');
const theme = THEMES.find((t) => t.id === (q.get('city') || 'london'));
eng.applyTheme(theme);
eng.postfx.grade.fogDensity = 0;
eng.postfx.grade.dof = 0;

// A neutral ground so the car has something to sit on and cast onto.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(160, 160),
  new THREE.MeshStandardMaterial({ color: 0x2c2d31, roughness: 0.55, metalness: 0.0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
eng.scene.add(ground);

const car = new CarModel(CAR_PRESETS[Number(q.get('preset') || 0)], true);
eng.scene.add(car.group);
car.setLights({ headlights: Number(q.get('lights') || 0), brake: 0, reverse: 0, brakeHeat: 0 });

const angle = Number(q.get('a') ?? 0.9);
const dist = Number(q.get('d') ?? 8);
const height = Number(q.get('h') ?? 2.0);
eng.camera.position.set(Math.sin(angle) * dist, height, Math.cos(angle) * dist);
eng.camera.lookAt(0, 0.6, 0);
eng.camera.fov = 42;
eng.camera.updateProjectionMatrix();

const usePost = q.get('post') !== '0';
let t = 0, frames = 0;
function loop() {
  const dt = 1 / 60;
  t += dt; frames++;
  if (usePost) {
    eng.render(dt, new THREE.Vector3(0, 0.5, 0), 0);
  } else {
    eng.sky.update(eng.camera, new THREE.Vector3(), t);
    eng.renderer.setRenderTarget(null);
    eng.renderer.render(eng.scene, eng.camera);
  }
  requestAnimationFrame(loop);
}
loop();

// Report what the body geometry actually looks like.
const geo = car.bodyMesh.geometry;
window.__diag = () => ({
  frames,
  bodyVerts: geo.attributes.position.count,
  bodyIndices: geo.index ? geo.index.count : 0,
  bodyBounds: geo.boundingSphere ? {
    r: +geo.boundingSphere.radius.toFixed(2),
    c: geo.boundingSphere.center.toArray().map((v) => +v.toFixed(2)),
  } : null,
  meshes: (() => { let n = 0; car.group.traverse((o) => { if (o.isMesh) n++; }); return n; })(),
  paint: {
    color: '#' + car.bodyMesh.material.color.getHexString(),
    metalness: car.bodyMesh.material.metalness,
    roughness: car.bodyMesh.material.roughness,
    clearcoat: car.bodyMesh.material.clearcoat,
    env: car.bodyMesh.material.envMapIntensity,
  },
  sceneEnvIntensity: eng.scene.environmentIntensity,
  drawCalls: eng.renderer.info.render.calls,
});
