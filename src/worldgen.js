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
// the landmark for an LM cell → { kind, cx, cz } (host chunk) or null
function landmarkForCell(seed, lx, lz) {
  if (hash01(seed, lx, lz, SALT.LANDMARK) > 0.55) return null; // no landmark in this cell
  const r = cellRng(seed, lx, lz, SALT.LANDMARK + 1);
  const hostCx = lx * LM_CELL + Math.floor(r() * LM_CELL);
  const hostCz = lz * LM_CELL + Math.floor(r() * LM_CELL);
  if (homeReserved(hostCx, hostCz)) return null; // never in the home region
  const kindRoll = hash01(seed, lx, lz, SALT.LANDMARK_KIND);
  let kind;
  if (kindRoll < 0.25) kind = 'circuit';
  else if (kindRoll < 0.46) kind = 'town';
  else if (kindRoll < 0.60) kind = 'slalom';
  else if (kindRoll < 0.71) kind = 'skidpad';
  else if (kindRoll < 0.79) kind = 'park';       // drift gymkhana
  else if (kindRoll < 0.86) kind = 'gate';       // neon arch over a road
  else kind = 'lookout';                          // tall beacon tower — 0.14, common so they're findable
  return { kind, cx: hostCx, cz: hostCz };
}
export function landmarkFor(seed, cx, cz) {
  const lm = landmarkForCell(seed, Math.floor(cx / LM_CELL), Math.floor(cz / LM_CELL));
  return (lm && lm.cx === cx && lm.cz === cz) ? { kind: lm.kind, cx, cz } : null;
}

// Surface landmarks near a chunk whose footprint roads must NOT cross (circuit walls,
// park, skidpad, lookout base). Scans the 3x3 LM cells around the chunk. Returns
// {x, z, r} circles in ABSOLUTE coords. Towns/slaloms/gates are fine to have roads.
function surfaceFootprints(seed, cx, cz) {
  const out = [];
  const lcx = Math.floor(cx / LM_CELL), lcz = Math.floor(cz / LM_CELL);
  for (let dlx = -1; dlx <= 1; dlx++) for (let dlz = -1; dlz <= 1; dlz++) {
    const lm = landmarkForCell(seed, lcx + dlx, lcz + dlz);
    if (!lm) continue;
    const mx = lm.cx * CS + CS / 2, mz = lm.cz * CS + CS / 2;
    if (lm.kind === 'circuit') { const cp = circuitPath(lm.cx, lm.cz); out.push({ x: cp.center.x, z: cp.center.z, r: cp.r + 6 }); }
    else if (lm.kind === 'park') out.push({ x: mx, z: mz, r: 58 });
    else if (lm.kind === 'skidpad') out.push({ x: mx, z: mz, r: 52 });
    else if (lm.kind === 'lookout') out.push({ x: mx, z: mz, r: 24 });
  }
  return out;
}
const inAnyFootprint = (x, z, fps) => { for (const f of fps) { const dx = x - f.x, dz = z - f.z; if (dx * dx + dz * dz < f.r * f.r) return true; } return false; };
// split each road edge's samples into runs that stay OUTSIDE all footprints (so a road
// approaches a landmark and stops at its edge instead of cutting through it)
function clipEdges(edges, fps) {
  const out = [];
  for (const e of edges) {
    let run = [];
    const flush = () => { if (run.length >= 2) out.push({ a: run[0], b: run[run.length - 1], samples: run, width: e.width, id: e.id }); run = []; };
    for (const p of e.samples) { if (inAnyFootprint(p.x, p.z, fps)) flush(); else run.push(p); }
    flush();
  }
  return out;
}

// Deterministic drift-circuit centreline for a landmark chunk — a closed polyline in
// ABSOLUTE coords. Depends only on (cx,cz), so chunks.js (geometry) and trials.js (ring
// placement) can regenerate the SAME path independently with no stored data.
// Every wild circuit gets a DISTINCT layout: size, lobe count/depth, ellipse stretch
// and rotation all hashed from its cell, so no two look alike. Pure function of (cx,cz)
// (no session seed needed for the shape — the LOCATION already depends on the seed), so
// chunks.js (geometry) and trials.js (ring placement) regenerate the same path.
export function circuitPath(cx, cz) {
  const cxC = cx * CS + CS / 2, czC = cz * CS + CS / 2;
  const h = (salt) => hash01(0xC1BC, cx, cz, salt); // per-location layout hashes
  const baseR = 44 + h(1) * 22;            // 44–66 m
  const lobes = 2 + Math.floor(h(2) * 4);  // 2–5 lobes
  const amp = 0.10 + h(3) * 0.20;          // 0.10–0.30 lobe depth
  const elong = 0.85 + h(4) * 0.27;        // 0.85–1.12 ellipse stretch
  const rot = h(5) * Math.PI * 2, phase = h(6) * Math.PI * 2;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const N = 28, pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const rr = baseR * (1 - amp + amp * Math.sin(lobes * a + phase));
    const x = Math.cos(a) * rr * elong, z = Math.sin(a) * rr;
    pts.push({ x: cxC + x * cr - z * sr, z: czC + x * sr + z * cr });
  }
  const maxExtent = baseR * (1 + amp) * Math.max(elong, 1);
  return { center: { x: cxC, z: czC }, r: maxExtent + 22, points: pts };
}

