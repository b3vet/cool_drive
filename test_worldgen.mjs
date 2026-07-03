// Headless worldgen determinism check — no browser, no three.js.
// The endless world's within-session correctness rests on describeChunk being a
// PURE function of (seed, cx, cz): an unloaded chunk MUST regenerate byte-identically
// on return, regardless of when or in what order it is visited. This asserts that.
import { describeChunk } from './src/worldgen.js';

// FNV-1a over a string → stable 32-bit hex hash.
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Hash a 5x5 block of chunk descriptors. Each cell is hashed with its coord, then the
// per-cell hashes are SORTED before combining — so the block hash depends only on the
// content of each cell, never on the order the cells were described in.
function blockHash(seed, ox, oz, order = 'raster') {
  const cells = [];
  for (let cx = ox; cx < ox + 5; cx++) for (let cz = oz; cz < oz + 5; cz++) cells.push([cx, cz]);
  if (order === 'reverse') cells.reverse();
  else if (order === 'shuffle') { // deterministic non-trivial permutation
    for (let i = cells.length - 1; i > 0; i--) { const j = (i * 7 + 3) % (i + 1); const t = cells[i]; cells[i] = cells[j]; cells[j] = t; }
  }
  const parts = cells.map(([cx, cz]) => `${cx},${cz}:` + hashStr(JSON.stringify(describeChunk(seed, cx, cz))));
  parts.sort();
  return hashStr(parts.join('|'));
}

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}

const SEED = 20260703;

console.log('=== worldgen determinism (pure describeChunk) ===');

// 1) Determinism: two independent passes over the same block are identical.
const a = blockHash(SEED, -2, -2);
const b = blockHash(SEED, -2, -2);
check('same seed + same cells → identical', a === b, `${a} vs ${b}`);

// 2) Visit-order independence: raster vs reverse vs shuffled describe order.
const rev = blockHash(SEED, -2, -2, 'reverse');
const shf = blockHash(SEED, -2, -2, 'shuffle');
check('describe order does not affect content', a === rev && a === shf, `${a} / ${rev} / ${shf}`);

// 3) Far-from-origin block is equally deterministic (no coord/precision drift).
const farA = blockHash(SEED, 10000, -8000);
const farB = blockHash(SEED, 10000, -8000, 'shuffle');
check('far block deterministic + order-independent', farA === farB, `${farA} vs ${farB}`);

// 4) Seed sensitivity: a different seed yields a different world (not all-constant).
const other = blockHash(SEED + 1, -2, -2);
check('different seed → different world', a !== other, `${a} vs ${other}`);

// 5) Single-cell revisit determinism (simulates unload → reload of one chunk).
const c1 = JSON.stringify(describeChunk(SEED, 37, -19));
const c2 = JSON.stringify(describeChunk(SEED, 37, -19));
check('single chunk regenerates identically', c1 === c2);

// 6) Sanity: the generator is not degenerate — over a wide far-from-home region
// there are roads and biome variety (the biome noise wavelength is ~6 chunks, so a
// tiny block can legitimately be single-biome; sample broadly).
let roadCells = 0; const biomes = new Set();
for (let cx = 20; cx < 40; cx++) for (let cz = -40; cz < -20; cz++) {
  const d = describeChunk(SEED, cx, cz);
  if (d.roads && d.roads.length) roadCells++;
  if (d.biome) biomes.add(d.biome);
}
check('wide region has roads + biome variety', roadCells > 0 && biomes.size > 1, `roadCells=${roadCells} biomes=${[...biomes].join(',')}`);

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL PASSED'}`);
process.exit(failures ? 1 : 0);
