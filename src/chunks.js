// ============================================================================
// chunks.js — the endless-world STREAMER. Loads/unloads 256 m chunks around the
// car, builds their meshes from worldgen describers (pooled instanced scenery +
// per-chunk road/wall geometry), maintains the 3x3 active COLLISION set that
// resolveCollisions reads, and rebases the origin so Float32 never drifts.
//
// Coordinate rule: everything is stored ABSOLUTE. render = absolute - shiftTotal.
// A chunk group sits at (chunkAbsOrigin - shiftTotal); its vertices are chunk-
// local, so a rebase only moves group.position — geometry is never touched.
// ============================================================================

import * as THREE from 'three';
import { CHUNK, WORLD } from './config.js';
import { describeChunk } from './worldgen.js';

const CS = CHUNK.size;
const keyOf = (cx, cz) => ((cx + 0x8000) << 16) | (cz + 0x8000);

// ---- a recyclable pool of InstancedMesh for one species --------------------
function makePool(geo, mat, cap, slots, castShadow) {
  const free = [];
  for (let i = 0; i < slots; i++) {
    const m = new THREE.InstancedMesh(geo, mat, cap);
    m.count = 0;
    m.castShadow = castShadow;
    m.receiveShadow = false;
    m.frustumCulled = true;
    m.visible = false;
    free.push(m);
  }
  return { free, all: free.slice() };
}

