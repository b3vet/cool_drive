// ============================================================================
// effects.js — drift feedback:
//   • SkidMarks: a flat ribbon per rear wheel, written into a ring buffer.
//   • Smoke: a recycled THREE.Points pool with a procedural soft sprite,
//     using a tiny custom shader so each particle can grow + fade.
// ============================================================================

import * as THREE from 'three';
import { SKID, SMOKE } from './config.js';

// ---- procedural soft circular sprite (no asset file) ----------------------
function softSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
class SkidTrail {
  constructor(scene) {
    this.max = SKID.maxSegments;
    this.positions = new Float32Array(this.max * 6 * 3); // 2 tris (6 verts) / segment
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setDrawRange(0, 0);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); // never cull
    this.mat = new THREE.MeshBasicMaterial({
      color: SKID.color,
      transparent: true,
      opacity: SKID.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.head = 0;
    this.count = 0;
    this.prev = { x: 0, z: 0 }; // last contact center (reused, no per-segment alloc)
    this.hasPrev = false; // pen-up sentinel
  }

  // emit a quad from the previous contact point to the current one
  emit(x, z, halfWidth) {
    if (!this.hasPrev) {
      this.prev.x = x;
      this.prev.z = z;
      this.hasPrev = true;
      return;
    }
    const dx = x - this.prev.x;
    const dz = z - this.prev.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.06) return; // avoid degenerate quads when slow
    // perpendicular in the ground plane
    const px = (-dz / len) * halfWidth;
    const pz = (dx / len) * halfWidth;
    const y = SKID.y;

    const a = [this.prev.x + px, y, this.prev.z + pz];
    const b = [this.prev.x - px, y, this.prev.z - pz];
    const c = [x + px, y, z + pz];
    const d = [x - px, y, z - pz];

    const o = this.head * 18;
    const P = this.positions;
    // tri 1: a, b, c
    P[o + 0] = a[0]; P[o + 1] = a[1]; P[o + 2] = a[2];
    P[o + 3] = b[0]; P[o + 4] = b[1]; P[o + 5] = b[2];
    P[o + 6] = c[0]; P[o + 7] = c[1]; P[o + 8] = c[2];
    // tri 2: b, d, c
    P[o + 9] = b[0]; P[o + 10] = b[1]; P[o + 11] = b[2];
    P[o + 12] = d[0]; P[o + 13] = d[1]; P[o + 14] = d[2];
    P[o + 15] = c[0]; P[o + 16] = c[1]; P[o + 17] = c[2];

    this.head = (this.head + 1) % this.max;
    this.count = Math.min(this.count + 1, this.max);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.setDrawRange(0, this.count * 6);
    this.prev.x = x;
    this.prev.z = z;
  }

  break() {
    this.hasPrev = false; // lift the pen so we don't draw a jump
  }

  // floating-origin rebase: shift every laid quad + the pen by (dx,dz)
  shift(dx, dz) {
    const P = this.positions;
    for (let i = 0; i < P.length; i += 3) { P[i] += dx; P[i + 2] += dz; }
    this.prev.x += dx; this.prev.z += dz;
    this.geo.attributes.position.needsUpdate = true;
  }

  clear() {
    this.head = 0;
    this.count = 0;
    this.hasPrev = false;
    this.geo.setDrawRange(0, 0);
  }
}

// ---------------------------------------------------------------------------
class Smoke {
  constructor(scene) {
    this.max = SMOKE.max;
    this.pos = new Float32Array(this.max * 3);
    this.size = new Float32Array(this.max);
    this.alpha = new Float32Array(this.max);
    this.vel = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    this.maxLife = new Float32Array(this.max);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        map: { value: softSprite() },
        color: { value: new THREE.Color(SMOKE.color) },
      },
      vertexShader: `
        attribute float size;
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (320.0 / max(-mv.z, 0.1));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        uniform vec3 color;
        varying float vAlpha;
        void main() {
          float a = texture2D(map, gl_PointCoord).a * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(color, a);
        }
      `,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);
    this.head = 0;
    this.spawnAcc = 0;
  }

  spawn(x, y, z, intensity) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.pos[i * 3] = x + (Math.random() - 0.5) * 0.3;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.3;
    this.vel[i * 3] = (Math.random() - 0.5) * 1.2;
    this.vel[i * 3 + 1] = SMOKE.rise * (0.6 + Math.random() * 0.6);
    this.vel[i * 3 + 2] = (Math.random() - 0.5) * 1.2;
    this.maxLife[i] = SMOKE.life * (0.7 + Math.random() * 0.6);
    this.life[i] = this.maxLife[i];
    this.size[i] = SMOKE.startSize * (0.8 + intensity * 0.8);
    this.alpha[i] = 0.0;
  }

  emit(x, y, z, intensity, dt) {
    this.spawnAcc += SMOKE.spawnRate * intensity * dt;
    while (this.spawnAcc >= 1) {
      this.spawn(x, y, z, intensity);
      this.spawnAcc -= 1;
    }
  }

  update(dt) {
    let any = false;
    let dirty = false; // gate GPU uploads on actual buffer writes, not on liveness
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) {
          this.alpha[i] = 0;
          dirty = true;
        }
        continue;
      }
      any = true;
      dirty = true;
      this.life[i] -= dt;
      const t = Math.max(this.life[i] / this.maxLife[i], 0);
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3] *= 1 - dt; // air drag
      this.vel[i * 3 + 2] *= 1 - dt;
      this.size[i] += SMOKE.grow * dt;
      // fade in fast, out slow
      this.alpha[i] = (t > 0.85 ? (1 - t) / 0.15 : t) * 0.6;
    }
    if (dirty) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.size.needsUpdate = true;
      this.geo.attributes.alpha.needsUpdate = true;
    }
    return any;
  }

  clear() {
    for (let i = 0; i < this.max; i++) {
      this.life[i] = 0;
      this.alpha[i] = 0;
    }
  }
}

// ---------------------------------------------------------------------------
export function createEffects(scene) {
  const skids = [new SkidTrail(scene), new SkidTrail(scene)]; // one per rear wheel
  const smoke = new Smoke(scene);

  const _v = new THREE.Vector3();

  // render: interpolated car state {x,z,heading}, rearOffsets (local), telemetry
  function update(render, rearOffsets, state, dt) {
    const sinH = Math.sin(render.heading);
    const cosH = Math.cos(render.heading);
    const laying = state.drifting && state.speed > 4;
    const halfW = 0.2;

    for (let w = 0; w < 2; w++) {
      const off = rearOffsets[w];
      // local -> world for the rear wheel contact point (Y-rotation by heading)
      const wx = render.x + off.x * cosH + off.z * sinH;
      const wz = render.z - off.x * sinH + off.z * cosH;
      if (laying) {
        skids[w].emit(wx, wz, halfW * (0.7 + state.intensity * 0.6));
        smoke.emit(wx, 0.3, wz, state.intensity, dt * 0.5);
      } else {
        skids[w].break();
      }
    }
    smoke.update(dt);
  }

  function reset() {
    for (const s of skids) s.clear();
    smoke.clear();
  }

  // floating-origin rebase: shift skid ribbons + smoke particles by (dx,dz)
  function shift(dx, dz) {
    for (const s of skids) s.shift(dx, dz);
    const P = smoke.pos;
    for (let i = 0; i < P.length; i += 3) { P[i] += dx; P[i + 2] += dz; }
    smoke.geo.attributes.position.needsUpdate = true;
  }

  return { update, reset, shift, skids, smoke };
}
