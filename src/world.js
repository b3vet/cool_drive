// ============================================================================
// world.js — OPEN drift world. A drivable road network (a big winding circuit,
// a crossover, and a skidpad) laid on a huge ground you can roam freely. Roads
// are the nice surface to drift along; you can drift on or off them. A soft
// circular boundary gently turns you back at the edge. Scenery (forests, rocks,
// landmark hills, a little town) gives the place landmarks to navigate by.
// ============================================================================

import * as THREE from 'three';
import { WORLD } from './config.js';

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: opts.flat ?? true,
    roughness: opts.roughness ?? 0.85,
    metalness: opts.metalness ?? 0,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
  });
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Evenly-spaced samples along a CatmullRom curve through XZ points.
function sampleCurve(pointsXZ, closed) {
  const v3 = pointsXZ.map((p) => new THREE.Vector3(p[0], 0, p[1]));
  const curve = new THREE.CatmullRomCurve3(v3, closed, 'catmullrom', 0.5);
  let n = Math.max(pointsXZ.length * 16, 80);
  let samples = curve.getSpacedPoints(n); // n+1 points
  if (closed) samples = samples.slice(0, -1); // drop duplicate closing point
  return { curve, samples };
}

function tangentAt(samples, i, closed) {
  const count = samples.length;
  const t = new THREE.Vector3();
  if (!closed && i === 0) return t.subVectors(samples[1], samples[0]).normalize();
  if (!closed && i === count - 1) return t.subVectors(samples[count - 1], samples[count - 2]).normalize();
  const nxt = samples[(i + 1) % count];
  const prv = samples[(i - 1 + count) % count];
  return t.subVectors(nxt, prv).normalize();
}

// A flat ribbon following `samples`, offset laterally and given a width.
function buildRibbon(samples, closed, offset, width, y, material) {
  const count = samples.length;
  const up = new THREE.Vector3(0, 1, 0);
  const positions = [];
  const normals = [];
  const half = width / 2;
  for (let i = 0; i < count; i++) {
    const c = samples[i];
    const tan = tangentAt(samples, i, closed);
    const perp = new THREE.Vector3().crossVectors(up, tan).normalize();
    const cx = c.x + perp.x * offset;
    const cz = c.z + perp.z * offset;
    positions.push(cx + perp.x * half, y, cz + perp.z * half);
    positions.push(cx - perp.x * half, y, cz - perp.z * half);
    normals.push(0, 1, 0, 0, 1, 0);
  }
  const indices = [];
  const segs = closed ? count : count - 1;
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = ((i + 1) % count) * 2;
    const d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  const m = new THREE.Mesh(geo, material);
  m.receiveShadow = true;
  return m;
}

