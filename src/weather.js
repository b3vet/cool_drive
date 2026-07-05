// ============================================================================
// weather.js — a camera-following rain layer (one Points draw call). Modelled on the
// dust system: wraps around the camera in render space so an origin rebase self-
// corrects. Opacity fades in/out so toggling rain isn't a hard pop. The gameplay side
// of "wet" (grip, road sheen, fog) is composed in main.js/world.js, not here.
// ============================================================================

import * as THREE from 'three';
import { WEATHER } from './config.js';

export function createWeather(scene) {
  const N = WEATHER.rainCount, RANGE = WEATHER.rainRange;
  const pos = new Float32Array(N * 3), vel = new Float32Array(N * 3);
  let s = 7; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (rnd() - 0.5) * RANGE * 2;
    pos[i * 3 + 1] = rnd() * 40 + 2;
    pos[i * 3 + 2] = (rnd() - 0.5) * RANGE * 2;
    vel[i * 3] = (rnd() - 0.5) * 2;
    vel[i * 3 + 1] = -WEATHER.rainFall * (0.85 + rnd() * 0.3);
    vel[i * 3 + 2] = (rnd() - 0.5) * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  const mat = new THREE.PointsMaterial({ color: 0xbfd8ff, size: 0.5, transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true });
  const rain = new THREE.Points(geo, mat);
  rain.frustumCulled = false;
  scene.add(rain);

  let raining = false, vis = 0;
  function setRain(on) { raining = !!on; }

  function update(cam, dt) {
    const target = raining ? WEATHER.rainOpacity : 0;
    vis += (target - vis) * Math.min(dt * 2, 1);
    mat.opacity = vis;
    if (vis < 0.01) { rain.visible = false; return; }
    rain.visible = true;
    for (let i = 0; i < N; i++) {
      let x = pos[i * 3] + vel[i * 3] * dt;
      let y = pos[i * 3 + 1] + vel[i * 3 + 1] * dt;
      let z = pos[i * 3 + 2] + vel[i * 3 + 2] * dt;
      while (x - cam.x > RANGE) x -= RANGE * 2;
      while (x - cam.x < -RANGE) x += RANGE * 2;
      while (z - cam.z > RANGE) z -= RANGE * 2;
      while (z - cam.z < -RANGE) z += RANGE * 2;
      if (y < 0.2) y = 34 + rnd() * 6; // recycle to the top
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    }
    geo.attributes.position.needsUpdate = true;
  }

  return { update, setRain, get raining() { return raining; } };
}
