// ============================================================================
// scene.js — renderer, lights, fog, gradient sky dome, ground. Time-of-day aware.
// ============================================================================

import * as THREE from 'three';
import { PRESETS, WORLD, CAM, QUALITY, DEFAULT_QUALITY } from './config.js';

// coarse pointer = touch phone/tablet → gentler GPU defaults (heat budget)
export const IS_COARSE = (typeof window !== 'undefined') && (
  (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
  /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent));

// Medium/Low tiers shade the big surfaces (ground here, roads/scenery in world.js) with cheap
// Lambert instead of full PBR. Fixed at boot from the persisted tier (see world.js mat()).
let _cheapShading = true;
try { _cheapShading = (localStorage.getItem('cooldrive.quality') || DEFAULT_QUALITY) !== 'high'; } catch (e) {}

// The context-creation flags (antialias / alpha / stencil) and the shadow FILTER
// type are frozen at renderer construction — changing them later forces a full
// shader recompile — so we pick them ONCE here from the persisted quality tier.
// pixelRatio, shadow-map SIZE, cadence and draw distance still change live per tier.
export function createRenderer(mount) {
  let qk = DEFAULT_QUALITY;
  try { qk = localStorage.getItem('cooldrive.quality') || DEFAULT_QUALITY; } catch (e) {}
  const q = QUALITY[qk] || QUALITY.medium;
  const renderer = new THREE.WebGLRenderer({
    antialias: q.pixelRatio > 1, // MSAA is wasted under 1x; Low renders at 1x so skip it
    powerPreference: 'high-performance',
    alpha: false, // opaque canvas — the page never shows through, so skip compositor blending
    stencil: false, // we never use the stencil buffer
  });
  const cap = IS_COARSE ? Math.min(q.pixelRatio, 1.7) : q.pixelRatio; // 3x phones: 1.7 is ~free vs 2.0
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  // PCFSoft = 16 taps/receiver-fragment; Basic = 1. Hard edges suit the low-poly art.
  renderer.shadowMap.type = q.shadowFilter === 'soft' ? THREE.PCFSoftShadowMap : THREE.BasicShadowMap;
  renderer.shadowMap.autoUpdate = false; // we trigger updates ourselves (throttled) to save GPU
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mount.appendChild(renderer.domElement);
  return renderer;
}

// Gradient sky dome: a big back-side sphere whose fragment color lerps
// top->horizon by world-space height. Horizon matches fog so the edge vanishes.
function makeSky() {
  const geo = new THREE.SphereGeometry(WORLD.groundSize * 0.92, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color() },
      horizonColor: { value: new THREE.Color() },
      offset: { value: 30 },
      exponent: { value: 0.7 },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorldPos;
      void main() {
        float h = normalize(vWorldPos + vec3(0.0, offset, 0.0)).y;
        float t = pow(max(h, 0.0), exponent);
        gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.name = 'sky';
  return sky;
}

export function createScene() {
  const scene = new THREE.Scene();

  const sky = makeSky();
  scene.add(sky);

  // sun / moon disc (glowing sphere far out in the sky)
  const sunDiscMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, transparent: true, opacity: 0.9 });
  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(26, 18, 18), sunDiscMat);
  sunDisc.name = 'sunDisc';
  scene.add(sunDisc);

  // stars (visible at night)
  const starCount = 700;
  const starPos = new Float32Array(starCount * 3);
  const R = WORLD.groundSize * 0.85;
  let seed = 9001;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < starCount; i++) {
    const u = rnd() * 2 - 1;
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    starPos[i * 3] = Math.cos(a) * r * R;
    starPos[i * 3 + 1] = Math.abs(u) * R * 0.9 + 30; // upper hemisphere
    starPos[i * 3 + 2] = Math.sin(a) * r * R;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.4, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  scene.add(stars);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = WORLD.shadowRadius; // fixed frustum that follows the car (open world)
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 400;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  // ground — the single biggest screen-area surface, so its per-fragment cost matters most
  const groundMat = _cheapShading
    ? new THREE.MeshLambertMaterial({ color: 0x3b3f4a })
    : new THREE.MeshStandardMaterial({ color: 0x3b3f4a, roughness: 0.96, metalness: 0 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD.groundSize, WORLD.groundSize), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);

  const camera = new THREE.PerspectiveCamera(CAM.fov, window.innerWidth / window.innerHeight, 0.5, WORLD.groundSize);
  camera.position.set(0, 8, 16);

  const ctx = { scene, camera, sky, hemi, sun, ground, groundMat, sunDisc, sunDiscMat, stars, starMat };
  return ctx;
}

