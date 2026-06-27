// ============================================================================
// scene.js — renderer, lights, fog, gradient sky dome, ground. Time-of-day aware.
// ============================================================================

import * as THREE from 'three';
import { PRESETS, WORLD, CAM } from './config.js';

export function createRenderer(mount) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

  // ground
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x3b3f4a, roughness: 0.96, metalness: 0 });
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

  ctx.preset = p;
  ctx.presetKey = key;
  return p;
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
