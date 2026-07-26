// ────────────────────────────────────────────────────────────────────────────
//  GLSL library for the post pipeline.
//  All post passes are GLSL ES 1.00 so they run identically on WebGL2 desktop
//  and on the software rasteriser used in CI screenshots.
// ────────────────────────────────────────────────────────────────────────────

/** Fullscreen-triangle vertex shader (three feeds us a PlaneGeometry). */
export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
}
`;

// ── Depth + view-normal prepass ─────────────────────────────────────────────
// Written into an RGBA16F target: rgb = view normal (encoded), a = view depth.
// Uses stock three chunks so instanced meshes work with zero extra effort.
export const DN_VERT = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
varying vec3 vVN;
varying float vVD;
void main() {
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  vVN = normalize(transformedNormal);
  #include <begin_vertex>
  #include <project_vertex>
  vVD = -mvPosition.z;
}
`;

export const DN_FRAG = /* glsl */ `
varying vec3 vVN;
varying float vVD;
void main() {
  gl_FragColor = vec4(normalize(vVN) * 0.5 + 0.5, vVD);
}
`;

// ── SSAO (hemisphere kernel, normal-oriented) ───────────────────────────────
export const SSAO_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDN;
uniform vec2  uProjInfo;      // (1/P00, 1/P11)
uniform mat4  uProj;
uniform vec2  uRes;
uniform float uRadius;
uniform float uIntensity;
uniform float uBias;
uniform float uFar;

const int KERNEL = 12;
// Poisson-ish hemisphere kernel, pre-normalised & scaled for even coverage.
vec3 kern(int i) {
  if (i == 0)  return vec3( 0.5381, 0.1856,  0.4319);
  if (i == 1)  return vec3( 0.1379, 0.2486,  0.4430);
  if (i == 2)  return vec3( 0.3371, 0.5679,  0.0057);
  if (i == 3)  return vec3(-0.6999,-0.0451,  0.0019);
  if (i == 4)  return vec3( 0.0689,-0.1598,  0.8547);
  if (i == 5)  return vec3( 0.0560, 0.0069,  0.1843);
  if (i == 6)  return vec3(-0.0146, 0.1402,  0.0762);
  if (i == 7)  return vec3( 0.0100,-0.1924,  0.0344);
  if (i == 8)  return vec3(-0.3577,-0.5301,  0.4358);
  if (i == 9)  return vec3(-0.3169, 0.1063,  0.0158);
  if (i == 10) return vec3( 0.0103,-0.5869,  0.0046);
  return             vec3(-0.0897,-0.4940,  0.3287);
}

float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }

vec3 viewPosFrom(vec2 uv, float d) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * uProjInfo.x, ndc.y * uProjInfo.y, -1.0) * d;
}

void main() {
  vec4 dn = texture2D(tDN, vUv);
  float depth = dn.a;
  // Sky / nothing → fully unoccluded.
  if (depth <= 0.0 || depth > uFar) { gl_FragColor = vec4(1.0); return; }

  vec3 n = normalize(dn.rgb * 2.0 - 1.0);
  vec3 p = viewPosFrom(vUv, depth);

  float ang = rand(vUv * uRes) * 6.2831853;
  vec3 rvec = vec3(cos(ang), sin(ang), 0.0);
  vec3 t = normalize(rvec - n * dot(rvec, n));
  vec3 b = cross(n, t);
  mat3 tbn = mat3(t, b, n);

  // Shrink the sampling radius with distance so far geometry doesn't smear.
  float radius = uRadius * (1.0 + depth * 0.010);

  float occ = 0.0;
  for (int i = 0; i < KERNEL; i++) {
    vec3 sp = p + (tbn * kern(i)) * radius;
    vec4 clip = uProj * vec4(sp, 1.0);
    vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;

    float sd = texture2D(tDN, suv).a;
    if (sd <= 0.0) continue;

    float sampleDepth = -sp.z;
    float diff = sampleDepth - sd;
    // Range check kills haloing across silhouettes.
    float rangeCheck = smoothstep(0.0, 1.0, radius / max(0.0001, abs(depth - sd)));
    occ += (diff > uBias ? 1.0 : 0.0) * rangeCheck;
  }

  float ao = 1.0 - (occ / float(KERNEL)) * uIntensity;
  gl_FragColor = vec4(clamp(ao, 0.0, 1.0));
}
`;

// ── Depth-aware (bilateral) blur used for the AO buffer ─────────────────────
export const BILATERAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tDN;
uniform vec2 uTexel;
uniform vec2 uDir;

void main() {
  float centerD = texture2D(tDN, vUv).a;
  float sum = 0.0, wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    float fi = float(i);
    vec2 off = uDir * uTexel * fi;
    float d = texture2D(tDN, vUv + off).a;
    float wD = exp(-abs(d - centerD) * 0.6);
    float wG = exp(-fi * fi / 8.0);
    float w = wD * wG;
    sum += texture2D(tSrc, vUv + off).r * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / max(wsum, 0.0001));
}
`;

