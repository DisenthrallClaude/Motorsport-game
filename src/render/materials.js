import * as THREE from 'three';
import { makeAsphalt, makeRoadTexture, makePuddleMask, makeRippleNormal, makePavement } from './textures.js';

// ════════════════════════════════════════════════════════════════════════════
//  WET ROAD
//  A standard PBR material with planar reflections, puddles and rain ripples
//  injected. Keeping three's lighting intact means shadows, IBL and the sun
//  all still behave — we only add the mirror term on top.
// ════════════════════════════════════════════════════════════════════════════
export function makeRoadMaterial(opts = {}) {
  const {
    textures, wetness = 0.55, reflectTint = 0xffffff,
    roughness = 0.86, color = 0xffffff, puddleScale = 0.012,
    reflectStrength = 1.0, rippleSpeed = 1.0,
  } = opts;

  const mat = new THREE.MeshStandardMaterial({
    map: textures.map,
    normalMap: textures.normalMap,
    roughnessMap: textures.roughnessMap,
    roughness,
    metalness: 0.02,
    color,
    envMapIntensity: 0.55,
    normalScale: new THREE.Vector2(0.9, 0.9),
    dithering: true,
  });

  const uniforms = {
    uReflTex: { value: null },
    uTextureMatrix: { value: new THREE.Matrix4() },
    uWetness: { value: wetness },
    uReflStrength: { value: reflectStrength },
    uReflTint: { value: new THREE.Color(reflectTint) },
    uPuddleMap: { value: makePuddleMask(512, 3, 0.55) },
    uRipple: { value: makeRippleNormal(256, 5) },
    uPuddleScale: { value: puddleScale },
    uTime: { value: 0 },
    uRainAmount: { value: 0 },
    uRippleSpeed: { value: rippleSpeed },
    uHasRefl: { value: 0 },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform mat4 uTextureMatrix;
         varying vec4 vReflUv;
         varying vec3 vWPos;`
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
         vec4 _wp = modelMatrix * vec4(transformed, 1.0);
         #ifdef USE_INSTANCING
           _wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
         #endif
         vWPos = _wp.xyz;
         vReflUv = uTextureMatrix * _wp;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D uReflTex;
         uniform sampler2D uPuddleMap;
         uniform sampler2D uRipple;
         uniform vec3  uReflTint;
         uniform float uWetness;
         uniform float uReflStrength;
         uniform float uPuddleScale;
         uniform float uTime;
         uniform float uRainAmount;
         uniform float uRippleSpeed;
         uniform float uHasRefl;
         varying vec4 vReflUv;
         varying vec3 vWPos;`
      )
      // Puddles are smoother than the surrounding tarmac — do this before the
      // lighting maths so the sun's specular highlight reacts too.
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         vec2 _pw = vWPos.xz * uPuddleScale;
         float _puddle = texture2D(uPuddleMap, _pw).r;
         float _wet = clamp(uWetness * (0.28 + _puddle * 1.25), 0.0, 1.0);
         roughnessFactor = mix(roughnessFactor, 0.055 + roughnessFactor * 0.10, _wet);`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         if (uRainAmount > 0.001) {
           vec2 _ruv = vWPos.xz * 0.35;
           float _t = uTime * uRippleSpeed;
           vec3 _r1 = texture2D(uRipple, _ruv + vec2(_t * 0.06, _t * 0.05)).rgb * 2.0 - 1.0;
           vec3 _r2 = texture2D(uRipple, _ruv * 1.9 - vec2(_t * 0.045, _t * 0.07)).rgb * 2.0 - 1.0;
           vec3 _rip = normalize(_r1 + _r2 * 0.6);
           normal = normalize(mix(normal, normalize(normal + _rip * 0.55), _wet * uRainAmount));
         }`
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
         if (uHasRefl > 0.5 && _wet > 0.004) {
           vec3 _V = normalize(vViewPosition);
           float _fres = pow(clamp(1.0 - dot(normalize(normal), _V), 0.0, 1.0), 4.0);
           _fres = mix(0.045, 1.0, _fres);

           vec2 _ruv = vReflUv.xy / max(vReflUv.w, 0.0001);
           // Wobble the mirror image with the surface normal: this is what
           // makes wet tarmac read as *wet* rather than as polished glass.
           vec2 _dist = (normal.xy - vec2(0.0, 0.0)) * 0.055 * (0.35 + _puddle);
           _ruv += _dist;

           // Roughness-driven blur, stretched vertically like a real reflection.
           float _blur = (0.0035 + roughnessFactor * 0.055) * (1.0 - _puddle * 0.55);
           vec3 _refl = vec3(0.0);
           _refl += texture2D(uReflTex, clamp(_ruv, 0.001, 0.999)).rgb * 0.44;
           _refl += texture2D(uReflTex, clamp(_ruv + vec2( _blur * 0.35, -_blur * 1.7), 0.001, 0.999)).rgb * 0.19;
           _refl += texture2D(uReflTex, clamp(_ruv + vec2(-_blur * 0.35, -_blur * 3.1), 0.001, 0.999)).rgb * 0.14;
           _refl += texture2D(uReflTex, clamp(_ruv + vec2( _blur * 0.9,  -_blur * 0.7), 0.001, 0.999)).rgb * 0.12;
           _refl += texture2D(uReflTex, clamp(_ruv + vec2(-_blur * 0.9,  -_blur * 5.0), 0.001, 0.999)).rgb * 0.11;

           float _k = clamp(_wet * _fres * uReflStrength, 0.0, 0.94);
           gl_FragColor.rgb = mix(gl_FragColor.rgb, _refl * uReflTint, _k);
           // Slight darkening under standing water sells the depth.
           gl_FragColor.rgb *= mix(1.0, 0.82, _puddle * uWetness);
         }`
      );
    mat.userData.shader = shader;
  };
  mat.customProgramCacheKey = () => 'wetroad-v3';
  return mat;
}

/** Feed the current planar reflection into every road material. */
export function updateRoadMaterials(mats, reflector, time, rain) {
  for (const m of mats) {
    const u = m.userData.uniforms;
    if (!u) continue;
    u.uTime.value = time;
    u.uRainAmount.value = rain;
    if (reflector && reflector.texture) {
      u.uReflTex.value = reflector.texture;
      u.uTextureMatrix.value.copy(reflector.textureMatrix);
      u.uHasRefl.value = 1;
    } else {
      u.uHasRefl.value = 0;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  VEHICLE MATERIALS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Bodywork is glossy enough that a light sitting behind the camera produces a
 * near-mirror retro-reflection: the GGX peak for a clearcoat at roughness 0.05
 * is in the hundreds, which turns the whole car into a white silhouette once
 * ACES gets hold of it. Real renderers avoid this by giving the sun an angular
 * size; here we do the cheap equivalent — floor the roughness used for direct
 * lighting and cap the material's HDR output so glints still bloom but never
 * flood the panel.
 */
function clampHighlights(mat, { minRough = 0.16, minClearcoatRough = 0.20, hdrCeiling = 4.2 } = {}) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uMinRough = { value: minRough };
    shader.uniforms.uMinCCRough = { value: minClearcoatRough };
    shader.uniforms.uHdrCeiling = { value: hdrCeiling };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uMinRough;
        uniform float uMinCCRough;
        uniform float uHdrCeiling;`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.roughness = max(material.roughness, uMinRough);
        #ifdef USE_CLEARCOAT
          material.clearcoatRoughness = max(material.clearcoatRoughness, uMinCCRough);
        #endif`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(uHdrCeiling));`);
  };
  // three's default cache key reads `this.onBeforeCompile`, so it has to stay
  // bound to the material.
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${prevKey()}|clamp${minRough}:${minClearcoatRough}:${hdrCeiling}`;
  return mat;
}

export function makeCarPaint(color = 0x1a1c22, opts = {}) {
  const {
    metalness = 0.72, roughness = 0.24, clearcoat = 0.9,
    clearcoatRoughness = 0.09, flake = 0.55, envIntensity = 1.1,
  } = opts;
  const m = new THREE.MeshPhysicalMaterial({
    color,
    metalness,
    roughness,
    clearcoat,
    clearcoatRoughness,
    envMapIntensity: envIntensity,
    sheen: 0.0,
    reflectivity: 0.6,
    dithering: true,
  });
  // Metallic flake: a very high-frequency perturbation of the normal, only
  // visible at grazing angles under a strong light. Subtle but expensive-looking.
  if (flake > 0) {
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uFlake = { value: flake };
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uFlake;
          float _fhash(vec3 p){ p = fract(p*0.3183099+vec3(0.1,0.2,0.3)); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            vec3 fp = floor(vViewPosition * 620.0);
            vec3 j = vec3(_fhash(fp), _fhash(fp + 11.3), _fhash(fp + 27.7)) - 0.5;
            normal = normalize(normal + j * 0.055 * uFlake);
          }`);
    };
    m.customProgramCacheKey = () => 'carpaint-flake';
  }
  return clampHighlights(m, { minRough: 0.18, minClearcoatRough: 0.22, hdrCeiling: 2.8 });
}