export function buildWorld(scene, preset) {
  const group = new THREE.Group();
  group.name = 'world';
  scene.add(group);

  const rng = mulberry32(20260627);
  const cones = [];
  const solids = []; // hard obstacles {x, z, r} the car physically collides with
  const W = WORLD.roadWidth;

  // shared materials
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x232730, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const edgeMat = mat(preset.neon, { emissive: preset.neon, emissiveIntensity: 0.5, roughness: 0.5 });
  const dashMat = new THREE.MeshStandardMaterial({ color: 0xd9dde6, roughness: 0.7, transparent: true, opacity: 0.8 });
  const postMat = mat(preset.neon, { emissive: preset.neon, emissiveIntensity: 0.9, roughness: 0.4 });

  // ---- road layout ---------------------------------------------------------
  const ROADS = [
    {
      closed: true,
      pts: [
        [-380, -110], [-250, -300], [-30, -360], [210, -325], [365, -190],
        [415, 30], [300, 225], [110, 300], [-130, 345], [-330, 250], [-430, 60],
      ],
    },
    {
      closed: false,
      pts: [[-320, 170], [-150, 60], [40, -30], [240, -150], [330, -250]],
    },
    {
      closed: true, // skidpad loop (lower-right) for donuts / chained drifts
      pts: [[70, 70], [200, 40], [235, -90], [120, -160], [-25, -120], [-50, 20]],
    },
  ];

  const dummy = new THREE.Object3D();
  const dashGeo = new THREE.BoxGeometry(0.5, 0.02, 4.5);
  const allDashes = [];
  const postPositions = [];
  const roadCurves = [];

  for (const r of ROADS) {
    const { curve, samples } = sampleCurve(r.pts, r.closed);
    roadCurves.push(curve);
    // surface
    group.add(buildRibbon(samples, r.closed, 0, W, 0.02, asphalt));
    // glowing edge lines
    group.add(buildRibbon(samples, r.closed, W / 2 - 0.35, 0.55, 0.035, edgeMat));
    group.add(buildRibbon(samples, r.closed, -W / 2 + 0.35, 0.55, 0.035, edgeMat));
    // collect dashes + post positions along the road
    const count = samples.length;
    for (let i = 0; i < count; i += 3) {
      const c = samples[i];
      allDashes.push({ pos: c.clone(), tan: tangentAt(samples, i, r.closed).clone() });
    }
    for (let i = 0; i < count; i += 7) {
      const c = samples[i];
      const tan = tangentAt(samples, i, r.closed);
      const perp = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), tan).normalize();
      postPositions.push([c.x + perp.x * (W / 2 + 2.2), c.z + perp.z * (W / 2 + 2.2)]);
      postPositions.push([c.x - perp.x * (W / 2 + 2.2), c.z - perp.z * (W / 2 + 2.2)]);
    }
  }

  // center dashes (instanced)
  const dashes = new THREE.InstancedMesh(dashGeo, dashMat, allDashes.length);
  allDashes.forEach((d, i) => {
    dummy.position.set(d.pos.x, 0.03, d.pos.z);
    dummy.rotation.set(0, Math.atan2(d.tan.x, d.tan.z), 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    dashes.setMatrixAt(i, dummy.matrix);
  });
  dashes.instanceMatrix.needsUpdate = true;
  dashes.receiveShadow = true;
  group.add(dashes);

  // roadside posts (instanced) — COLLIDABLE bollards that knock over when hit
  const postGeo = new THREE.CylinderGeometry(0.18, 0.26, 2.4, 6);
  const posts = new THREE.InstancedMesh(postGeo, postMat, postPositions.length);
  posts.castShadow = true;
  const postList = postPositions.map(([x, z], i) => ({ x, z, i, knock: 0, fallen: false, dir: 0 }));
  postList.forEach((p) => {
    dummy.position.set(p.x, 1.2, p.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    posts.setMatrixAt(p.i, dummy.matrix);
  });
  posts.instanceMatrix.needsUpdate = true;
  group.add(posts);

  // ---- scenery: forests, rocks, landmark hills, a little town --------------
  const trunkGeo = new THREE.CylinderGeometry(0.3, 0.45, 2.2, 6);
  const topGeo = new THREE.ConeGeometry(2.0, 4.8, 7);
  const trunkMat = mat(0x5b4632, { roughness: 1 });
  const leafMat = mat(0x3f7d4d, { roughness: 1 });
  const rockGeo = new THREE.DodecahedronGeometry(1.5, 0);
  const rockMat = mat(0x6c7078, { roughness: 1 });

  const TREES = 360;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, TREES);
  const tops = new THREE.InstancedMesh(topGeo, leafMat, TREES);
  trunks.castShadow = tops.castShadow = true;
  // precompute road sample points for distance rejection
  const roadPts = [];
  for (const cv of roadCurves) for (const p of cv.getSpacedPoints(70)) roadPts.push(p);
  const nearRoad = (x, z, dist) => {
    const d2 = dist * dist;
    for (const p of roadPts) {
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz < d2) return true;
    }
    return false;
  };

  let ti = 0;
  let guard = 0;
  // forest clusters
  while (ti < TREES && guard++ < TREES * 12) {
    // cluster centers
    const ca = rng() * Math.PI * 2;
    const cr = 120 + rng() * 460;
    const ccx = Math.cos(ca) * cr;
    const ccz = Math.sin(ca) * cr;
    const clusterN = 4 + Math.floor(rng() * 8);
    for (let k = 0; k < clusterN && ti < TREES; k++) {
      const x = ccx + (rng() - 0.5) * 40;
      const z = ccz + (rng() - 0.5) * 40;
      if (Math.hypot(x, z) > WORLD.boundary + 120) continue;
      if (nearRoad(x, z, W / 2 + 5)) continue;
      const sc = 0.7 + rng() * 1.1;
      dummy.position.set(x, 1.1 * sc, z);
      dummy.rotation.set(0, rng() * Math.PI, 0);
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      trunks.setMatrixAt(ti, dummy.matrix);
      dummy.position.set(x, (2.2 + 1.9) * sc, z);
      dummy.updateMatrix();
      tops.setMatrixAt(ti, dummy.matrix);
      solids.push({ x, z, r: 1.0 + sc * 0.3 });
      ti++;
    }
  }
  for (; ti < TREES; ti++) {
    dummy.position.set(0, -50, 0); // park unused instances out of sight
    dummy.updateMatrix();
    trunks.setMatrixAt(ti, dummy.matrix);
    tops.setMatrixAt(ti, dummy.matrix);
  }
  trunks.instanceMatrix.needsUpdate = true;
  tops.instanceMatrix.needsUpdate = true;
  group.add(trunks, tops);

  // rocks
  const ROCKS = 90;
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, ROCKS);
  rocks.castShadow = true;
  let ri = 0;
  guard = 0;
  while (ri < ROCKS && guard++ < ROCKS * 12) {
    const a = rng() * Math.PI * 2;
    const rr = 90 + rng() * 520;
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (nearRoad(x, z, W / 2 + 4)) continue;
    const rsc = 0.5 + rng() * 1.6;
    dummy.position.set(x, 0.4 + rng() * 0.6, z);
    dummy.rotation.set(rng(), rng() * Math.PI, rng());
    dummy.scale.setScalar(rsc);
    dummy.updateMatrix();
    rocks.setMatrixAt(ri++, dummy.matrix);
    solids.push({ x, z, r: rsc * 1.4 });
  }
  for (; ri < ROCKS; ri++) {
    dummy.position.set(0, -50, 0);
    dummy.updateMatrix();
    rocks.setMatrixAt(ri, dummy.matrix);
  }
  rocks.instanceMatrix.needsUpdate = true;
  group.add(rocks);

  // landmark hills — snow baked into the mesh as vertex colours (no z-fighting cap)
  const hillMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
  const rockCol = new THREE.Color(0x55615a);
  const snowCol = new THREE.Color(0xeef2f8);
  const tmpCol = new THREE.Color();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    const rr = 540 + rng() * 240;
    const h = 70 + rng() * 90;
    const rad = 100 + rng() * 120;
    const hx = Math.cos(a) * rr;
    const hz = Math.sin(a) * rr;
    const geo = new THREE.ConeGeometry(rad, h, 9);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const snowStart = 0.6 + rng() * 0.12; // height fraction where snow begins
    for (let v = 0; v < pos.count; v++) {
      const t = (pos.getY(v) + h / 2) / h; // 0 base .. 1 apex
      const snow = THREE.MathUtils.smoothstep(t, snowStart, snowStart + 0.18);
      tmpCol.copy(rockCol).lerp(snowCol, snow);
      colors[v * 3] = tmpCol.r; colors[v * 3 + 1] = tmpCol.g; colors[v * 3 + 2] = tmpCol.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const hill = new THREE.Mesh(geo, hillMat);
    hill.position.set(hx, h / 2 - 6, hz);
    hill.rotation.y = rng() * Math.PI;
    group.add(hill);
    solids.push({ x: hx, z: hz, r: rad * 0.82 });
  }

  // a calm lake (landmark / atmosphere)
  const lakeMat = new THREE.MeshStandardMaterial({ color: preset.neon, roughness: 0.15, metalness: 0.6, transparent: true, opacity: 0.55 });
  const lake = new THREE.Mesh(new THREE.CircleGeometry(70, 40), lakeMat);
  lake.rotation.x = -Math.PI / 2;
  lake.position.set(300, 0.04, 300);
  group.add(lake);

  // bushes for ground detail (instanced)
  const bushGeo = new THREE.IcosahedronGeometry(1.1, 0);
  const bushMat = mat(0x4a7d4a, { roughness: 1 });
  const BUSHES = 160;
  const bushes = new THREE.InstancedMesh(bushGeo, bushMat, BUSHES);
  bushes.castShadow = true;
  let bi = 0;
  guard = 0;
  while (bi < BUSHES && guard++ < BUSHES * 12) {
    const a = rng() * Math.PI * 2;
    const rr = 70 + rng() * 560;
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (nearRoad(x, z, W / 2 + 3)) continue;
    const sc = 0.5 + rng() * 0.9;
    dummy.position.set(x, sc * 0.7, z);
    dummy.rotation.set(0, rng() * Math.PI, 0);
    dummy.scale.set(sc * 1.4, sc, sc * 1.4);
    dummy.updateMatrix();
    bushes.setMatrixAt(bi++, dummy.matrix);
  }
  for (; bi < BUSHES; bi++) { dummy.position.set(0, -50, 0); dummy.updateMatrix(); bushes.setMatrixAt(bi, dummy.matrix); }
  bushes.instanceMatrix.needsUpdate = true;
  group.add(bushes);

  // a little low-poly town cluster (landmark)
  const townX = -210;
  const townZ = 150;
  const winMat = mat(0xffe7a8, { emissive: 0xffe7a8, emissiveIntensity: 0.5, roughness: 0.6 });
  for (let i = 0; i < 14; i++) {
    const bw = 6 + rng() * 7;
    const bd = 6 + rng() * 7;
    const bh = 8 + rng() * 26;
    const shade = 0x6b7180 + Math.floor(rng() * 0x10) * 0x010101;
    const b = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat(shade, { roughness: 0.8, flat: false }));
    const bx = townX + (rng() - 0.5) * 90;
    const bz = townZ + (rng() - 0.5) * 90;
    b.position.set(bx, bh / 2, bz);
    b.castShadow = true;
    b.receiveShadow = true;
    group.add(b);
    solids.push({ x: bx, z: bz, r: Math.max(bw, bd) * 0.62 });
    // a glowing window band
    const band = new THREE.Mesh(new THREE.BoxGeometry(bw * 1.01, bh * 0.12, bd * 1.01), winMat);
    band.position.set(bx, bh * 0.7, bz);
    group.add(band);
  }

  // ---- cone slalom on a road straight (soft obstacles) ---------------------
  const coneGeo = new THREE.ConeGeometry(0.4, 1.0, 8);
  const coneMat = mat(0xff7a1a, { emissive: 0x331400, roughness: 0.6 });
  // place a slalom near the skidpad loop centre
  for (let i = 0; i < 14; i++) {
    const x = 90 + i * 9 - 60;
    const z = -40 + (i % 2 === 0 ? -6 : 6);
    const c = new THREE.Mesh(coneGeo, coneMat);
    c.position.set(x, 0.5, z);
    c.castShadow = true;
    group.add(c);
    cones.push({ x, z, mesh: c, baseY: 0.5, knock: 0 });
  }

  // ---- soft boundary ring marker (faint) -----------------------------------
  const ringMat = new THREE.MeshBasicMaterial({ color: preset.neon, transparent: true, opacity: 0.12, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(WORLD.boundary - 1, WORLD.boundary + 1, 96), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  group.add(ring);

  // ---- ambient dust motes that drift around the camera ---------------------
  const DUST = 150;
  const DUST_RANGE = 90;
  const dustPos = new Float32Array(DUST * 3);
  const dustVel = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) {
    dustPos[i * 3] = (rng() - 0.5) * DUST_RANGE * 2;
    dustPos[i * 3 + 1] = rng() * 28 + 1;
    dustPos[i * 3 + 2] = (rng() - 0.5) * DUST_RANGE * 2;
    dustVel[i * 3] = (rng() - 0.5) * 1.2;
    dustVel[i * 3 + 1] = rng() * 0.4 + 0.1;
    dustVel[i * 3 + 2] = (rng() - 0.5) * 1.2;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  dustGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const dustMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.32, transparent: true, opacity: 0.3, depthWrite: false, sizeAttenuation: true });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  group.add(dust);

  function updateAtmosphere(cam, dt) {
    for (let i = 0; i < DUST; i++) {
      let x = dustPos[i * 3] + dustVel[i * 3] * dt;
      let y = dustPos[i * 3 + 1] + dustVel[i * 3 + 1] * dt;
      let z = dustPos[i * 3 + 2] + dustVel[i * 3 + 2] * dt;
      // wrap around the camera so motes always surround the player
      if (x - cam.x > DUST_RANGE) x -= DUST_RANGE * 2;
      else if (x - cam.x < -DUST_RANGE) x += DUST_RANGE * 2;
      if (z - cam.z > DUST_RANGE) z -= DUST_RANGE * 2;
      else if (z - cam.z < -DUST_RANGE) z += DUST_RANGE * 2;
      if (y > 30) y = 1;
      dustPos[i * 3] = x; dustPos[i * 3 + 1] = y; dustPos[i * 3 + 2] = z;
    }
    dustGeo.attributes.position.needsUpdate = true;
  }

  return {
    group, cones, solids, posts, postList, postMat, edgeMat, ringMat, dustMat,
    boundary: WORLD.boundary, roadCurves, townCenter: { x: townX, z: townZ },
    updateAtmosphere,
  };
}