// ── Bloom: bright pass with soft knee ───────────────────────────────────────
export const BRIGHT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;

void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  c = min(c, vec3(uClamp));
  float br = max(c.r, max(c.g, c.b));
  float soft = br - uThreshold + uKnee;
  soft = clamp(soft, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 0.00001);
  float contrib = max(soft, br - uThreshold) / max(br, 0.00001);
  gl_FragColor = vec4(c * contrib, 1.0);
}
`;

// ── Bloom downsample: COD-style 13-tap partial Karis average ────────────────
export const DOWN_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;

vec3 T(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }

void main() {
  vec3 a = T(vec2(-2.0,  2.0)); vec3 b = T(vec2( 0.0,  2.0)); vec3 c = T(vec2( 2.0,  2.0));
  vec3 d = T(vec2(-2.0,  0.0)); vec3 e = T(vec2( 0.0,  0.0)); vec3 f = T(vec2( 2.0,  0.0));
  vec3 g = T(vec2(-2.0, -2.0)); vec3 h = T(vec2( 0.0, -2.0)); vec3 i = T(vec2( 2.0, -2.0));
  vec3 j = T(vec2(-1.0,  1.0)); vec3 k = T(vec2( 1.0,  1.0));
  vec3 l = T(vec2(-1.0, -1.0)); vec3 m = T(vec2( 1.0, -1.0));

  vec3 res = e * 0.125;
  res += (a + c + g + i) * 0.03125;
  res += (b + d + f + h) * 0.0625;
  res += (j + k + l + m) * 0.125;
  gl_FragColor = vec4(res, 1.0);
}
`;

// ── Bloom upsample: 9-tap tent, additively blended by the pipeline ──────────
export const UP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;

vec3 T(vec2 o) { return texture2D(tSrc, vUv + o * uTexel * uRadius).rgb; }

void main() {
  vec3 res = T(vec2(-1.0,  1.0)) * 1.0 + T(vec2(0.0,  1.0)) * 2.0 + T(vec2(1.0,  1.0)) * 1.0
           + T(vec2(-1.0,  0.0)) * 2.0 + T(vec2(0.0,  0.0)) * 4.0 + T(vec2(1.0,  0.0)) * 2.0
           + T(vec2(-1.0, -1.0)) * 1.0 + T(vec2(0.0, -1.0)) * 2.0 + T(vec2(1.0, -1.0)) * 1.0;
  gl_FragColor = vec4(res / 16.0, 1.0);
}
`;

// ── Volumetric light shafts (radial occlusion blur from the sun) ────────────
export const GODRAY_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;    // HDR scene
uniform sampler2D tDN;     // depth for the sky mask
uniform vec2  uSun;        // sun position in screen space
uniform float uDensity;
uniform float uWeight;
uniform float uDecay;
uniform float uExposure;
uniform float uFar;
uniform float uAspect;

const int STEPS = 28;

void main() {
  vec2 uv = vUv;
  vec2 delta = (uv - uSun);
  delta *= 1.0 / float(STEPS) * uDensity;

  float illum = 1.0;
  vec3 acc = vec3(0.0);
  vec2 c = uv;

  for (int i = 0; i < STEPS; i++) {
    c -= delta;
    float d = texture2D(tDN, c).a;
    // Only unoccluded sky contributes light to the shaft.
    float sky = (d <= 0.0 || d > uFar * 0.985) ? 1.0 : 0.0;
    vec3 s = texture2D(tSrc, c).rgb * sky;
    // Keep only the very bright core so buildings don't glow.
    float lum = max(s.r, max(s.g, s.b));
    s *= smoothstep(1.2, 5.0, lum);
    acc += s * illum * uWeight;
    illum *= uDecay;
  }

  // Fade the whole effect out when the sun is off-screen or behind us.
  vec2 dd = (uv - uSun) * vec2(uAspect, 1.0);
  float falloff = 1.0 - smoothstep(0.15, 1.15, length(dd));
  gl_FragColor = vec4(acc * uExposure * falloff, 1.0);
}
`;