export function makeGlass(opts = {}) {
  const { color = 0x0a0d12, opacity = 0.62, roughness = 0.09 } = opts;
  return clampHighlights(new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.0,
    roughness,
    transparent: true,
    opacity,
    envMapIntensity: 1.5,
    clearcoat: 0.6,
    clearcoatRoughness: 0.14,
    side: THREE.DoubleSide,
    depthWrite: false,
    premultipliedAlpha: false,
  }), { minRough: 0.11, minClearcoatRough: 0.17, hdrCeiling: 3.0 });
}

export function makeChrome(color = 0xdfe3e8, roughness = 0.14) {
  return clampHighlights(new THREE.MeshStandardMaterial({
    color, metalness: 1.0, roughness, envMapIntensity: 1.4,
  }), { minRough: 0.17, hdrCeiling: 3.2 });
}

export function makeCarbon(scale = 1) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#141519';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#22242b';
  for (let y = 0; y < 128; y += 8) {
    for (let x = 0; x < 128; x += 8) {
      if (((x / 8) + (y / 8)) % 2 === 0) g.fillRect(x, y, 8, 8);
    }
  }
  g.globalAlpha = 0.25;
  g.fillStyle = '#3b3f49';
  for (let i = 0; i < 400; i++) {
    g.fillRect(Math.random() * 128, Math.random() * 128, 2, 1);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6 * scale, 6 * scale);
  t.colorSpace = THREE.SRGBColorSpace;
  return clampHighlights(new THREE.MeshPhysicalMaterial({
    map: t, metalness: 0.38, roughness: 0.44, clearcoat: 0.32, clearcoatRoughness: 0.30,
    envMapIntensity: 0.75,
  }), { minRough: 0.32, minClearcoatRough: 0.30, hdrCeiling: 1.7 });
}