// Soft circular boundary + cone push-out. Returns true only on a hard slam.
export function resolveCollisions(state, world) {
  const B = world.boundary;
  let hardHit = false;

  const r = Math.hypot(state.x, state.z);
  if (r > B) {
    const nx = state.x / r;
    const nz = state.z / r;
    state.x = nx * B;
    state.z = nz * B;
    const vOut = state.vx * nx + state.vz * nz; // outward velocity
    if (vOut > 0) {
      // remove outward component + a little bounce so you slide along the edge
      state.vx -= vOut * nx * 1.3;
      state.vz -= vOut * nz * 1.3;
      if (vOut > 16) hardHit = true; // only a fast slam breaks the combo
    }
  }

  // solid objects (trees, rocks, buildings, hills): push the car out, kill the
  // velocity component going INTO the object, bounce a little, scrub speed.
  const carR = WORLD.carRadius;
  const e = WORLD.hitRestitution;
  for (const o of world.solids) {
    const dx = state.x - o.x;
    const dz = state.z - o.z;
    const rr = o.r + carR;
    const d2 = dx * dx + dz * dz;
    if (d2 < rr * rr) {
      const d = Math.max(Math.sqrt(d2), 0.001);
      const nx = dx / d;
      const nz = dz / d;
      state.x = o.x + nx * rr; // push out to the surface
      state.z = o.z + nz * rr;
      const vIn = state.vx * nx + state.vz * nz; // velocity along outward normal
      if (vIn < 0) {
        state.vx -= (1 + e) * vIn * nx; // reflect the inward component
        state.vz -= (1 + e) * vIn * nz;
        if (-vIn > 12) hardHit = true; // a fast hit breaks the combo
      }
      state.vx *= 0.82; // scrub speed on contact
      state.vz *= 0.82;
    }
  }

  // cones: soft push-out + cosmetic knock
  let coneHits = 0;
  for (const c of world.cones) {
    const dx = state.x - c.x;
    const dz = state.z - c.z;
    const d2 = dx * dx + dz * dz;
    const rad = 1.5;
    if (d2 < rad * rad) {
      if (c.knock < 0.05) coneHits++; // count a fresh hit
      const d = Math.max(Math.sqrt(d2), 0.001);
      const push = (rad - d) / rad;
      state.x += (dx / d) * push * 0.35;
      state.z += (dz / d) * push * 0.35;
      c.knock = Math.min(1, c.knock + 0.4);
    }
  }

  // roadside posts (blue sticks): collidable bollards — bend over, slow you a touch
  let postHits = 0;
  const postRR = 0.5 + carR;
  for (const p of world.postList) {
    if (p.fallen) continue;
    const dx = state.x - p.x;
    const dz = state.z - p.z;
    if (dx * dx + dz * dz < postRR * postRR) {
      if (!p.knocking) {
        p.knocking = true;
        p.dir = Math.atan2(state.vx, state.vz); // fall in the car's travel direction
        postHits++;
      }
      state.vx *= 0.95; // gentle slow, not a wall
      state.vz *= 0.95;
    }
  }

  return { crash: hardHit, cones: coneHits, posts: postHits };
}

