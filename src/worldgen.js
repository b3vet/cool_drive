// ============================================================================
// worldgen.js — PURE procedural describers for the endless world. No three.js.
// Given (seed, chunk) it returns placement lists in ABSOLUTE world coords; the
// streamer (chunks.js) turns those into pooled three.js meshes. Roads are a
// 512 m super-grid whose edges roll "drift archetypes" sized to the car's grip.
// ============================================================================

import { hash01, cellRng, valueNoise, SALT } from './rand.js';
import { CHUNK } from './config.js';

const CS = CHUNK.size;           // 256
const NODE = 512;                // super-grid node spacing (2 chunks)
const ROAD_W = 18;               // procedural road width (matches WORLD.roadWidth)
const P_SKIP = 0.16;             // chance an edge is absent
const STEP = 4;                  // centreline sample spacing (m), consistent => seamless

const homeReserved = (cx, cz) =>
  cx >= CHUNK.homeMin.cx && cx <= CHUNK.homeMax.cx &&
  cz >= CHUNK.homeMin.cz && cz <= CHUNK.homeMax.cz;

// pure Catmull-Rom through control points -> polyline sampled ~STEP apart
function catmull(pts) {
  if (pts.length < 2) return pts.slice();
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const n = Math.max(2, Math.round(segLen / STEP));
    for (let s = 0; s < n; s++) {
      const t = s / n;
      out.push({ x: cr(p0.x, p1.x, p2.x, p3.x, t), z: cr(p0.z, p1.z, p2.z, p3.z, t) });
    }
  }
  out.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].z });
  return out;
}

// super-grid node world position (cell centre + jitter)
export function nodePos(seed, sx, sz) {
  const jx = (hash01(seed, sx, sz, SALT.NODE_JITTER) - 0.5) * 0.7 * NODE;
  const jz = (hash01(seed, sz, sx, SALT.NODE_JITTER + 1) - 0.5) * 0.7 * NODE;
  return { x: (sx + 0.5) * NODE + jx, z: (sz + 0.5) * NODE + jz };
}
const nodeChunk = (p) => ({ cx: Math.floor(p.x / CS), cz: Math.floor(p.z / CS) });

// does node (sx,sz) own an edge in direction dir (0=East to sx+1, 1=South to sz+1)?
function edgeExists(seed, sx, sz, dir) {
  // suppress edges that would run through the reserved home region (home has roads)
  const a = { sx, sz }, b = dir === 0 ? { sx: sx + 1, sz } : { sx, sz: sz + 1 };
  const pa = nodePos(seed, a.sx, a.sz), pb = nodePos(seed, b.sx, b.sz);
  const ca = nodeChunk(pa), cb = nodeChunk(pb);
  if (homeReserved(ca.cx, ca.cz) && homeReserved(cb.cx, cb.cz)) return false;
  return hash01(seed, sx, sz, dir === 0 ? SALT.EDGE_E : SALT.EDGE_S) > P_SKIP;
}

// build one edge's centreline (control points -> sampled polyline) + meta
function buildEdge(seed, sx, sz, dir) {
  const A = nodePos(seed, sx, sz);
  const B = dir === 0 ? nodePos(seed, sx + 1, sz) : nodePos(seed, sx, sz + 1);
  const rng = cellRng(seed, sx * 2 + dir, sz, SALT.EDGE_SHAPE);
  const dx = B.x - A.x, dz = B.z - A.z, len = Math.hypot(dx, dz) || 1;
  const px = -dz / len, pz = dx / len; // perpendicular
  const roll = rng();
  let ctrl;
  if (roll < 0.10) {
    ctrl = [A, B]; // straight (10%)
  } else if (roll < 0.50) {
    // sweeper (40%): single mid offset -> radius ~90-170m for a 512m chord
    const off = (rng() < 0.5 ? -1 : 1) * (55 + rng() * 75);
    const m = { x: A.x + dx * 0.5 + px * off, z: A.z + dz * 0.5 + pz * off };
    ctrl = [A, m, B];
  } else if (roll < 0.80) {
    // esses (30%): opposite offsets
    const o = 30 + rng() * 45;
    const s = rng() < 0.5 ? 1 : -1;
    const m1 = { x: A.x + dx * 0.33 + px * o * s, z: A.z + dz * 0.33 + pz * o * s };
    const m2 = { x: A.x + dx * 0.67 - px * o * s, z: A.z + dz * 0.67 - pz * o * s };
    ctrl = [A, m1, m2, B];
  } else {
    // tight kink pair (20%): sharp in-out -> hairpin-ish corners + a straight
    const o = 24 + rng() * 18;
    const s = rng() < 0.5 ? 1 : -1;
    const m1 = { x: A.x + dx * 0.42 + px * o * s, z: A.z + dz * 0.42 + pz * o * s };
    const m2 = { x: A.x + dx * 0.58 + px * o * s * 1.1, z: A.z + dz * 0.58 + pz * o * s * 1.1 };
    ctrl = [A, m1, m2, B];
  }
  return { a: A, b: B, samples: catmull(ctrl), width: ROAD_W, id: `${sx},${sz},${dir}` };
}