// Apply a time-of-day preset to scene + renderer.
export function applyPreset(ctx, renderer, key) {
  const p = PRESETS[key] || PRESETS.golden;
  ctx.sky.material.uniforms.topColor.value.setHex(p.skyTop);
  ctx.sky.material.uniforms.horizonColor.value.setHex(p.skyHorizon);

  ctx.scene.fog = new THREE.Fog(p.fog, p.fogNear, p.fogFar);
  renderer.setClearColor(p.fog, 1);

  ctx.hemi.color.setHex(p.hemiSky);
  ctx.hemi.groundColor.setHex(p.hemiGround);
  ctx.hemi.intensity = p.hemiIntensity;

  ctx.sun.color.setHex(p.sun);
  ctx.sun.intensity = p.sunIntensity;
  ctx.sun.position.set(p.sunPos[0], p.sunPos[1], p.sunPos[2]);

  ctx.groundMat.color.setHex(p.groundColor);

  // sun/moon disc: place it far out in the sun's direction, tint + opacity per preset
  const sp = p.sunPos;
  const len = Math.hypot(sp[0], sp[1], sp[2]) || 1;
  const far = WORLD.groundSize * 0.72;
  ctx.sunDisc.position.set((sp[0] / len) * far, (sp[1] / len) * far, (sp[2] / len) * far);
  ctx.sunDiscMat.color.setHex(key === 'night' ? 0xdfe6ff : p.sun);
  ctx.sunDiscMat.opacity = key === 'night' ? 0.85 : 0.95;
  ctx.sunDisc.scale.setScalar(key === 'night' ? 0.7 : 1);

  // stars: bright at night, faint at dawn, off at golden hour
  ctx.starMat.opacity = key === 'night' ? 0.9 : key === 'dawn' ? 0.12 : 0;
  ctx.stars.visible = ctx.starMat.opacity > 0.01; // opacity-0 Points still draw + rasterize otherwise

  ctx.preset = p;
  ctx.presetKey = key;
  return p;
}

// ---- continuous preset blend (for the automatic day/night cycle) ------------
// Interpolates every field of preset `ka`→`kb` at fraction t into a module-owned
// blended copy. NEVER mutates the shared PRESETS constants (ctx.preset aliases the
// blend, and trackSun reads ctx.preset.sunPos every frame, so the sun follows for free).
const _bA = new THREE.Color(), _bB = new THREE.Color(), _bNeon = new THREE.Color();
const _blend = { sunPos: [0, 0, 0], neon: 0, night: 0, name: '' };
const MOON = 0xdfe6ff;
const nightF = (k) => (k === 'night' ? 1 : 0);
const starOp = (k) => (k === 'night' ? 0.9 : k === 'dawn' ? 0.12 : 0);
export function applyPresetBlend(ctx, renderer, ka, kb, t) {
  const a = PRESETS[ka] || PRESETS.golden, b = PRESETS[kb] || PRESETS.golden;
  const L = (x, y) => x + (y - x) * t;
  const LC = (out, ha, hb) => { _bA.setHex(ha); _bB.setHex(hb); return out.copy(_bA).lerp(_bB, t); };
  LC(ctx.sky.material.uniforms.topColor.value, a.skyTop, b.skyTop);
  LC(ctx.sky.material.uniforms.horizonColor.value, a.skyHorizon, b.skyHorizon);
  if (!ctx.scene.fog) ctx.scene.fog = new THREE.Fog(0, 1, 2);
  LC(ctx.scene.fog.color, a.fog, b.fog);
  ctx.scene.fog.near = L(a.fogNear, b.fogNear);
  ctx.scene.fog.far = L(a.fogFar, b.fogFar);
  renderer.setClearColor(ctx.scene.fog.color, 1);
  LC(ctx.hemi.color, a.hemiSky, b.hemiSky);
  LC(ctx.hemi.groundColor, a.hemiGround, b.hemiGround);
  ctx.hemi.intensity = L(a.hemiIntensity, b.hemiIntensity);
  LC(ctx.sun.color, a.sun, b.sun);
  ctx.sun.intensity = L(a.sunIntensity, b.sunIntensity);
  const sp = _blend.sunPos;
  sp[0] = L(a.sunPos[0], b.sunPos[0]); sp[1] = L(a.sunPos[1], b.sunPos[1]); sp[2] = L(a.sunPos[2], b.sunPos[2]);
  ctx.sun.position.set(sp[0], sp[1], sp[2]);
  LC(ctx.groundMat.color, a.groundColor, b.groundColor);
  const len = Math.hypot(sp[0], sp[1], sp[2]) || 1, far = WORLD.groundSize * 0.72;
  ctx.sunDisc.position.set((sp[0] / len) * far, (sp[1] / len) * far, (sp[2] / len) * far);
  const na = nightF(ka), nb = nightF(kb);
  _bA.setHex(na ? MOON : a.sun); _bB.setHex(nb ? MOON : b.sun);
  ctx.sunDiscMat.color.copy(_bA).lerp(_bB, t);
  ctx.sunDiscMat.opacity = L(na ? 0.85 : 0.95, nb ? 0.85 : 0.95);
  ctx.sunDisc.scale.setScalar(L(na ? 0.7 : 1, nb ? 0.7 : 1));
  ctx.starMat.opacity = L(starOp(ka), starOp(kb));
  ctx.stars.visible = ctx.starMat.opacity > 0.01; // skip the 700-point draw when fully faded
  _blend.neon = LC(_bNeon, a.neon, b.neon).getHex();
  _blend.night = L(na, nb);
  _blend.name = t < 0.5 ? a.name : b.name;
  ctx.preset = _blend;
  ctx.presetKey = null;
  return _blend;
}

export function onResize(ctx, renderer) {
  // prefer the VISIBLE viewport so nothing hides under iOS Safari's toolbars
  const vv = window.visualViewport;
  const w = (vv && vv.width) || window.innerWidth;
  const h = (vv && vv.height) || window.innerHeight;
  ctx.camera.aspect = w / h;
  ctx.camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