// ── Final composite: motion blur, DOF, AO, bloom, rays, tonemap, grade ──────
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tRays;
uniform sampler2D tAO;
uniform sampler2D tDN;

uniform vec2  uRes;
uniform vec2  uProjInfo;
uniform mat4  uInvView;
uniform mat4  uPrevVP;
uniform float uFar;
uniform float uTime;

uniform float uBloom;
uniform float uRays;
uniform float uAOStrength;
uniform float uExposure;

uniform float uMotionAmount;
uniform float uDofStrength;
uniform float uFocus;
uniform float uDofRange;

uniform vec3  uFogColor;
uniform vec3  uFogSun;
uniform float uFogDensity;
uniform float uFogHeight;
uniform vec2  uSunScreen;

uniform float uVignette;
uniform float uGrain;
uniform float uChroma;
uniform float uSaturation;
uniform float uContrast;
uniform vec3  uLift;
uniform vec3  uGamma;
uniform vec3  uGain;
uniform float uSharpen;

vec3 viewPosFrom(vec2 uv, float d) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * uProjInfo.x, ndc.y * uProjInfo.y, -1.0) * d;
}

// ACES filmic (Stephen Hill fit) — the reference look is very ACES-ish.
const mat3 ACESInput = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);
const mat3 ACESOutput = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602
);
vec3 RRTAndODT(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFitted(vec3 c) {
  c = ACESInput * c;
  c = RRTAndODT(c);
  c = ACESOutput * c;
  return clamp(c, 0.0, 1.0);
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = vUv;
  float depth = texture2D(tDN, uv).a;
  bool isSky = (depth <= 0.0 || depth > uFar * 0.99);
  float lin = isSky ? uFar : depth;

  // ── Chromatic aberration: radial, strongest at the frame edge ────────────
  vec2 cc = uv - 0.5;
  float r2 = dot(cc, cc);
  vec2 caOff = cc * r2 * uChroma;

  // ── Camera motion blur, reconstructed from depth + previous VP ───────────
  vec3 vpos = viewPosFrom(uv, lin);
  vec4 wpos = uInvView * vec4(vpos, 1.0);
  vec4 prevClip = uPrevVP * wpos;
  vec2 prevUv = (prevClip.xy / max(prevClip.w, 0.0001)) * 0.5 + 0.5;
  vec2 vel = (uv - prevUv) * uMotionAmount;
  // Radial bias: keep the middle of the screen (the car) crisp.
  vel *= smoothstep(0.02, 0.34, length(cc));
  vel = clamp(vel, vec2(-0.06), vec2(0.06));

  // ── Depth of field: circle of confusion, subtle & cinematic ──────────────
  float coc = clamp(abs(lin - uFocus) / uDofRange, 0.0, 1.0);
  coc = pow(coc, 1.5) * uDofStrength;
  float blurPx = coc * 5.0;

  vec3 scene = vec3(0.0);
  float wsum = 0.0;
  const int TAPS = 7;
  for (int i = 0; i < TAPS; i++) {
    float t = float(i) / float(TAPS - 1) - 0.5;         // -0.5 … 0.5
    vec2 off = vel * t;
    // Blend a small disc for DOF on top of the linear motion smear.
    float a = float(i) * 2.39996;                        // golden angle
    off += vec2(cos(a), sin(a)) * blurPx / uRes * (0.4 + 0.6 * fract(float(i) * 0.618));
    vec2 suv = clamp(uv + off, vec2(0.0015), vec2(0.9985));
    vec3 s;
    s.r = texture2D(tScene, suv + caOff).r;
    s.g = texture2D(tScene, suv).g;
    s.b = texture2D(tScene, suv - caOff).b;
    float w = 1.0;
    scene += s * w;
    wsum += w;
  }
  scene /= wsum;

  // ── Sharpen (unsharp mask) restores micro-detail eaten by MSAA + blur ────
  if (uSharpen > 0.0) {
    vec2 px = 1.0 / uRes;
    vec3 blur = texture2D(tScene, uv + vec2(px.x, 0.0)).rgb
              + texture2D(tScene, uv - vec2(px.x, 0.0)).rgb
              + texture2D(tScene, uv + vec2(0.0, px.y)).rgb
              + texture2D(tScene, uv - vec2(0.0, px.y)).rgb;
    blur *= 0.25;
    scene += (scene - blur) * uSharpen;
  }

  // ── Ambient occlusion ────────────────────────────────────────────────────
  float ao = texture2D(tAO, uv).r;
  ao = mix(1.0, ao, uAOStrength * (isSky ? 0.0 : 1.0));
  scene *= ao;

  // ── Height + distance fog with forward sun scattering ────────────────────
  if (!isSky) {
    vec3 worldPos = wpos.xyz;
    float camY = uInvView[3][1];
    float h = max(worldPos.y, -20.0);
    // Analytic height fog integral along the view ray.
    float heightFactor = exp(-max(0.0, h - 1.0) / uFogHeight);
    float fogAmt = 1.0 - exp(-lin * uFogDensity * heightFactor);
    fogAmt = clamp(fogAmt, 0.0, 0.94);
    vec2 sd = uv - uSunScreen;
    float sunAmt = exp(-dot(sd, sd) * 5.0);
    vec3 fogC = mix(uFogColor, uFogSun, sunAmt * 0.85);
    scene = mix(scene, fogC, fogAmt);
  }

  // ── Bloom + light shafts ─────────────────────────────────────────────────
  vec3 bloom = texture2D(tBloom, uv).rgb;
  scene += bloom * uBloom;
  scene += texture2D(tRays, uv).rgb * uRays;

  // ── Exposure & tonemap ───────────────────────────────────────────────────
  scene *= uExposure;
  vec3 col = acesFitted(scene);

  // ── Grade: lift / gamma / gain, then contrast + saturation ───────────────
  col = col * uGain + uLift * (1.0 - col);
  col = pow(max(col, vec3(0.0)), uGamma);
  col = (col - 0.5) * uContrast + 0.5;
  float l = luma(col);
  col = mix(vec3(l), col, uSaturation);

  // ── Vignette ─────────────────────────────────────────────────────────────
  float vig = 1.0 - uVignette * smoothstep(0.25, 1.35, length(cc) * 1.7);
  col *= vig;

  // ── Film grain, luminance-weighted so shadows stay clean-ish ─────────────
  float g = hash12(uv * uRes + fract(uTime) * 1731.0) - 0.5;
  col += g * uGrain * (0.35 + 0.65 * (1.0 - l));

  col = clamp(col, 0.0, 1.0);

  // ── sRGB OETF. Every pass downstream of here works in display space, and
  //    the default framebuffer expects encoded values.
  col = mix(col * 12.92, 1.055 * pow(col, vec3(0.41666)) - 0.055, step(0.0031308, col));

  gl_FragColor = vec4(col, 1.0);
}
`;

// ── FXAA (final AA pass over the tonemapped image) ──────────────────────────
export const FXAA_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;

#define SPAN_MAX 8.0
#define REDUCE_MUL (1.0/8.0)
#define REDUCE_MIN (1.0/128.0)

void main() {
  vec3 rgbNW = texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture2D(tSrc, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture2D(tSrc, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 rgbSE = texture2D(tSrc, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
  vec3 rgbM  = texture2D(tSrc, vUv).rgb;

  vec3 luma = vec3(0.299, 0.587, 0.114);
  float lNW = dot(rgbNW, luma), lNE = dot(rgbNE, luma);
  float lSW = dot(rgbSW, luma), lSE = dot(rgbSE, luma);
  float lM  = dot(rgbM,  luma);

  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * REDUCE_MUL, REDUCE_MIN);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-SPAN_MAX), vec2(SPAN_MAX)) * uTexel;

  vec3 rgbA = 0.5 * (texture2D(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
                     texture2D(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tSrc, vUv - dir * 0.5).rgb +
                                   texture2D(tSrc, vUv + dir * 0.5).rgb);
  float lB = dot(rgbB, luma);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}
`;

// ── Simple copy / blit ──────────────────────────────────────────────────────
export const COPY_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform float uOpacity;
void main() { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0) * uOpacity; }
`;

// ── Physical sky (Preetham-ish, tuned for filmic dawn/dusk) ─────────────────
export const SKY_VERT = /* glsl */ `
varying vec3 vWorldDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w; // force to far plane
}
`;

export const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorldDir;

uniform vec3  uSunDir;
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uGround;
uniform vec3  uSunColor;
uniform float uSunSize;
uniform float uSunIntensity;
uniform float uHaze;
uniform float uCloud;
uniform float uCloudSharp;
uniform vec3  uCloudColor;
uniform vec3  uCloudDark;
uniform float uTime;
uniform float uStars;
uniform float uExposure;

float hash(vec2 p) {
  p = fract(p * vec2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec3 d = normalize(vWorldDir);
  float up = d.y;
  float cosSun = dot(d, uSunDir);

  // ── Base gradient: ground haze → horizon → zenith ────────────────────────
  float t = clamp(up, -1.0, 1.0);
  float horizonBlend = pow(1.0 - clamp(abs(t) / (uHaze + 0.0001), 0.0, 1.0), 2.2);
  vec3 sky = mix(uZenith, uHorizon, horizonBlend);
  sky = mix(sky, uGround, smoothstep(0.02, -0.12, t));

  // ── Mie forward scattering halo around the sun ───────────────────────────
  float mie = pow(max(cosSun, 0.0), 8.0) * 0.55
            + pow(max(cosSun, 0.0), 64.0) * 0.6
            + pow(max(cosSun, 0.0), 2.0) * 0.16;
  // Scattering hugs the horizon, which is what sells low-sun shots.
  float horizonBoost = 1.0 + 2.4 * pow(1.0 - clamp(abs(t) * 3.0, 0.0, 1.0), 2.0);
  sky += uSunColor * mie * horizonBoost * uSunIntensity;

  // ── Sun disc with a soft limb ────────────────────────────────────────────
  float sunDisc = smoothstep(cos(uSunSize * 2.4), cos(uSunSize), cosSun);
  sky += uSunColor * sunDisc * 22.0 * uSunIntensity;

  // ── Stars (night presets only) ───────────────────────────────────────────
  if (uStars > 0.0 && up > 0.0) {
    vec2 sp = d.xz / max(d.y, 0.06) * 10.0;
    float s = hash(floor(sp * 34.0));
    float star = smoothstep(0.9955, 1.0, s) * (0.55 + 0.45 * sin(uTime * 2.4 + s * 90.0));
    sky += vec3(0.85, 0.9, 1.0) * star * uStars * smoothstep(0.0, 0.35, up);
  }

  // ── Cloud layer, projected on a virtual dome ─────────────────────────────
  if (uCloud > 0.001 && up > -0.02) {
    float pl = 1.0 / max(up + 0.09, 0.055);
    vec2 cuv = d.xz * pl * 0.55 + vec2(uTime * 0.0045, uTime * 0.0022);
    float n = fbm(cuv * 1.15);
    float n2 = fbm(cuv * 2.7 + 13.1);
    float c = smoothstep(0.52 - uCloud * 0.34, 0.52 + (1.0 - uCloudSharp) * 0.42, n * 0.72 + n2 * 0.28);
    c *= smoothstep(-0.02, 0.16, up);
    // Light the cloud from the sun direction using the density gradient.
    float lit = clamp(0.42 + 0.58 * pow(max(cosSun, 0.0), 2.2) + (n2 - 0.5) * 0.9, 0.0, 1.6);
    vec3 cc = mix(uCloudDark, uCloudColor, lit);
    cc += uSunColor * pow(max(cosSun, 0.0), 22.0) * 1.6 * uSunIntensity;
    sky = mix(sky, cc, clamp(c * uCloud * 1.35, 0.0, 0.97));
  }

  gl_FragColor = vec4(sky * uExposure, 1.0);
}
`;