export function makeRubber(color = 0x14151a) {
  return clampHighlights(
    new THREE.MeshStandardMaterial({ color, metalness: 0.0, roughness: 0.92, envMapIntensity: 0.35 }),
    { minRough: 0.55, hdrCeiling: 1.3 }
  );
}

export function makeEmissive(color = 0xff2020, intensity = 4) {
  const m = new THREE.MeshStandardMaterial({
    color: 0x0a0a0a, emissive: color, emissiveIntensity: intensity,
    roughness: 0.35, metalness: 0.0, toneMapped: true,
  });
  return m;
}

// ════════════════════════════════════════════════════════════════════════════
//  WORLD MATERIAL FACTORY
// ════════════════════════════════════════════════════════════════════════════
export function makeSurface(tex, opts = {}) {
  const {
    repeat = [1, 1], roughness = 0.9, metalness = 0.0, color = 0xffffff,
    envMapIntensity = 0.6, normalScale = 1.0, side = THREE.FrontSide,
  } = opts;
  const clone = (t) => {
    if (!t) return null;
    const c = t.clone();
    c.needsUpdate = true;
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.repeat.set(repeat[0], repeat[1]);
    return c;
  };
  return new THREE.MeshStandardMaterial({
    map: clone(tex.map),
    normalMap: clone(tex.normalMap),
    roughnessMap: clone(tex.roughnessMap),
    emissiveMap: tex.emissiveMap ? clone(tex.emissiveMap) : null,
    emissive: tex.emissiveMap ? 0xffffff : 0x000000,
    emissiveIntensity: tex.emissiveMap ? 1.0 : 0,
    normalScale: new THREE.Vector2(normalScale, normalScale),
    roughness, metalness, color, envMapIntensity, side,
    dithering: true,
  });
}

export { makeAsphalt, makeRoadTexture, makePavement };