// all edges OWNED by nodes whose owning-chunk == (cx,cz) — each edge built once
export function ownedEdges(seed, cx, cz) {
  const out = [];
  // a chunk (256m) holds at most ~1 node (nodes 512m apart); scan the small window
  const sx0 = Math.floor((cx * CS) / NODE) - 1, sz0 = Math.floor((cz * CS) / NODE) - 1;
  for (let sx = sx0; sx <= sx0 + 2; sx++) {
    for (let sz = sz0; sz <= sz0 + 2; sz++) {
      const p = nodePos(seed, sx, sz);
      const c = nodeChunk(p);
      if (c.cx !== cx || c.cz !== cz) continue;
      const node = { x: p.x, z: p.z, junction: false, degree: 0 };
      for (const dir of [0, 1]) if (edgeExists(seed, sx, sz, dir)) { out.push(buildEdge(seed, sx, sz, dir)); node.degree++; }
      // incoming edges (from W neighbour E-edge, from N neighbour S-edge) count for junction rendering
      if (edgeExists(seed, sx - 1, sz, 0)) node.degree++;
      if (edgeExists(seed, sx, sz - 1, 1)) node.degree++;
      if (node.degree >= 2) { node.junction = true; out._nodes = out._nodes || []; out._nodes.push(node); }
    }
  }
  return out;
}

// edges near a chunk (for scenery rejection) — owned edges of nodes in nearby chunks
function edgesNear(seed, cx, cz) {
  const edges = [];
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    for (const e of ownedEdges(seed, cx + dx, cz + dz)) edges.push(e);
  }
  return edges;
}

function distToEdges(x, z, edges) {
  let best = Infinity;
  for (const e of edges) {
    const s = e.samples;
    for (let i = 0; i < s.length; i++) {
      const d = (s[i].x - x) ** 2 + (s[i].z - z) ** 2;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

// biome from low-frequency value noise (wavelength ~1600m)
export function biomeAt(seed, x, z) {
  const n = valueNoise(seed, x / 1600, z / 1600, SALT.BIOME);
  const n2 = valueNoise(seed, x / 900 + 40, z / 900 - 40, SALT.BIOME + 7);
  if (n < 0.42) return 'plain';        // ~open drift fields
  if (n < 0.60) return n2 < 0.5 ? 'meadow' : 'plain';
  if (n < 0.78) return 'forest';
  return 'rock';
}

// landmark grid: one candidate per LM_CELL (5 chunks); exists ~55% of cells
const LM_CELL = 5;
export function landmarkFor(seed, cx, cz) {
  const lx = Math.floor(cx / LM_CELL), lz = Math.floor(cz / LM_CELL);
  if (hash01(seed, lx, lz, SALT.LANDMARK) > 0.55) return null; // no landmark in this cell
  // pick the chunk within the cell that hosts it
  const r = cellRng(seed, lx, lz, SALT.LANDMARK + 1);
  const ox = Math.floor(r() * LM_CELL), oz = Math.floor(r() * LM_CELL);
  const hostCx = lx * LM_CELL + ox, hostCz = lz * LM_CELL + oz;
  if (hostCx !== cx || hostCz !== cz) return null;
  if (homeReserved(cx, cz)) return null; // never in the home region
  const kindRoll = hash01(seed, lx, lz, SALT.LANDMARK_KIND);
  let kind;
  if (kindRoll < 0.35) kind = 'circuit';
  else if (kindRoll < 0.65) kind = 'town';
  else if (kindRoll < 0.85) kind = 'slalom';
  else kind = 'skidpad';
  return { kind, cx, cz };
}

// ---- the full chunk description -------------------------------------------
// All coords ABSOLUTE. treeScale/rot etc. are per-instance. Rejection uses the
// road network + any landmark footprint in the chunk.
export function describeChunk(seed, cx, cz) {
  const home = homeReserved(cx, cz);
  const roads = home ? [] : ownedEdges(seed, cx, cz);
  const landmark = home ? null : landmarkFor(seed, cx, cz);
  const ox = cx * CS, oz = cz * CS; // chunk absolute origin (min corner)
  const cxC = ox + CS / 2, czC = oz + CS / 2;
  const biome = biomeAt(seed, cxC, czC);

  const scenery = { trees: [], rocks: [], bushes: [] };
  if (!home) {
    const nearRoads = edgesNear(seed, cx, cz);
    const lmClear = landmark ? 120 : 0; // keep scenery out of a landmark footprint
    const rng = cellRng(seed, cx, cz, SALT.SCENERY);
    const roadClear = ROAD_W / 2 + 5;
    const place = (arr, count, spread, minR) => {
      // clustered: a few cluster centres per chunk, tight scatter
      const clusters = 1 + Math.floor(rng() * 3);
      for (let ci = 0; ci < clusters && arr.length < count; ci++) {
        const ccx = ox + rng() * CS, ccz = oz + rng() * CS;
        const per = 3 + Math.floor(rng() * 8);
        for (let k = 0; k < per && arr.length < count; k++) {
          const x = ccx + (rng() - 0.5) * spread, z = ccz + (rng() - 0.5) * spread;
          if (x < ox - 4 || x > ox + CS + 4 || z < oz - 4 || z > oz + CS + 4) continue;
          if (distToEdges(x, z, nearRoads) < roadClear) continue;
          if (landmark && Math.hypot(x - cxC, z - czC) < lmClear) continue;
          arr.push({ x, z, s: minR + rng() * (minR * 1.4), rot: rng() * Math.PI * 2 });
        }
      }
    };
    if (biome === 'forest') { place(scenery.trees, CHUNK.perChunkCaps.trees, 34, 0.8); place(scenery.bushes, 30, 30, 0.6); }
    else if (biome === 'rock') { place(scenery.rocks, CHUNK.perChunkCaps.rocks, 40, 0.7); place(scenery.bushes, 20, 30, 0.5); }
    else if (biome === 'meadow') { place(scenery.bushes, CHUNK.perChunkCaps.bushes, 40, 0.6); place(scenery.trees, 18, 40, 0.8); }
    // 'plain' -> intentionally sparse (open drift space); a rare lone tree
    if (biome === 'plain' && rng() < 0.4) place(scenery.trees, 6, 20, 0.9);
  }

  return { cx, cz, home, biome, roads, junctions: roads._nodes || [], landmark, scenery, ox, oz };
}
