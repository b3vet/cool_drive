// ============================================================================
// world.js — OPEN drift world. A drivable road network (a big winding circuit,
// a crossover, and a skidpad) laid on a huge ground you can roam freely. Roads
// are the nice surface to drift along; you can drift on or off them. A soft
// circular boundary gently turns you back at the edge. Scenery (forests, rocks,
// landmark hills, a little town) gives the place landmarks to navigate by.
// ============================================================================

import * as THREE from 'three';
import { WORLD, CHUNK, SCORE } from './config.js';
import { createStreamer } from './chunks.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// the authored home region is clamped to (roughly) its reservation rectangle;
// everything beyond is generated on the fly by the streamer.
const RES = { x0: -1000, x1: 490, z0: -1000, z1: 490 };

// Big flat surfaces + most scenery dominate the screen; under MeshStandardMaterial every lit
// fragment pays the full 7-light GGX BRDF (5 PointLights + sun + hemi are all compiled in). On
// the mobile-default Medium/Low tiers we build the same materials as the cheap MeshLambertMaterial
// (diffuse per-pixel; still fog/shadow/emissive/flatShading/vertexColors/instanceColor capable).
// The class is fixed at BOOT from the persisted tier — like the shadow filter — so there's no
// runtime recompile; changing High<->Medium in settings takes effect on the next launch. High
// keeps full PBR. See OPTIMIZATION.md.
let _cheapShading = true;
try { _cheapShading = (localStorage.getItem('cooldrive.quality') || 'medium') !== 'high'; } catch (e) {}

function mat(color, opts = {}) {
  if (_cheapShading) {
    return new THREE.MeshLambertMaterial({
      color,
      flatShading: opts.flat ?? true,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 1,
    });
  }
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: opts.flat ?? true,
    roughness: opts.roughness ?? 0.85,
    metalness: opts.metalness ?? 0,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
  });
}

