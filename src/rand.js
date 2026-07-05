// ============================================================================
// rand.js — deterministic seeded hashing + PRNG for the endless world.
// Pure: NO three.js. Generation is a pure function of (seed, cell) so an unloaded
// chunk regenerates identically when the car returns. (Cross-device reproduction
// is a non-goal — see ENDLESS_WORLD_PLAN.md §15.)
// ============================================================================

// triple32 (Chris Wellons) — near-floor avalanche bias (~0.0209).
export function triple32(x) {
  x = x >>> 0;
  x ^= x >>> 17; x = Math.imul(x, 0xed5ad4bb);
  x ^= x >>> 11; x = Math.imul(x, 0xac4c1b51);
  x ^= x >>> 15; x = Math.imul(x, 0x31848bab);
  x ^= x >>> 14;
  return x >>> 0;
}

// mulberry32 — fast 32-bit PRNG, period 2^32. Returns a () => [0,1) generator.
export function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// uint32 hash of (seed, cx, cz) salted by feature type.
export function hashCell(seed, cx, cz, salt) {
  let h = triple32((seed ^ (salt | 0)) >>> 0);
  h = triple32((h ^ (cx | 0)) >>> 0);
  h = triple32((h ^ (cz | 0)) >>> 0);
  return h >>> 0;
}

// [0,1) hash of a cell/feature.
export function hash01(seed, cx, cz, salt) {
  return hashCell(seed, cx, cz, salt) / 4294967296;
}

// A dedicated PRNG stream for one (cell, feature) — draw as many values as needed.
export function cellRng(seed, cx, cz, salt) {
  return mulberry32(hashCell(seed, cx, cz, salt));
}

// Smoothstep value noise on an integer lattice. x,z in lattice units.
export function valueNoise(seed, x, z, salt) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const n = (ax, az) => hashCell(seed, ax, az, salt) / 4294967296;
  const n00 = n(xi, zi), n10 = n(xi + 1, zi), n01 = n(xi, zi + 1), n11 = n(xi + 1, zi + 1);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}

// salts (arbitrary distinct constants)
export const SALT = {
  NODE_JITTER: 0x1111,
  EDGE_E: 0x2222,
  EDGE_S: 0x3333,
  EDGE_SHAPE: 0x4444,
  BIOME: 0x5555,
  SCENERY: 0x6666,
  LANDMARK: 0x7777,
  LANDMARK_KIND: 0x8888,
  CLUSTER: 0x9999,
  TOWN: 0xaaaa,
  TOWN_BUILD: 0xabcd, // per-building town PRNG (was a raw literal in chunks.js)
  REGION: 0xbb01,     // region-name generator
  RING: 0xbb02,       // ring time-trial layout
};