// Nearest landmarks to an ABSOLUTE point, scanning LM cells outward (bounded). Pure +
// cheap (a couple of hashes per cell) — safe to call a few times a second for the HUD
// compass. Returns up to k {kind, x, z, cx, cz} sorted by distance.
export function nearestLandmarks(seed, cx, cz, k = 3, cellRadius = 3) {
  const lcx = Math.floor(cx / LM_CELL), lcz = Math.floor(cz / LM_CELL);
  const px = cx * CS + CS / 2, pz = cz * CS + CS / 2; // approx car position (chunk centre)
  const found = [];
  for (let dlx = -cellRadius; dlx <= cellRadius; dlx++) {
    for (let dlz = -cellRadius; dlz <= cellRadius; dlz++) {
      const lx = lcx + dlx, lz = lcz + dlz;
      if (hash01(seed, lx, lz, SALT.LANDMARK) > 0.55) continue;
      const r = cellRng(seed, lx, lz, SALT.LANDMARK + 1);
      const hostCx = lx * LM_CELL + Math.floor(r() * LM_CELL);
      const hostCz = lz * LM_CELL + Math.floor(r() * LM_CELL);
      if (homeReserved(hostCx, hostCz)) continue;
      const lm = landmarkFor(seed, hostCx, hostCz);
      if (!lm) continue;
      const x = hostCx * CS + CS / 2, z = hostCz * CS + CS / 2;
      found.push({ kind: lm.kind, x, z, cx: hostCx, cz: hostCz, d: Math.hypot(x - px, z - pz) });
    }
  }
  found.sort((a, b) => a.d - b.d);
  return found.slice(0, k);
}

// Deterministic name for the ~2 km region (super-cell) containing a chunk. Adjective +
// biome-keyed noun, e.g. "Vermillion Flats", "Cobalt Woods". Home region is special.
const REGION_CELL = 8; // 8 chunks ≈ 2 km
const REGION_ADJ = ['Vermillion', 'Cobalt', 'Ashen', 'Amber', 'Crimson', 'Onyx', 'Ivory',
  'Jade', 'Dusty', 'Silent', 'Golden', 'Violet', 'Rust', 'Pale', 'Neon', 'Hollow',
  'Frost', 'Ember', 'Slate', 'Copper', 'Wild', 'Lonesome', 'Static', 'Marigold',
  'Obsidian', 'Scarlet', 'Azure', 'Dusk', 'Iron', 'Velvet', 'Smoke', 'Cinder',
  'Crystal', 'Midnight', 'Sable', 'Umber', 'Glass', 'Feral', 'Quiet', 'Broken',
  'Sunken', 'Distant', 'Faded', 'Electric', 'Verdant', 'Twilight', 'Windward', 'Halcyon',
  'Drifter\'s', 'Chrome', 'Magenta', 'Indigo', 'Sepia', 'Hazel', 'Molten', 'Whisper'];
// several nouns per biome, picked by a second hash → hundreds of distinct names
const BIOME_NOUN = {
  plain: ['Flats', 'Plains', 'Basin', 'Expanse', 'Reach', 'Steppe'],
  meadow: ['Fields', 'Meadows', 'Green', 'Downs', 'Vale', 'Hollow'],
  forest: ['Woods', 'Forest', 'Pines', 'Thicket', 'Grove', 'Timberland'],
  rock: ['Ridge', 'Bluffs', 'Crags', 'Badlands', 'Mesa', 'Quarry'],
};
export function regionKey(cx, cz) { return Math.floor(cx / REGION_CELL) + ',' + Math.floor(cz / REGION_CELL); }
export function regionName(seed, cx, cz) {
  const rx = Math.floor(cx / REGION_CELL), rz = Math.floor(cz / REGION_CELL);
  const cxC = (rx * REGION_CELL + REGION_CELL / 2) * CS, czC = (rz * REGION_CELL + REGION_CELL / 2) * CS;
  // any region cell that overlaps the home reservation reads as home
  const rxMin = rx * REGION_CELL, rxMax = rxMin + REGION_CELL - 1;
  const rzMin = rz * REGION_CELL, rzMax = rzMin + REGION_CELL - 1;
  if (rxMin <= CHUNK.homeMax.cx && rxMax >= CHUNK.homeMin.cx && rzMin <= CHUNK.homeMax.cz && rzMax >= CHUNK.homeMin.cz) return 'Home Turf';
  const adj = REGION_ADJ[Math.floor(hash01(seed, rx, rz, SALT.REGION) * REGION_ADJ.length)];
  const nouns = BIOME_NOUN[biomeAt(seed, cxC, czC)] || BIOME_NOUN.plain;
  const noun = nouns[Math.floor(hash01(seed, rx, rz, SALT.REGION + 1) * nouns.length)];
  return adj + ' ' + noun;
}

// ---- the full chunk description -------------------------------------------
// All coords ABSOLUTE. treeScale/rot etc. are per-instance. Rejection uses the
// road network + any landmark footprint in the chunk.
export function describeChunk(seed, cx, cz) {
  const home = homeReserved(cx, cz);
  let roads = home ? [] : ownedEdges(seed, cx, cz);
  const landmark = home ? null : landmarkFor(seed, cx, cz);
  // clip roads out of nearby circuit/park/skidpad/lookout footprints so they don't run
  // through those landmarks (a circuit has its own track + walls inside it)
  let junctions = roads._nodes || [];
  if (!home && roads.length) {
    const fps = surfaceFootprints(seed, cx, cz);
    if (fps.length) { roads = clipEdges(roads, fps); junctions = junctions.filter((n) => !inAnyFootprint(n.x, n.z, fps)); }
  }
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

  return { cx, cz, home, biome, roads, junctions, landmark, scenery, ox, oz };
}
