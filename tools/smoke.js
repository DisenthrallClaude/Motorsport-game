import * as THREE from 'three';
import { Engine, LAYER } from '../src/core/engine.js';
import { makeRoadMaterial, updateRoadMaterials, makeCarPaint, makeSurface } from '../src/render/materials.js';
import { makeRoadTexture, makePavement } from '../src/render/textures.js';

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));

const eng = new Engine(document.getElementById('stage'), 'high');
eng.applyTheme({
  sky: {
    sunAzimuth: 8, sunElevation: 7,
    zenith: 0x3a6ea8, horizon: 0xd9c9ae, groundHaze: 0x6a6357,
    sunColor: 0xffd3a0, sunIntensity: 4.2, lightColor: 0xffe0bb,
    haze: 0.55, cloud: 0.55, cloudSharp: 0.45,
    hemiSky: 0x9fc0f0, hemiGround: 0x4a4438, hemiIntensity: 1.1,
    rimColor: 0x9ec4ff, rimIntensity: 0.6, shadowRadius: 80,
  },
  fog: { color: 0xa9b6c6, sunColor: 0xffd7a8, density: 0.0045, height: 70 },
  grade: { exposure: 1.05, bloom: 0.6, rays: 0.6 },
});

const rt = makeRoadTexture({ roadWidth: 15, tileLength: 12, markings: 'uk' });
const roadMat = makeRoadMaterial({ textures: rt, wetness: 0.8 });
rt.map.repeat.set(1, 20); rt.normalMap.repeat.set(1, 20); rt.roughnessMap.repeat.set(1, 20);
const road = new THREE.Mesh(new THREE.PlaneGeometry(15, 240, 1, 40), roadMat);
road.rotation.x = -Math.PI / 2;
road.receiveShadow = true;
road.layers.set(LAYER.MIRROR);
eng.scene.add(road);

const pave = makeSurface(makePavement({ style: 'slab' }), { repeat: [3, 40], roughness: 0.85 });
for (const s of [-1, 1]) {
  const g = new THREE.Mesh(new THREE.BoxGeometry(9, 0.22, 240), pave);
  g.position.set(s * 12, 0.11, 0);
  g.receiveShadow = true; g.castShadow = true;
  eng.scene.add(g);
}

// Buildings
const bmat = new THREE.MeshStandardMaterial({ color: 0x9a9088, roughness: 0.86 });
for (let i = 0; i < 26; i++) {
  for (const s of [-1, 1]) {
    const h = 12 + Math.random() * 26;
    const b = new THREE.Mesh(new THREE.BoxGeometry(10, h, 8.5), bmat);
    b.position.set(s * 21, h / 2, -110 + i * 9);
    b.castShadow = true; b.receiveShadow = true;
    eng.scene.add(b);
  }
}

// Test car
const car = new THREE.Group();
const body = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.62, 4.6), makeCarPaint(0x20242c));
body.position.y = 0.62; body.castShadow = true;
car.add(body);
eng.scene.add(car);
car.position.set(0, 0, 4);

eng.camera.position.set(0, 1.9, 11.5);
eng.camera.lookAt(0, 1.1, -20);

let t = 0, frames = 0;
function loop() {
  const dt = 1 / 60;
  t += dt; frames++;
  updateRoadMaterials([roadMat], eng.reflector, t, 0.3);
  eng.render(dt, car.position, 0);
  requestAnimationFrame(loop);
}
loop();

window.__diag = () => ({
  frames,
  errors,
  webgl2: eng.capabilities.webgl2,
  drawCalls: eng.renderer.info.render.calls,
  triangles: eng.renderer.info.render.triangles,
  programs: eng.renderer.info.programs?.length,
  rtSize: [eng.postfx.width, eng.postfx.height],
  reflSize: eng.reflector.rt ? [eng.reflector.rt.width, eng.reflector.rt.height] : null,
});