// like mat() but for the directly-specified big surfaces (asphalt / track / walls): keeps
// polygonOffset / vertexColors / side / transparency, drops the PBR-only params on the Lambert
// path (Lambert ignores roughness/metalness — wet-road sheen just won't apply on Med/Low).
function bigStd(params) {
  if (_cheapShading) {
    const p = {};
    for (const k of ['color', 'emissive', 'emissiveIntensity', 'flatShading', 'vertexColors', 'side', 'transparent', 'opacity', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits']) {
      if (params[k] !== undefined) p[k] = params[k];
    }
    return new THREE.MeshLambertMaterial(p);
  }
  return new THREE.MeshStandardMaterial(params);
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

// Builds the fixed AUTHORED home region (the original map, minus the world boundary
// and with scenery clamped to the reservation). Returns its group, shared materials/
// geometries for the streamer, and its colliders bucketed by the caller.
function buildHomeRegion(scene, preset) {
  const group = new THREE.Group();
  group.name = 'home';
  scene.add(group);

  const rng = mulberry32(20260627);
  const cones = [];
  const solids = []; // round obstacles {x, z, r} the car collides with (trees/rocks/hills)
  const boxes = []; // oriented building boxes {x, z, hw, hd, cos, sin} — exact footprint collision
  const walls = []; // wall segments {x1,z1,x2,z2} for the drift track (smooth slide collision)
  let trackWallTopMat = null; // neon cap material (recoloured with the time-of-day preset)
  const W = WORLD.roadWidth;

  // shared materials
  const asphalt = bigStd({ color: 0x232730, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const edgeMat = mat(preset.neon, { emissive: preset.neon, emissiveIntensity: 0.5, roughness: 0.5 });
  // render the neon edge lines ON TOP of the road surface at ALL distances: the surface
  // has polygonOffset -1, so without a stronger offset the edges lose the depth test at
  // grazing angles ahead of the car and appear to only draw right behind it.
  edgeMat.polygonOffset = true; edgeMat.polygonOffsetFactor = -4; edgeMat.polygonOffsetUnits = -4;
  const dashMat = new THREE.MeshStandardMaterial({ color: 0xd9dde6, roughness: 0.7, transparent: true, opacity: 0.8 });
  const postMat = mat(preset.neon, { emissive: preset.neon, emissiveIntensity: 0.9, roughness: 0.4 });

  // ---- drift circuit centre-line (built here so the connector can aim at it)-
  // A real-ish drift circuit in the SW corner: long straight -> fast sweeper ->
  // hairpin -> esses -> back. Boxed by walls with a pit-style ENTRANCE gap.
  const trackCenter = { x: -520, z: -520 };
  const TW = 26; // track width — wide, committed drift lines
  const trackLocal = [
    [30, 230], [-160, 225], [-255, 150], [-265, 20],
    [-185, -60], [-220, -180], [-100, -235], [40, -190],
    [55, -70], [165, -100], [250, -10], [225, 135],
  ];
  const trackPts = trackLocal.map(([dx, dz]) => [trackCenter.x + dx, trackCenter.z + dz]);
  const { curve: trackCurve, samples: trackSamples } = sampleCurve(trackPts, true);
  let trackRad = 0;
  for (const s of trackSamples) trackRad = Math.max(trackRad, Math.hypot(s.x - trackCenter.x, s.z - trackCenter.z));
  const wallOff = TW / 2 + 1.2;
  // entrance = the outer-wall sample nearest the side that faces the map centre
  const entTarget = { x: trackCenter.x + 150, z: trackCenter.z + 190 };
  let entranceIdx = 0, entBest = Infinity;
  for (let i = 0; i < trackSamples.length; i++) {
    const s = trackSamples[i];
    const d = (s.x - entTarget.x) ** 2 + (s.z - entTarget.z) ** 2;
    if (d < entBest) { entBest = d; entranceIdx = i; }
  }
  const entPt = trackSamples[entranceIdx];
  const outDir = { x: entPt.x - trackCenter.x, z: entPt.z - trackCenter.z };
  const outLen = Math.hypot(outDir.x, outDir.z) || 1;
  outDir.x /= outLen; outDir.z /= outLen;
  const E_out = { x: entPt.x + outDir.x * (wallOff + 58), z: entPt.z + outDir.z * (wallOff + 58) };

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
    {
      closed: false, // connector: main circuit -> the drift-track entrance gap
      // routed to stay clear of the track walls; the access lane bridges E_out->gap
      pts: [[-380, -110], [-418, -225], [E_out.x, E_out.z]],
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

  // ---- dedicated DRIFT CIRCUIT: proper walled track with kerbs + a pit entry -
  // Centre-line + entrance were computed above. Here we lay the asphalt, paint
  // the corner kerbs, box it with walls (outer wall OPEN at the entrance gap),
  // and pave an access lane from the connector road through the gap.
  roadCurves.push(trackCurve); // keep scenery off the track surface
  const nT = trackSamples.length;

  // fresh-asphalt surface (a touch lighter than the roads) + glowing edge lines
  const trackMat = bigStd({ color: 0x2b3038, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  group.add(buildRibbon(trackSamples, true, 0, TW + 3, 0.03, trackMat)); // asphalt reaches under the walls
  group.add(buildRibbon(trackSamples, true, TW / 2 - 0.35, 0.5, 0.05, edgeMat));
  group.add(buildRibbon(trackSamples, true, -TW / 2 + 0.35, 0.5, 0.05, edgeMat));

  // access lane: connector road end (E_out) -> through the gap -> onto the track
  group.add(buildRibbon(
    [new THREE.Vector3(entPt.x - outDir.x * 6, 0, entPt.z - outDir.z * 6),
     new THREE.Vector3(E_out.x, 0, E_out.z)],
    false, 0, TW * 0.85, 0.028, trackMat));

  // ---- kerbs: red/white striped blocks on the corner edges -----------------
  // One tile per track EDGE-SEGMENT, made shorter than its segment so tiles never
  // touch/overlap (no z-fighting). The length auto-shrinks on tight inner corners.
  const up3 = new THREE.Vector3(0, 1, 0);
  const perpAt = (i, list = trackSamples, closed = true) => new THREE.Vector3().crossVectors(up3, tangentAt(list, i, closed)).normalize();
  const heads = [];
  for (let i = 0; i < nT; i++) { const t = tangentAt(trackSamples, i, true); heads.push(Math.atan2(t.x, t.z)); }
  const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  const kerbPlace = [];
  const kRed = new THREE.Color(0xd23b32), kWhite = new THREE.Color(0xeef0f2);
  for (let i = 0; i < nT; i++) {
    const iN = (i + 1) % nT;
    const turn = Math.abs(angDiff(heads[iN], heads[(i - 1 + nT) % nT]));
    if (turn < 0.05) continue; // straights get no kerb
    const c = trackSamples[i], cN = trackSamples[iN];
    const pA = perpAt(i), pB = perpAt(iN);
    const col = (i % 2 === 0) ? kRed : kWhite; // alternate along the track
    for (const sgn of [1, -1]) {
      const off = sgn * (TW / 2 - 1.3);
      const ax = c.x + pA.x * off, az = c.z + pA.z * off;   // edge point at sample i
      const bx = cN.x + pB.x * off, bz = cN.z + pB.z * off; // edge point at sample i+1
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.2) continue;
      kerbPlace.push({ x: (ax + bx) / 2, z: (az + bz) / 2, ang: Math.atan2(bx - ax, bz - az), len: len * 0.82, col });
    }
  }
  if (kerbPlace.length) {
    const kerbGeo = new THREE.BoxGeometry(1.8, 0.14, 1); // depth scaled per-instance to the segment
    const kerbs = new THREE.InstancedMesh(kerbGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), kerbPlace.length);
    kerbs.receiveShadow = true;
    kerbPlace.forEach((k, i) => {
      dummy.position.set(k.x, 0.07, k.z);
      dummy.rotation.set(0, k.ang, 0);
      dummy.scale.set(1, 1, k.len);
      dummy.updateMatrix();
      kerbs.setMatrixAt(i, dummy.matrix);
      kerbs.setColorAt(i, k.col);
    });
    kerbs.instanceMatrix.needsUpdate = true;
    if (kerbs.instanceColor) kerbs.instanceColor.needsUpdate = true;
    group.add(kerbs);
  }

  // ---- walls: inner ring closed; outer ring OPEN at the entrance gap --------
  // Painted as alternating red/white motorsport barrier panels (vertex colours)
  // so the boundary reads as a race barrier, not a flat black wall.
  const wallMat = bigStd({ vertexColors: true, roughness: 0.82, metalness: 0.05, flatShading: true, side: THREE.DoubleSide });
  const wallCols = [new THREE.Color(0xe4e7ee), new THREE.Color(0xcf3b33)]; // white, red
  const PANEL = 3; // samples per colour panel
  trackWallTopMat = mat(preset.neon, { emissive: preset.neon, emissiveIntensity: 0.65, roughness: 0.4 });
  const wallH = WORLD.wallHeight;
  function buildTrackWall(sampleList, closed, offset) {
    const count = sampleList.length;
    const up = new THREE.Vector3(0, 1, 0);
    const positions = [], normals = [], colors = [], linePts = [];
    for (let i = 0; i < count; i++) {
      const c = sampleList[i];
      const tan = tangentAt(sampleList, i, closed);
      const perp = new THREE.Vector3().crossVectors(up, tan).normalize();
      const bx = c.x + perp.x * offset, bz = c.z + perp.z * offset;
      linePts.push([bx, bz]);
      positions.push(bx, 0.02, bz, bx, wallH, bz); // bottom, top
      normals.push(perp.x, 0, perp.z, perp.x, 0, perp.z);
      const pc = wallCols[Math.floor(i / PANEL) % 2];
      colors.push(pc.r, pc.g, pc.b, pc.r, pc.g, pc.b);
    }
    const indices = [];
    const segs = closed ? count : count - 1;
    for (let i = 0; i < segs; i++) {
      const a = i * 2, b = a + 1, c = ((i + 1) % count) * 2, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    const m = new THREE.Mesh(geo, wallMat);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    group.add(buildRibbon(sampleList, closed, offset, 0.6, wallH, trackWallTopMat)); // neon cap
    for (let i = 0; i < segs; i++) {
      const [x1, z1] = linePts[i];
      const [x2, z2] = linePts[(i + 1) % count];
      walls.push({ x1, z1, x2, z2 });
    }
  }
  buildTrackWall(trackSamples, true, -wallOff); // inner wall — full closed loop
  // outer wall — open chain that leaves a gap at the entrance
  const gapHalf = 1;
  const openChain = [];
  for (let k = 0; k < nT - (2 * gapHalf + 1); k++) openChain.push(trackSamples[(entranceIdx + gapHalf + 1 + k) % nT]);
  buildTrackWall(openChain, false, wallOff);

  // ---- trackside "DRIFT ARENA" signage on the outer barrier ----------------
  function makeSignTexture(text) {
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 160;
    const g2 = cv.getContext('2d');
    g2.fillStyle = '#0e1526'; g2.fillRect(0, 0, cv.width, cv.height);
    g2.fillStyle = '#5be6c8';
    g2.font = 'bold 104px system-ui, Arial, sans-serif';
    g2.textAlign = 'center'; g2.textBaseline = 'middle';
    g2.fillText(text, cv.width / 2, cv.height / 2 + 8);
    g2.strokeStyle = '#2a3550'; g2.lineWidth = 10; g2.strokeRect(5, 5, cv.width - 10, cv.height - 10);
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    return tex;
  }
  const signMat = new THREE.MeshBasicMaterial({ map: makeSignTexture('DRIFT ARENA'), toneMapped: false });
  const bannerGeo = new THREE.PlaneGeometry(13, 1.9);
  const nBanners = 5;
  for (let b = 0; b < nBanners; b++) {
    const si = Math.floor((b + 0.5) / nBanners * nT);
    let dd = Math.abs(si - entranceIdx); dd = Math.min(dd, nT - dd);
    if (dd < gapHalf + 4) continue; // don't span the entrance gap
    const c = trackSamples[si], perp = perpAt(si);
    const banner = new THREE.Mesh(bannerGeo, signMat);
    banner.position.set(c.x + perp.x * (wallOff - 0.08), wallH * 0.6, c.z + perp.z * (wallOff - 0.08));
    banner.rotation.y = Math.atan2(-perp.x, -perp.z); // face the track (inward)
    group.add(banner);
  }

  // ---- trackside light poles (switch on for Neon Night) --------------------
  const poleMat = mat(0x2a2e36, { roughness: 0.6, metalness: 0.35, flat: false });
  const poleGeo = new THREE.CylinderGeometry(0.16, 0.22, 6.6, 6);
  const headGeo = new THREE.BoxGeometry(1.6, 0.4, 0.8);
  const poolGeo = new THREE.CircleGeometry(15, 24);
  const trackLightHeads = [], trackLightPools = [], lightAnchors = [];
  const nPoles = 10;
  for (let k = 0; k < nPoles; k++) {
    const si = Math.floor((k + 0.25) / nPoles * nT);
    const c = trackSamples[si], perp = perpAt(si); // +perp = outward
    const px = c.x + perp.x * (wallOff + 3.2), pz = c.z + perp.z * (wallOff + 3.2);
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(px, 3.3, pz);
    pole.castShadow = true;
    group.add(pole);
    const hx = px - perp.x * 3.4, hz = pz - perp.z * 3.4; // lamp head leans in over the edge
    const headMat = new THREE.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0xffe3a0, emissiveIntensity: 0, roughness: 0.5 });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.set(hx, 6.5, hz);
    head.rotation.y = Math.atan2(perp.x, perp.z);
    group.add(head);
    trackLightHeads.push(headMat);
    const poolMat = new THREE.MeshBasicMaterial({ color: 0xffe1a6, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const pool = new THREE.Mesh(poolGeo, poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(c.x + perp.x * (TW / 2 - 4), 0.07, c.z + perp.z * (TW / 2 - 4));
    group.add(pool);
    trackLightPools.push(poolMat);
    // Every other pole is a lamp ANCHOR (absolute coords). The 5 real PointLights now
    // live in the streamer's single shared pool, aimed at the nearest of these anchors
    // + any active procedural circuit — so the world-wide PointLight count stays at 5.
    if (k % 2 === 0) lightAnchors.push({ x: hx, y: 6.2, z: hz });
  }
  // Time-of-day dimmer (0..1, or a boolean). Drives only the emissive lamp heads +
  // ground pools; the actual PointLights are the streamer's job (setNightLevel).
  function setTrackLights(level) {
    const lvl = level === true ? 1 : level === false ? 0 : level;
    for (const m of trackLightHeads) m.emissiveIntensity = 3.0 * lvl;
    for (const m of trackLightPools) m.opacity = 0.6 * lvl;
  }

  const driftTrack = {
    curve: trackCurve, samples: trackSamples, center: trackCenter,
    radius: trackRad, width: TW,
    cull: trackRad + TW + 60, // bounding radius (covers the access lane) for wall-collision cull
    onRadius: TW / 2 + 6, // distance to centreline that counts as "on the track"
  };
  // is (x,z) on the drift track surface? (cheap cull, then nearest-sample test)
  function onDriftTrack(x, z) {
    const dx = x - trackCenter.x, dz = z - trackCenter.z;
    if (dx * dx + dz * dz > driftTrack.cull * driftTrack.cull) return false;
    let best = Infinity;
    for (const s of trackSamples) {
      const ex = x - s.x, ez = z - s.z;
      const d = ex * ex + ez * ez;
      if (d < best) best = d;
    }
    return best < driftTrack.onRadius * driftTrack.onRadius;
  }

  // ---- scenery: forests, rocks, landmark hills, a little town --------------
  const trunkGeo = new THREE.CylinderGeometry(0.3, 0.45, 2.2, 6);
  const topGeo = new THREE.ConeGeometry(2.0, 4.8, 7);
  const trunkMat = mat(0x5b4632, { roughness: 1 });
  const leafMat = mat(0x3f7d4d, { roughness: 1 });
  const rockGeo = new THREE.DodecahedronGeometry(1.5, 0);
  const rockMat = mat(0x6c7078, { roughness: 1 });

  // shared resources the streamer reuses for procedural chunks
  const buildingGeo = new THREE.BoxGeometry(1, 1, 1);
  // white base so per-instance color (setColorAt) reads true — both the home city
  // and the procedural towns tint this via instanceColor rather than multiplying.
  const buildingMat = mat(0xffffff, { roughness: 0.8, flat: false });
  const padGeo = new THREE.CircleGeometry(27, 24);

  const TREES = 600;
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
  // keep scenery out of the lake
  const lakeC = { x: 300, z: 300, r: 70 };
  const nearLake = (x, z) => { const dx = x - lakeC.x, dz = z - lakeC.z; return dx * dx + dz * dz < (lakeC.r + 6) * (lakeC.r + 6); };

  let ti = 0;
  let guard = 0;
  // forest clusters
  while (ti < TREES && guard++ < TREES * 12) {
    // cluster centers within the reservation (procedural biomes own everything else)
    const ccx = RES.x0 + rng() * (RES.x1 - RES.x0);
    const ccz = RES.z0 + rng() * (RES.z1 - RES.z0);
    const clusterN = 9 + Math.floor(rng() * 13);
    for (let k = 0; k < clusterN && ti < TREES; k++) {
      const x = ccx + (rng() - 0.5) * 30;
      const z = ccz + (rng() - 0.5) * 30;
      if (x < RES.x0 || x > RES.x1 || z < RES.z0 || z > RES.z1) continue;
      if (nearRoad(x, z, W / 2 + 5) || nearLake(x, z)) continue;
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

  // rocks — grouped into scattered rock fields (open ground left between them)
  const ROCKS = 220;
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, ROCKS);
  rocks.castShadow = true;
  let ri = 0;
  guard = 0;
  while (ri < ROCKS && guard++ < ROCKS * 12) {
    const ccx = RES.x0 + rng() * (RES.x1 - RES.x0), ccz = RES.z0 + rng() * (RES.z1 - RES.z0);
    const n = 4 + Math.floor(rng() * 6);
    for (let k = 0; k < n && ri < ROCKS; k++) {
      const x = ccx + (rng() - 0.5) * 46;
      const z = ccz + (rng() - 0.5) * 46;
      if (x < RES.x0 || x > RES.x1 || z < RES.z0 || z > RES.z1) continue;
      if (nearRoad(x, z, W / 2 + 4) || nearLake(x, z)) continue;
      const rsc = 0.5 + rng() * 1.6;
      dummy.position.set(x, 0.4 + rng() * 0.6, z);
      dummy.rotation.set(rng(), rng() * Math.PI, rng());
      dummy.scale.setScalar(rsc);
      dummy.updateMatrix();
      rocks.setMatrixAt(ri++, dummy.matrix);
      solids.push({ x, z, r: rsc * 1.4 });
    }
  }
  for (; ri < ROCKS; ri++) {
    dummy.position.set(0, -50, 0);
    dummy.updateMatrix();
    rocks.setMatrixAt(ri, dummy.matrix);
  }
  rocks.instanceMatrix.needsUpdate = true;
  group.add(rocks);

  // (perimeter hills removed — procedural biomes provide the surrounding landscape)

  // a calm lake (landmark / atmosphere)
  const lakeMat = new THREE.MeshStandardMaterial({ color: preset.neon, roughness: 0.15, metalness: 0.6, transparent: true, opacity: 0.55 });
  const lake = new THREE.Mesh(new THREE.CircleGeometry(lakeC.r, 40), lakeMat);
  lake.rotation.x = -Math.PI / 2;
  lake.position.set(lakeC.x, 0.04, lakeC.z);
  group.add(lake);

  // bushes for ground detail (instanced)
  const bushGeo = new THREE.IcosahedronGeometry(1.1, 0);
  const bushMat = mat(0x4a7d4a, { roughness: 1 });
  const BUSHES = 380;
  const bushes = new THREE.InstancedMesh(bushGeo, bushMat, BUSHES);
  bushes.castShadow = false; // tiny ground detail — skip the shadow-pass cost
  let bi = 0;
  guard = 0;
  while (bi < BUSHES && guard++ < BUSHES * 12) {
    const ccx = RES.x0 + rng() * (RES.x1 - RES.x0), ccz = RES.z0 + rng() * (RES.z1 - RES.z0);
    const n = 5 + Math.floor(rng() * 8);
    for (let k = 0; k < n && bi < BUSHES; k++) {
      const x = ccx + (rng() - 0.5) * 40;
      const z = ccz + (rng() - 0.5) * 40;
      if (x < RES.x0 || x > RES.x1 || z < RES.z0 || z > RES.z1) continue;
      if (nearRoad(x, z, W / 2 + 3) || nearLake(x, z)) continue;
      const sc = 0.5 + rng() * 0.9;
      dummy.position.set(x, sc * 0.7, z);
      dummy.rotation.set(0, rng() * Math.PI, 0);
      dummy.scale.set(sc * 1.4, sc, sc * 1.4);
      dummy.updateMatrix();
      bushes.setMatrixAt(bi++, dummy.matrix);
    }
  }
  for (; bi < BUSHES; bi++) { dummy.position.set(0, -50, 0); dummy.updateMatrix(); bushes.setMatrixAt(bi, dummy.matrix); }
  bushes.instanceMatrix.needsUpdate = true;
  group.add(bushes);

  // ---- a bigger low-poly CITY: a rotated street grid to drift through -------
  // Buildings sit on a jittered grid rotated by townRot; footprints stay well
  // under the cell size so the "streets" between them are wide enough to drift.
  // Each is stored as an oriented box for exact-footprint collision.
  const townX = -210, townZ = 150;
  const townRot = 0.35, tcos = Math.cos(townRot), tsin = Math.sin(townRot);
  const winMat = mat(0xffe7a8, { emissive: 0xffe7a8, emissiveIntensity: 0.5, roughness: 0.6 });
  const GRID = 9, CELL = 46, gHalf = (GRID - 1) / 2;
  // Collect the building footprints first, then pack them into two InstancedMeshes
  // (bodies + emissive window bands) so the whole city costs 2 draw calls instead
  // of ~120. Each still stores an oriented box for exact-footprint collision.
  const citySpecs = [];
  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      if (rng() < 0.24) continue; // open lots / plazas for drift room
      const lx = (gx - gHalf) * CELL + (rng() - 0.5) * 12;
      const lz = (gz - gHalf) * CELL + (rng() - 0.5) * 12;
      const wx = townX + (tcos * lx + tsin * lz);
      const wz = townZ + (-tsin * lx + tcos * lz);
      if (Math.hypot(wx, wz) > WORLD.boundary - 40) continue;
      if (nearRoad(wx, wz, 26)) continue; // keep the whole footprint off the roads
      const bw = 12 + rng() * 15; // footprint < CELL so streets stay driftable
      const bd = 12 + rng() * 15;
      const bh = 9 + rng() * 40;
      const shade = 0x6b7180 + Math.floor(rng() * 0x10) * 0x010101;
      citySpecs.push({ wx, wz, bw, bd, bh, shade });
      boxes.push({ x: wx, z: wz, hw: bw / 2, hd: bd / 2, cos: tcos, sin: tsin });
    }
  }
  if (citySpecs.length) {
    const bodies = new THREE.InstancedMesh(buildingGeo, buildingMat, citySpecs.length);
    bodies.castShadow = true; bodies.receiveShadow = true;
    const bands = new THREE.InstancedMesh(buildingGeo, winMat, citySpecs.length);
    const _bd = new THREE.Object3D(), _bc = new THREE.Color();
    citySpecs.forEach((s, i) => {
      _bd.position.set(s.wx, s.bh / 2, s.wz); _bd.rotation.set(0, townRot, 0); _bd.scale.set(s.bw, s.bh, s.bd);
      _bd.updateMatrix(); bodies.setMatrixAt(i, _bd.matrix); bodies.setColorAt(i, _bc.setHex(s.shade));
      _bd.position.set(s.wx, s.bh * 0.68, s.wz); _bd.scale.set(s.bw * 1.01, s.bh * 0.1, s.bd * 1.01);
      _bd.updateMatrix(); bands.setMatrixAt(i, _bd.matrix);
    });
    bodies.instanceMatrix.needsUpdate = true; if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    bands.instanceMatrix.needsUpdate = true;
    // proper bounds so the city frustum-culls as a unit when you drive away
    bodies.computeBoundingSphere(); bands.computeBoundingSphere();
    group.add(bodies); group.add(bands);
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

  // (no world-boundary ring/wall — the world is endless now)

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
  scene.add(dust); // dust follows the camera in render space — not the (rebaseable) home group

  function updateAtmosphere(cam, dt) {
    // dust fades to opacity 0 in the rain — skip the per-frame JS loop AND the full VBO
    // re-upload while it's invisible (three doesn't cull opacity-0 Points on its own).
    if (dustMat.opacity < 0.01) { if (dust.visible) dust.visible = false; return; }
    if (!dust.visible) dust.visible = true;
    for (let i = 0; i < DUST; i++) {
      let x = dustPos[i * 3] + dustVel[i * 3] * dt;
      let y = dustPos[i * 3 + 1] + dustVel[i * 3 + 1] * dt;
      let z = dustPos[i * 3 + 2] + dustVel[i * 3 + 2] * dt;
      // wrap around the camera so motes always surround the player (while: catches
      // up in one frame even after a large origin rebase)
      while (x - cam.x > DUST_RANGE) x -= DUST_RANGE * 2;
      while (x - cam.x < -DUST_RANGE) x += DUST_RANGE * 2;
      while (z - cam.z > DUST_RANGE) z -= DUST_RANGE * 2;
      while (z - cam.z < -DUST_RANGE) z += DUST_RANGE * 2;
      if (y > 30) y = 1;
      dustPos[i * 3] = x; dustPos[i * 3 + 1] = y; dustPos[i * 3 + 2] = z;
    }
    dustGeo.attributes.position.needsUpdate = true;
  }

  // wet-road look (0..1): road/track get glossier + darker, dust fades out. asphalt &
  // trackMat are shared with the streamer, so procedural roads turn wet too.
  function setWet(t) {
    asphalt.roughness = 0.95 - 0.42 * t; asphalt.metalness = 0.32 * t;
    trackMat.roughness = 0.92 - 0.42 * t; trackMat.metalness = 0.32 * t;
    dustMat.opacity = 0.3 * (1 - t);
  }

  return {
    group,
    colliders: { solids, boxes, walls, postList, cones }, // ABSOLUTE coords, bucketed by the streamer
    postsMesh: posts,
    driftTrack, onDriftTrack, // absolute-space
    townCenter: { x: townX, z: townZ }, // absolute
    lightAnchors, // static lamp positions (absolute) for the streamer's shared light pool
    setTrackLights, setWet, updateAtmosphere,
    postMat, edgeMat, trackWallTopMat, // for applyWorldPreset (shared with streamed content)
    shared: {
      roadMat: asphalt, edgeMat, dashMat,
      trunkGeo, trunkMat, canopyGeo: topGeo, canopyMat: leafMat,
      rockGeo, rockMat, bushGeo, bushMat,
      buildingGeo, buildingMat, winMat,
      trackMat, wallMat, wallCapMat: trackWallTopMat,
      coneGeo, coneMat, padGeo,
    },
  };
}

// ===========================================================================
// buildWorld — endless world: the authored home region + a procedural streamer.
// Returns the SAME facade shape main.js/resolveCollisions expect. The collision
// arrays are the streamer's active set (refilled in place around the car). See
// ENDLESS_WORLD_PLAN.md.
// ===========================================================================
export function buildWorld(scene, preset) {
  const home = buildHomeRegion(scene, preset);
  const streamer = createStreamer({ scene, shared: home.shared, home });
  // per-session seed (reproduction beyond the session is a non-goal — see the plan)
  const seed = (typeof crypto !== 'undefined' && crypto.getRandomValues)
    ? crypto.getRandomValues(new Uint32Array(1))[0] : ((Date.now?.() || 1) >>> 0);
  streamer.setSeed(seed);
  streamer.primeAround(40, -30); // SPAWN is in the home region — colliders ready on frame 1
  const shift = streamer.shiftTotal; // render = absolute - shift

  return {
    group: home.group,
    // active collision arrays (stable identity — the streamer refills them in place)
    solids: streamer.active.solids, boxes: streamer.active.boxes, walls: streamer.active.walls,
    postList: streamer.active.postList, cones: streamer.active.cones,
    posts: home.postsMesh,
    postMat: home.postMat, edgeMat: home.edgeMat, trackWallTopMat: home.trackWallTopMat,
    ringMat: null, boundaryWallMat: null, dustMat: null, driftTrack: home.driftTrack,
    // gameplay queries take RENDER coords -> convert to ABSOLUTE for the home data
    onDriftTrack: (x, z) => home.onDriftTrack(x + shift.x, z + shift.z),
    get townCenter() { return { x: home.townCenter.x - shift.x, z: home.townCenter.z - shift.z }; },
    onProcCircuit: (x, z) => streamer.procCircuitAt(x, z),
    onProcTown: (x, z) => streamer.procTownAt(x, z),
    onProcGate: (x, z) => streamer.procGateAt(x, z), // fires once per gate pass (grants boost)
    nearestLandmarks: (x, z, k) => streamer.nearestLandmarks(x, z, k), // render coords → compass targets
    regionAt: (x, z) => streamer.regionAt(x, z),
    // absolute distance from the home origin (render -> absolute via + shift)
    homeDist: (x, z) => Math.hypot(x + shift.x, z + shift.z),
    nearestRoad: (x, z) => streamer.nearestRoad(x, z), // render coords in/out (far-from-home respawn)
    updateAtmosphere: home.updateAtmosphere,
    // Night level 0..1 (or boolean): dims the home lamp heads AND the shared PointLight
    // pool together. Used by applyWorldPreset and the auto day/night cycle.
    setNight: (level) => { home.setTrackLights(level); streamer.setNightLevel(level); },
    setTrackLights: home.setTrackLights,
    // recolor the shared neon materials (kerbs/posts/track caps) — used by the day/night lerp
    setNeon: (hex) => {
      home.postMat.color.setHex(hex); home.postMat.emissive.setHex(hex);
      if (home.edgeMat) { home.edgeMat.color.setHex(hex); home.edgeMat.emissive.setHex(hex); }
      if (home.trackWallTopMat) { home.trackWallTopMat.color.setHex(hex); home.trackWallTopMat.emissive.setHex(hex); }
    },
    consumeShadowDirty: () => streamer.consumeShadowDirty(),
    // wet-road look (0..1): dulls road/track sheen, darkens ground, hides dust
    setWet: (t) => home.setWet && home.setWet(t),
    setQuality: (q) => streamer.setQuality(q),
    setRebase: (fn) => streamer.setRebase(fn),
    setSeed: (s) => streamer.setSeed(s),
    update: (carState, dt) => streamer.update(carState, dt),
    streamer,
  };
}

// Push-out vs the active 3x3 collider set (solids/boxes/walls/cones/posts, all in
// RENDER coords, refilled by the streamer). Endless — no world boundary. Returns
// true only on a hard slam. The result is a pooled object (read it before the next
// call) so the 120/s collision pass allocates nothing.
const _colOut = { crash: false, cones: 0, posts: 0, nearMisses: 0 };
export function resolveCollisions(state, world) {
  let hardHit = false;
  let nm = 0; // near-miss shaves this substep

  // near-miss band: while drifting fast, sliding CLOSE to a solid (but not hitting it)
  // scores a bonus. Per-object latch (_nm) so one shave counts once until the car pulls
  // clear; the active arrays are rebuilt each gather so latches self-reset on chunk-cross.
  // The gate MUST be a subset of scoring.step's `valid` (drifting + slip>minSlipDeg +
  // speed) or a shave gets latched-but-never-scored and can't be re-earned that pass.
  const nmActive = state.drifting && state.speed > SCORE.nearMissMinSpeed &&
    Math.abs(state.slip) * 57.29577951 > SCORE.minSlipDeg;
  const nmBand = SCORE.nearMissBand, nmClear = nmBand * 1.8;

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
      o._nm = 2; // hit this pass — cancels any pending shave (a hit must NOT read as a near-miss)
      const d = Math.max(Math.sqrt(d2), 0.001);
      const nx = dx / d;
      const nz = dz / d;
      state.x = o.x + nx * rr; // push out to the surface
      state.z = o.z + nz * rr;
      const vIn = state.vx * nx + state.vz * nz; // velocity along outward normal
      if (vIn < 0) {
        state.vx -= (1 + e) * vIn * nx; // reflect the inward component
        state.vz -= (1 + e) * vIn * nz;
        if (-vIn > WORLD.crashSpeed) hardHit = true; // any real contact with a solid breaks the combo
      }
      state.vx *= 0.82; // scrub speed on contact
      state.vz *= 0.82;
    } else {
      const band = rr + nmBand;
      if (d2 < band * band) { if (nmActive && o._nm !== 2) o._nm = 1; } // inside the shave band
      else if (d2 > (rr + nmClear) * (rr + nmClear)) { if (o._nm === 1) nm++; o._nm = 0; } // pulled CLEAR without hitting → credit
    }
  }

  // buildings: oriented-box (OBB) collision so contact matches the real footprint
  for (const b of world.boxes) {
    const rx = state.x - b.x, rz = state.z - b.z;
    const lx = b.cos * rx - b.sin * rz; // world -> box-local
    const lz = b.sin * rx + b.cos * rz;
    const clx = clamp(lx, -b.hw, b.hw);
    const clz = clamp(lz, -b.hd, b.hd);
    const ox = lx - clx, oz = lz - clz;
    const d2 = ox * ox + oz * oz;
    if (d2 >= carR * carR) {
      const band = carR + nmBand;
      if (d2 < band * band) { if (nmActive && b._nm !== 2) b._nm = 1; }
      else if (d2 > (carR + nmClear) * (carR + nmClear)) { if (b._nm === 1) nm++; b._nm = 0; }
      continue;
    }
    b._nm = 2; // colliding — cancel any pending shave
    let nlx, nlz, pen;
    if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      nlx = ox / d; nlz = oz / d; pen = carR - d;
    } else {
      // car centre is inside the footprint — eject through the nearest face
      const px = b.hw - Math.abs(lx), pz = b.hd - Math.abs(lz);
      if (px < pz) { nlx = lx < 0 ? -1 : 1; nlz = 0; pen = px + carR; }
      else { nlx = 0; nlz = lz < 0 ? -1 : 1; pen = pz + carR; }
    }
    const wnx = b.cos * nlx + b.sin * nlz; // box-local -> world
    const wnz = -b.sin * nlx + b.cos * nlz;
    state.x += wnx * pen;
    state.z += wnz * pen;
    const vIn = state.vx * wnx + state.vz * wnz;
    if (vIn < 0) {
      state.vx -= (1 + e) * vIn * wnx; // reflect inward component
      state.vz -= (1 + e) * vIn * wnz;
      if (-vIn > WORLD.crashSpeed) hardHit = true; // clipping a building breaks the combo
    }
    state.vx *= 0.82; // scrub speed on contact
    state.vz *= 0.82;
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
      if (c.persist && c.knock >= 0.8) c.knocked = true; // wild cones stay flattened (+persist across reload)
    }
  }

  // track / circuit walls: smooth segment collision — slide along, hard slam breaks
  // combo. The active set is already spatially local (3x3 around the car), so no cull.
  const half = carR + WORLD.wallThickness * 0.5;
  for (const w of world.walls) {
    const ex = w.x2 - w.x1, ez = w.z2 - w.z1;
    const len2 = ex * ex + ez * ez || 1e-6;
    let t = ((state.x - w.x1) * ex + (state.z - w.z1) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = w.x1 + ex * t, pz = w.z1 + ez * t;
    const wdx = state.x - px, wdz = state.z - pz;
    const wd2 = wdx * wdx + wdz * wdz;
    if (wd2 < half * half) {
      w._nm = 2; // touching the wall — cancel any pending shave
      const d = Math.max(Math.sqrt(wd2), 0.001);
      const nx = wdx / d, nz = wdz / d;
      state.x = px + nx * half; // push out to the wall surface
      state.z = pz + nz * half;
      const vIn = state.vx * nx + state.vz * nz; // velocity along outward normal
      if (vIn < 0) {
        state.vx -= (1 + e) * vIn * nx; // reflect the inward component
        state.vz -= (1 + e) * vIn * nz;
        if (-vIn > WORLD.wallSlamSpeed) hardHit = true; // slamming a wall breaks it (you can still slide along)
      }
      state.vx *= 0.88; // scrub some speed on contact
      state.vz *= 0.88;
    } else {
      const band = half + nmBand;
      if (wd2 < band * band) { if (nmActive && w._nm !== 2) w._nm = 1; }
      else if (wd2 > (half + nmClear) * (half + nmClear)) { if (w._nm === 1) nm++; w._nm = 0; }
    }
  }

  // roadside posts (blue sticks): collidable bollards — bend over, slow you a touch.
  // p.rx/p.rz are the RENDER-space coords set by the streamer gather (p.x/p.z stay
  // absolute for the mesh matrix in updatePosts).
  let postHits = 0;
  const postRR = 0.5 + carR;
  for (const p of world.postList) {
    if (p.fallen) continue;
    const px = p.rx !== undefined ? p.rx : p.x;
    const pz = p.rz !== undefined ? p.rz : p.z;
    const dx = state.x - px;
    const dz = state.z - pz;
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

  _colOut.crash = hardHit; _colOut.cones = coneHits; _colOut.posts = postHits; _colOut.nearMisses = nm;
  return _colOut;
}

// reused scratch for updatePosts (called every render frame → no per-frame allocation)
const _upM = new THREE.Matrix4();
const _upRot = new THREE.Matrix4();
const _upPivot = new THREE.Matrix4().makeTranslation(0, 1.2, 0);
const _upAxis = new THREE.Vector3();

// Animate knocked-over posts (called each render frame).
export function updatePosts(world, dt) {
  let changed = false;
  for (const p of world.postList) {
    if (!p.knocking || p._settled) continue;
    p.knock = Math.min(1, p.knock + dt * 3.2);
    const tilt = p.knock * (Math.PI / 2) * 0.96;
    _upAxis.set(Math.cos(p.dir), 0, -Math.sin(p.dir)).normalize();
    _upRot.makeRotationAxis(_upAxis, tilt);
    _upM.makeTranslation(p.x, 0, p.z).multiply(_upRot).multiply(_upPivot);
    world.posts.setMatrixAt(p.i, _upM);
    changed = true;
    if (p.knock >= 1) { p.fallen = true; p._settled = true; }
  }
  if (changed) world.posts.instanceMatrix.needsUpdate = true;
}

export function updateCones(world, dt) {
  for (const c of world.cones) {
    if (c.knocked) { // persistent flattened cone (wild slalom) — stays down, no wobble
      if (c.mesh.rotation.z !== 1.5) { c.mesh.rotation.z = 1.5; c.mesh.position.y = c.baseY - 0.12; }
      continue;
    }
    if (c.knock > 0) {
      c.knock = Math.max(0, c.knock - dt * 1.5);
      c.mesh.rotation.z = Math.sin(c.knock * 18) * c.knock * 0.5;
      c.mesh.position.y = c.baseY - c.knock * 0.15;
    }
  }
}

export function applyWorldPreset(world, preset) {
  if (world.setNeon) world.setNeon(preset.neon);
  // preset.night is `true` on the night preset, a 0..1 float from the day/night blend,
  // or undefined on day presets — normalise all three to a level
  if (world.setNight) world.setNight(preset.night === true ? 1 : (preset.night || 0));
}