export function createStreamer({ scene, shared, home, quality = 'medium', onRebase = () => {} }) {
  let rebaseCb = onRebase;
  const dummy = new THREE.Object3D();
  const shiftTotal = { x: 0, z: 0 };
  const records = new Map();          // key -> chunk record
  const buildQueue = [];              // records awaiting mesh realization
  let carCX = 1e9, carCZ = 1e9;       // last car chunk (force first gather)

  // ---- pools --------------------------------------------------------------
  // Every scenery pool must hold at least one mesh for EVERY chunk that can be
  // resident at once, because a chunk that fails to check out a mesh finalizes
  // LIVE with no scenery instances AND no scenery colliders (the car would drive
  // through the rocks/trees) and never retries. The resident set is the Chebyshev
  // (visualRing+1) hysteresis window, and biome noise (~1.6 km wavelength) means a
  // single species can fill nearly all of it — so the old rock/bush 0.7-scaling
  // was unsafe. Derive the slot count from config so it can't silently drift again.
  const maxVis = Math.max(CHUNK.visualRing.low, CHUNK.visualRing.medium, CHUNK.visualRing.high);
  const S = Math.max(CHUNK.poolSlots, (2 * (maxVis + 1) + 1) ** 2); // = 121 at visualRing 4
  const pools = {
    trunk: makePool(shared.trunkGeo, shared.trunkMat, CHUNK.perChunkCaps.trees, S, true),
    canopy: makePool(shared.canopyGeo, shared.canopyMat, CHUNK.perChunkCaps.trees, S, true),
    rock: makePool(shared.rockGeo, shared.rockMat, CHUNK.perChunkCaps.rocks, S, true),
    bush: makePool(shared.bushGeo, shared.bushMat, CHUNK.perChunkCaps.bushes, S, false),
    // town buildings come only from rare landmark chunks (<=1 per chunk, ~1 town per
    // ~150 chunks) so a small fixed pool is safe here.
    building: makePool(shared.buildingGeo, shared.buildingMat, CHUNK.perChunkCaps.buildings, 40, true),
  };
  const checkout = (pool) => (pool.free.length ? pool.free.pop() : null);
  const checkin = (pool, m) => { m.count = 0; m.visible = false; if (m.parent) m.parent.remove(m); pool.free.push(m); };

  // ---- knocked-prop persistence: chunkKey -> Set(coneIdx) flattened by the player.
  // A revisited chunk pre-flattens these so wild slaloms stay wrecked (home cones,
  // which never unload, keep their self-righting wobble). Populated at unloadChunk.
  const knockedCones = new Map();

  // ---- procedural circuit night lighting: a shared pool of CHUNK.lightCap
  // shadowless PointLights, always in the scene (constant light count → no shader
  // recompiles), reassigned to the nearest active circuits and lit only at night.
  const circuitLights = [];
  for (let i = 0; i < CHUNK.lightCap; i++) {
    const pl = new THREE.PointLight(0xffe7b5, 0, 95, 2);
    pl.position.set(0, 14, 0);
    scene.add(pl);
    circuitLights.push(pl);
  }
  let nightOn = false, lightAcc = 0;
  function assignCircuitLights(carX, carZ) {
    const cs = [];
    for (const rec of records.values()) if (rec.procCircuit) {
      const rx = rec.procCircuit.x - shiftTotal.x, rz = rec.procCircuit.z - shiftTotal.z;
      cs.push({ rx, rz, d: (rx - carX) ** 2 + (rz - carZ) ** 2 });
    }
    cs.sort((a, b) => a.d - b.d);
    for (let i = 0; i < circuitLights.length; i++) {
      const l = circuitLights[i];
      if (nightOn && i < cs.length) { l.position.set(cs[i].rx, 14, cs[i].rz); l.intensity = 24; }
      else l.intensity = 0;
    }
  }

  // ---- active collision set (identity stable — resolveCollisions reads these)
  const active = { solids: [], boxes: [], walls: [], postList: [], cones: [] };

  // ---- home region bucketed into absolute chunks --------------------------
  // home colliders are ABSOLUTE; the gather converts to render (- shiftTotal).
  const homeBuckets = new Map();
  function bucket(map, cx, cz, kind, item) {
    const k = keyOf(cx, cz);
    let b = map.get(k); if (!b) { b = { solids: [], boxes: [], walls: [], postList: [], cones: [] }; map.set(k, b); }
    b[kind].push(item);
  }
  (function bucketHome() {
    for (const s of home.colliders.solids) bucket(homeBuckets, Math.floor(s.x / CS), Math.floor(s.z / CS), 'solids', s);
    for (const b of home.colliders.boxes) bucket(homeBuckets, Math.floor(b.x / CS), Math.floor(b.z / CS), 'boxes', b);
    for (const p of home.colliders.postList) bucket(homeBuckets, Math.floor(p.x / CS), Math.floor(p.z / CS), 'postList', p);
    for (const c of home.colliders.cones) bucket(homeBuckets, Math.floor(c.x / CS), Math.floor(c.z / CS), 'cones', c);
    // walls: bucket each segment by its midpoint chunk
    for (const w of home.colliders.walls) bucket(homeBuckets, Math.floor((w.x1 + w.x2) / 2 / CS), Math.floor((w.z1 + w.z2) / 2 / CS), 'walls', w);
  })();
  const isHome = (cx, cz) => cx >= CHUNK.homeMin.cx && cx <= CHUNK.homeMax.cx && cz >= CHUNK.homeMin.cz && cz <= CHUNK.homeMax.cz;

  // ---- ribbon / wall geometry builders (chunk-local coords) ---------------
  const UP = new THREE.Vector3(0, 1, 0);
  function polyPerp(samples, i) {
    const a = samples[Math.max(0, i - 1)], b = samples[Math.min(samples.length - 1, i + 1)];
    const tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz) || 1;
    return { x: -tz / l, z: tx / l };
  }
  // append one ribbon strip into shared pos/nor/idx arrays (base-offset the index)
  function ribbonInto(pos, nor, idx, samples, ox, oz, width, y, closed) {
    const half = width / 2, n = samples.length, base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const c = samples[i], p = polyPerp(samples, i);
      const cx = c.x - ox, cz = c.z - oz;
      pos.push(cx + p.x * half, y, cz + p.z * half, cx - p.x * half, y, cz - p.z * half);
      nor.push(0, 1, 0, 0, 1, 0);
    }
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) { const a = base + i * 2, b = a + 1, cc = base + ((i + 1) % n) * 2, d = cc + 1; idx.push(a, cc, b, b, cc, d); }
  }
  function geoFrom(pos, nor, idx) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx);
    return g;
  }
  function ribbonGeo(samples, ox, oz, width, y, closed) {
    const pos = [], nor = [], idx = [];
    ribbonInto(pos, nor, idx, samples, ox, oz, width, y, closed);
    return geoFrom(pos, nor, idx);
  }
  // vertical wall strip + collect world-abs segments; returns {geo, segs}
  function wallGeo(samples, ox, oz, offset, closed) {
    const pos = [], nor = [], col = [], idx = [], line = [], n = samples.length, h = WORLD.wallHeight;
    for (let i = 0; i < n; i++) {
      const c = samples[i], p = polyPerp(samples, i);
      const bx = c.x + p.x * offset, bz = c.z + p.z * offset;
      line.push([bx, bz]);
      pos.push(bx - ox, 0.02, bz - oz, bx - ox, h, bz - oz);
      nor.push(p.x, 0, p.z, p.x, 0, p.z);
      const white = Math.floor(i / 3) % 2 === 0;
      const r = white ? 0.9 : 0.81, g = white ? 0.9 : 0.23, b = white ? 0.93 : 0.2;
      col.push(r, g, b, r, g, b);
    }
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) { const a = i * 2, b = a + 1, cc = ((i + 1) % n) * 2, d = cc + 1; idx.push(a, cc, b, b, cc, d); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    const wallSegs = [];
    for (let i = 0; i < segs; i++) { const [x1, z1] = line[i]; const [x2, z2] = line[(i + 1) % n]; wallSegs.push({ x1, z1, x2, z2 }); }
    return { geo, segs: wallSegs };
  }

  // ---- build a procedural chunk's meshes + colliders ----------------------
  function buildProc(rec) {
    const desc = describeChunk(rec.seed, rec.cx, rec.cz);
    const ox = rec.cx * CS, oz = rec.cz * CS;
    const grp = rec.group;
    const col = rec.col = { solids: [], boxes: [], walls: [], postList: [], cones: [] };
    const disp = rec.disposables = [];

    // roads: merge every edge in this chunk into ONE surface mesh + ONE neon-edge
    // mesh (2 draw calls / chunk) instead of 3 per edge — the biggest streaming win.
    const sp = [], sn = [], si = []; // road surface
    const ep = [], en = [], ei = []; // neon edge lines
    for (const e of desc.roads) {
      const s = e.samples; if (s.length < 2) continue;
      ribbonInto(sp, sn, si, s, ox, oz, e.width, 0.02, false);
      for (const off of [e.width / 2 - 0.35, -e.width / 2 + 0.35]) {
        const offSamples = s.map((c, i) => { const p = polyPerp(s, i); return { x: c.x + p.x * off, z: c.z + p.z * off }; });
        ribbonInto(ep, en, ei, offSamples, ox, oz, 0.5, 0.035, false);
      }
    }
    if (si.length) { const gg = geoFrom(sp, sn, si); const surf = new THREE.Mesh(gg, shared.roadMat); surf.receiveShadow = true; grp.add(surf); disp.push(gg); }
    if (ei.length) { const gg = geoFrom(ep, en, ei); grp.add(new THREE.Mesh(gg, shared.edgeMat)); disp.push(gg); }
    // junction pads (dark disc at high-degree nodes)
    for (const j of desc.junctions) {
      const pad = new THREE.Mesh(shared.padGeo, shared.roadMat);
      pad.rotation.x = -Math.PI / 2; pad.position.set(j.x - ox, 0.018, j.z - oz);
      pad.receiveShadow = true; grp.add(pad);
    }

    // scenery (pooled instanced, chunk-local matrices)
    fillScatter(grp, col, desc.scenery.trees, ox, oz, rec, 'trunk', 'canopy');
    fillInstances(grp, desc.scenery.rocks, ox, oz, rec, 'rock', (it) => 0.4, (it) => ({ r: it.s * 1.4 }), col);
    fillInstances(grp, desc.scenery.bushes, ox, oz, rec, 'bush', (it) => it.s * 0.7, null, null);

    if (desc.landmark) buildLandmark(rec, desc, ox, oz, col, disp);
  }

  const _bsC = new THREE.Vector3(CS / 2, 16, CS / 2);
  function poolMeshInit(m, rec) {
    m.count = 0; m.visible = true;
    m.boundingSphere = new THREE.Sphere(_bsC.clone(), CS * 1.05); // local-space cull sphere covering the chunk
    rec.checkedOut.push(m);
  }
  function fillInstances(grp, items, ox, oz, rec, poolName, yFn, solidFn, col) {
    if (!items.length) return;
    const m = checkout(pools[poolName]); if (!m) return;
    poolMeshInit(m, rec);
    let i = 0;
    for (const it of items) {
      if (i >= m.instanceMatrix.count) break;
      dummy.position.set(it.x - ox, yFn(it), it.z - oz);
      dummy.rotation.set(0, it.rot, 0);
      const sc = poolName === 'bush' ? it.s : it.s;
      dummy.scale.set(poolName === 'bush' ? sc * 1.4 : sc, sc, poolName === 'bush' ? sc * 1.4 : sc);
      dummy.updateMatrix(); m.setMatrixAt(i++, dummy.matrix);
      if (solidFn && col) col.solids.push({ x: it.x, z: it.z, r: solidFn(it).r });
    }
    m.count = i; m.instanceMatrix.needsUpdate = true;
    grp.add(m);
  }
  function fillScatter(grp, col, trees, ox, oz, rec, trunkPool, canopyPool) {
    if (!trees.length) return;
    const tm = checkout(pools[trunkPool]), cm = checkout(pools[canopyPool]);
    if (!tm || !cm) { if (tm) checkin(pools[trunkPool], tm); if (cm) checkin(pools[canopyPool], cm); return; }
    poolMeshInit(tm, rec); poolMeshInit(cm, rec);
    let i = 0;
    for (const it of trees) {
      if (i >= tm.instanceMatrix.count) break;
      const sc = it.s;
      dummy.position.set(it.x - ox, 1.1 * sc, it.z - oz); dummy.rotation.set(0, it.rot, 0); dummy.scale.setScalar(sc);
      dummy.updateMatrix(); tm.setMatrixAt(i, dummy.matrix);
      dummy.position.set(it.x - ox, (2.2 + 1.9) * sc, it.z - oz); dummy.updateMatrix(); cm.setMatrixAt(i, dummy.matrix);
      col.solids.push({ x: it.x, z: it.z, r: 1.0 + sc * 0.3 });
      i++;
    }
    tm.count = i; cm.count = i; tm.instanceMatrix.needsUpdate = true; cm.instanceMatrix.needsUpdate = true;
    grp.add(tm); grp.add(cm);
  }

  // ---- landmarks (footprint <= 1 chunk) -----------------------------------
  function buildLandmark(rec, desc, ox, oz, col, disp) {
    const cxC = ox + CS / 2, czC = oz + CS / 2;
    const grp = rec.group;
    if (desc.landmark.kind === 'circuit') {
      // a small walled drift circuit (radius ~78m)
      const pts = [], R = 70, N = 9;
      const rr = (i) => R * (0.75 + 0.25 * Math.sin(i * 1.7 + rec.cx));
      for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; pts.push({ x: cxC + Math.cos(a) * rr(i), z: czC + Math.sin(a) * rr(i) }); }
      const s = closedResample(pts);
      const surf = new THREE.Mesh(ribbonGeo(s, ox, oz, 24, 0.03, true), shared.trackMat); surf.receiveShadow = true; grp.add(surf); disp.push(surf.geometry);
      for (const off of [-14.2, 14.2]) {
        const w = wallGeo(s, ox, oz, off, true);
        const wm = new THREE.Mesh(w.geo, shared.wallMat); wm.castShadow = true; grp.add(wm); disp.push(w.geo);
        const cap = new THREE.Mesh(ribbonGeo(s.map((c, i) => { const p = polyPerp(s, i); return { x: c.x + p.x * off, z: c.z + p.z * off }; }), ox, oz, 0.6, WORLD.wallHeight, true), shared.wallCapMat);
        grp.add(cap); disp.push(cap.geometry);
        for (const seg of w.segs) col.walls.push(seg);
      }
      rec.procCircuit = { x: cxC, z: czC, r: R + 20 };
    } else if (desc.landmark.kind === 'town') {
      const rng = mulcell(rec.seed, rec.cx, rec.cz, 0xabcd);
      const G = 4, CELL = 40, gh = (G - 1) / 2, rot = rng() * Math.PI;
      const cs = Math.cos(rot), sn = Math.sin(rot);
      const bm = checkout(pools.building);
      if (bm) {
        poolMeshInit(bm, rec); let bi = 0;
        for (let gx = 0; gx < G; gx++) for (let gz = 0; gz < G; gz++) {
          if (rng() < 0.25 || bi >= bm.instanceMatrix.count) continue;
          const lx = (gx - gh) * CELL + (rng() - 0.5) * 10, lz = (gz - gh) * CELL + (rng() - 0.5) * 10;
          const wx = cxC + cs * lx + sn * lz, wz = czC - sn * lx + cs * lz;
          const bw = 12 + rng() * 14, bd = 12 + rng() * 14, bh = 9 + rng() * 34;
          dummy.position.set(wx - ox, bh / 2, wz - oz); dummy.rotation.set(0, rot, 0); dummy.scale.set(bw, bh, bd);
          dummy.updateMatrix(); bm.setMatrixAt(bi, dummy.matrix);
          bm.setColorAt(bi, tmpBuildingColor(rng));
          col.boxes.push({ x: wx, z: wz, hw: bw / 2, hd: bd / 2, cos: cs, sin: sn });
          bi++;
        }
        bm.count = bi; bm.instanceMatrix.needsUpdate = true; if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
        grp.add(bm);
      }
      rec.procTown = { x: cxC, z: czC };
    } else if (desc.landmark.kind === 'slalom') {
      const flat = knockedCones.get(rec.key); // cones the player already flattened here
      for (let i = 0; i < 14; i++) {
        const x = cxC + (i - 7) * 9, z = czC + (i % 2 ? 6 : -6);
        const c = new THREE.Mesh(shared.coneGeo, shared.coneMat); c.position.set(x - ox, 0.5, z - oz); c.castShadow = true; grp.add(c);
        const cone = { x, z, mesh: c, baseY: 0.5, knock: 0, persist: true, key: rec.key, idx: i, knocked: false };
        if (flat && flat.has(i)) { cone.knocked = true; cone.knock = 1; c.rotation.z = 1.5; c.position.y = 0.5 - 0.12; }
        col.cones.push(cone);
      }
    } else { // skidpad
      const pad = new THREE.Mesh(new THREE.CircleGeometry(46, 40), shared.trackMat); pad.rotation.x = -Math.PI / 2; pad.position.set(cxC - ox, 0.02, czC - oz); pad.receiveShadow = true; grp.add(pad); disp.push(pad.geometry);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(46, 0.5, 6, 48), shared.edgeMat); ring.rotation.x = -Math.PI / 2; ring.position.set(cxC - ox, 0.06, czC - oz); grp.add(ring); disp.push(ring.geometry);
    }
  }
  function closedResample(pts) {
    // catmull through closed points -> ~4m polyline
    const out = [], n = pts.length;
    const cr = (a, b, c, d, t) => { const t2 = t * t, t3 = t2 * t; return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3); };
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      const seg = Math.hypot(p2.x - p1.x, p2.z - p1.z), steps = Math.max(2, Math.round(seg / 4));
      for (let s = 0; s < steps; s++) { const t = s / steps; out.push({ x: cr(p0.x, p1.x, p2.x, p3.x, t), z: cr(p0.z, p1.z, p2.z, p3.z, t) }); }
    }
    return out;
  }
  const _bcol = new THREE.Color();
  function tmpBuildingColor(rng) { const s = 0.42 + rng() * 0.08; _bcol.setHSL(0.6, 0.08, s); return _bcol; }
  function mulcell(seed, cx, cz, salt) { let a = ((seed ^ salt) + cx * 374761393 + cz * 668265263) >>> 0; return function () { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // ---- chunk lifecycle ----------------------------------------------------
  function loadChunk(cx, cz) {
    const k = keyOf(cx, cz);
    if (records.has(k)) return records.get(k);
    const rec = { cx, cz, key: k, seed: streamerSeed, state: 'QUEUED', group: null, checkedOut: [], disposables: [], col: null, home: isHome(cx, cz) };
    records.set(k, rec);
    if (rec.home) { rec.state = 'LIVE'; rec.col = homeBuckets.get(k) || null; return rec; } // home is already in the scene
    const grp = new THREE.Group();
    grp.position.set(cx * CS - shiftTotal.x, 0, cz * CS - shiftTotal.z);
    rec.group = grp;
    buildQueue.push(rec);
    return rec;
  }
  function unloadChunk(rec) {
    if (rec.home) return; // home stays resident
    // remember which slalom cones the player flattened so a revisit restores them
    if (rec.col && rec.col.cones) {
      for (const cn of rec.col.cones) {
        if (cn.persist && cn.knocked) {
          let set = knockedCones.get(rec.key);
          if (!set) { set = new Set(); knockedCones.set(rec.key, set); }
          set.add(cn.idx);
        }
      }
    }
    records.delete(rec.key);
    const qi = buildQueue.indexOf(rec); if (qi >= 0) buildQueue.splice(qi, 1);
    if (rec.group) {
      for (const m of rec.checkedOut) { const pool = poolFor(m); if (pool) checkin(pool, m); }
      for (const g of rec.disposables) g.dispose();
      if (rec.group.parent) rec.group.parent.remove(rec.group);
    }
  }
  function poolFor(m) {
    for (const name in pools) if (pools[name].all.includes(m)) return pools[name];
    return null;
  }

  let streamerSeed = 20260703;
  function setSeed(s) { streamerSeed = s >>> 0; }

  // ---- active-set gather (3x3 around car) ---------------------------------
  function gather() {
    active.solids.length = 0; active.boxes.length = 0; active.walls.length = 0; active.postList.length = 0; active.cones.length = 0;
    const sx = shiftTotal.x, sz = shiftTotal.z;
    for (let dx = -CHUNK.simRing; dx <= CHUNK.simRing; dx++) {
      for (let dz = -CHUNK.simRing; dz <= CHUNK.simRing; dz++) {
        const rec = records.get(keyOf(carCX + dx, carCZ + dz));
        if (!rec || !rec.col) continue;
        const c = rec.col;
        for (const o of c.solids) active.solids.push({ x: o.x - sx, z: o.z - sz, r: o.r });
        for (const b of c.boxes) active.boxes.push({ x: b.x - sx, z: b.z - sz, hw: b.hw, hd: b.hd, cos: b.cos, sin: b.sin });
        for (const w of c.walls) active.walls.push({ x1: w.x1 - sx, z1: w.z1 - sz, x2: w.x2 - sx, z2: w.z2 - sz });
        for (const p of c.postList) { p.rx = p.x - sx; p.rz = p.z - sz; active.postList.push(p); }
        for (const cn of c.cones) { cn.x = (cn.ax ?? (cn.ax = cn.x)) - sx; cn.z = (cn.az ?? (cn.az = cn.z)) - sz; active.cones.push(cn); }
      }
    }
  }

  // ---- floating origin rebase --------------------------------------------
  function maybeRebase(carState) {
    if (Math.abs(carState.x) < CHUNK.rebaseAt && Math.abs(carState.z) < CHUNK.rebaseAt) return;
    const dx = Math.round(carState.x / CS) * CS, dz = Math.round(carState.z / CS) * CS;
    shiftTotal.x += dx; shiftTotal.z += dz;
    // move every live group so render = absolute - shiftTotal
    home.group.position.set(-shiftTotal.x, 0, -shiftTotal.z);
    for (const rec of records.values()) if (rec.group) rec.group.position.set(rec.cx * CS - shiftTotal.x, 0, rec.cz * CS - shiftTotal.z);
    rebaseCb(dx, dz); // main shifts car/camera/effects/dust by -dx,-dz
    assignCircuitLights(carState.x, carState.z); // keep circuit lights in the new render frame
    carCX = 1e9; // force re-gather
  }

  // ---- per-frame tick -----------------------------------------------------
  let visRing = CHUNK.visualRing[quality] || 4;
  function setQuality(q) { visRing = CHUNK.visualRing[q] || 4; }

  function update(carState, dt) {
    maybeRebase(carState);
    // car chunk in ABSOLUTE coords
    const acx = Math.floor((carState.x + shiftTotal.x) / CS), acz = Math.floor((carState.z + shiftTotal.z) / CS);
    const crossed = acx !== carCX || acz !== carCZ;
    carCX = acx; carCZ = acz;

    if (crossed) {
      for (let dx = -visRing; dx <= visRing; dx++) for (let dz = -visRing; dz <= visRing; dz++)
        if (!records.has(keyOf(acx + dx, acz + dz))) loadChunk(acx + dx, acz + dz);
      // unload beyond visRing+1 (hysteresis); home stays resident
      for (const rec of [...records.values()]) {
        if (rec.home) continue;
        if (Math.abs(rec.cx - acx) > visRing + 1 || Math.abs(rec.cz - acz) > visRing + 1) unloadChunk(rec);
      }
      // sim-ring proc chunks MUST have colliders NOW — build them synchronously
      buildSimRing(acx, acz);
      buildQueue.sort((a, b) => (Math.abs(a.cx - acx) + Math.abs(a.cz - acz)) - (Math.abs(b.cx - acx) + Math.abs(b.cz - acz)));
      gather();
    }

    // time-sliced mesh realization: nearest first, one activation per frame
    if (buildQueue.length) {
      const rec = buildQueue.shift();
      if (records.has(rec.key)) {
        buildProc(rec);
        scene.add(rec.group);
        rec.state = 'LIVE';
        // a freshly-built chunk in the sim ring must join the active set immediately
        if (Math.abs(rec.cx - acx) <= CHUNK.simRing && Math.abs(rec.cz - acz) <= CHUNK.simRing) gather();
      }
    }

    // reassign circuit lights to the nearest active circuits (throttled — circuits
    // are sparse and this scans all records)
    lightAcc += dt;
    if (lightAcc >= 0.35) { lightAcc = 0; assignCircuitLights(carState.x, carState.z); }
  }

  // synchronously build the sim-ring proc chunks around (acx,acz) — colliders exist
  // before the car can reach them (closes the tunneling hazard)
  function buildSimRing(acx, acz) {
    for (let dx = -CHUNK.simRing; dx <= CHUNK.simRing; dx++)
      for (let dz = -CHUNK.simRing; dz <= CHUNK.simRing; dz++) {
        const rec = records.get(keyOf(acx + dx, acz + dz));
        if (rec && !rec.home && rec.state !== 'LIVE') {
          buildProc(rec); scene.add(rec.group); rec.state = 'LIVE';
          const qi = buildQueue.indexOf(rec); if (qi >= 0) buildQueue.splice(qi, 1);
        }
      }
  }
  // prime the world around a spawn point so collision + visuals exist on frame 1
  function primeAround(x, z) {
    const acx = Math.floor((x + shiftTotal.x) / CS), acz = Math.floor((z + shiftTotal.z) / CS);
    carCX = acx; carCZ = acz;
    for (let dx = -visRing; dx <= visRing; dx++) for (let dz = -visRing; dz <= visRing; dz++) loadChunk(acx + dx, acz + dz);
    buildSimRing(acx, acz);
    gather();
  }

  return { active, update, setQuality, setSeed, primeAround, shiftTotal,
    setRebase(fn) { rebaseCb = fn; },
    setProcNight(on) { nightOn = !!on; lightAcc = 1e9; }, // force a reassign next tick
    get chunkCount() { return records.size; },
    get queueDepth() { return buildQueue.length; },
    procCircuitAt(x, z) { // render coords
      for (const rec of records.values()) if (rec.procCircuit) { const c = rec.procCircuit; if (Math.hypot((c.x - shiftTotal.x) - x, (c.z - shiftTotal.z) - z) < c.r) return true; } return false;
    },
    procTownAt(x, z, r = 90) { // render coords
      for (const rec of records.values()) if (rec.procTown) { const t = rec.procTown; if (Math.hypot((t.x - shiftTotal.x) - x, (t.z - shiftTotal.z) - z) < r) return true; } return false;
    },
    // nearest procedural road sample around a render-coord point → {x,z,heading} in
    // render coords (or null). Re-describes the 5x5 cells around the point; used for
    // far-from-home respawn, so cost on a rare reset is fine.
    nearestRoad(x, z) {
      const ax = x + shiftTotal.x, az = z + shiftTotal.z;
      const ccx = Math.floor(ax / CS), ccz = Math.floor(az / CS);
      let best = null;
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        const desc = describeChunk(streamerSeed, ccx + dx, ccz + dz);
        for (const e of desc.roads) {
          const s = e.samples; if (!s || s.length < 2) continue;
          for (let i = 0; i < s.length; i++) {
            const d2 = (s[i].x - ax) ** 2 + (s[i].z - az) ** 2;
            if (!best || d2 < best.d2) {
              const a = s[Math.max(0, i - 1)], b = s[Math.min(s.length - 1, i + 1)];
              best = { d2, x: s[i].x, z: s[i].z, tx: b.x - a.x, tz: b.z - a.z };
            }
          }
        }
      }
      if (!best) return null;
      return { x: best.x - shiftTotal.x, z: best.z - shiftTotal.z, heading: Math.atan2(-best.tx, -best.tz) };
    },
  };
}