// Animate knocked-over posts (called each render frame).
export function updatePosts(world, dt) {
  let changed = false;
  const m = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const pivot = new THREE.Matrix4().makeTranslation(0, 1.2, 0);
  const axis = new THREE.Vector3();
  for (const p of world.postList) {
    if (!p.knocking || p._settled) continue;
    p.knock = Math.min(1, p.knock + dt * 3.2);
    const tilt = p.knock * (Math.PI / 2) * 0.96;
    axis.set(Math.cos(p.dir), 0, -Math.sin(p.dir)).normalize();
    rot.makeRotationAxis(axis, tilt);
    m.makeTranslation(p.x, 0, p.z).multiply(rot).multiply(pivot);
    world.posts.setMatrixAt(p.i, m);
    changed = true;
    if (p.knock >= 1) { p.fallen = true; p._settled = true; }
  }
  if (changed) world.posts.instanceMatrix.needsUpdate = true;
}

export function updateCones(world, dt) {
  for (const c of world.cones) {
    if (c.knock > 0) {
      c.knock = Math.max(0, c.knock - dt * 1.5);
      c.mesh.rotation.z = Math.sin(c.knock * 18) * c.knock * 0.5;
      c.mesh.position.y = c.baseY - c.knock * 0.15;
    }
  }
}

export function applyWorldPreset(world, preset) {
  world.postMat.color.setHex(preset.neon);
  world.postMat.emissive.setHex(preset.neon);
  if (world.edgeMat) {
    world.edgeMat.color.setHex(preset.neon);
    world.edgeMat.emissive.setHex(preset.neon);
  }
  if (world.ringMat) world.ringMat.color.setHex(preset.neon);
}
