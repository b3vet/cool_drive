# Endless World — Implementation Plan

Seeded, tile/chunk-streamed, endless world for CoolDrive — optimized for low memory
and stable frame times on mobile (WKWebView / iOS Safari), while keeping the drift
feel, collisions, achievements, quality tiers, zero-build ES modules, and offline-first.

This is a **planning document**: no code changes ship with it. It was produced from a
full coupling audit of the current code, external research on three.js streaming and
mobile WebGL budgets, and three competing architecture proposals scored and merged
(see [Appendix B](#appendix-b--alternatives-considered)).

---

## 1. Goal & Pillars

- **Endless**: drive in any direction forever. No boundary wall.
- **Seeded per session**: a session seed fully determines the world. Same seed ⇒ same
  world, chunk-for-chunk, regardless of approach direction or load order.
- **Low memory / no hitches**: zero GPU-resource creation and zero disposal during
  gameplay (steady state). Preallocate at boot, recycle forever.
- **The road is the product**: generated roads must be *fun to drift* — sweepers,
  esses, hairpins sized to the car's actual grip physics — with guaranteed open
  fields, clustered scenery, and discoverable landmarks.
- **Keep what works**: the authored home region (city, walled drift circuit, skidpad,
  lake) survives as reserved chunks near the origin.

## 2. Measured Baseline (current finite world)

Measured in this repo (desktop Chromium preview, start-screen city view):

| Metric | Value | Implication |
|---|---|---|
| Full world build time | **41.8 ms** (desktop; est. 120–150 ms on phone) | one 256 m chunk ≈ 1/40 of content ⇒ ~1–3 ms on phone — time-sliced main-thread generation is viable |
| Draw calls | **174** (city view) | ~90 from the city alone (each building + window band = its own mesh). Buildings must become instanced |
| Triangles | 88 k | fine; not the bottleneck |
| GPU geometries / programs / textures | 139 / 16 / 3 | per-building geometry churn is the geometry driver |
| JS heap | 9.3 MB used | tiny — headroom is real but iOS kills tabs ~350–450 MB total |
| Collision workload | ~1,560 unculled distance tests × 120 Hz ≈ **187 k tests/s** (solids 1369 + boxes 47 + posts 128 + cones 14; walls 380 already radius-culled) | works today; chunk-bucketing gives ~4× fewer tests and O(1) scaling |
| Scene | 197 plain meshes, 7 InstancedMesh (3,573 instances), 5 PointLights | plain-mesh count is the draw-call problem |

Mobile budgets to design against (research consensus):
- **Draw calls**: ≤ 100–120 total on high tier, ≤ 80–90 on low. (Guidance: <100 for
  “most devices smooth”; <50 conservative low-end.)
- **Frame**: 16.7 ms at 60 fps; keep our main-thread total ≤ 10–12 ms for thermal
  headroom (the user has had overheating; the fps-cap quality tiers must survive).
- **Memory**: ≤ 150–200 MB JS heap, ≤ 300 MB total (heap+GPU). WebKit purges JIT at
  ~65 % of the per-device limit (iPhone 11/12-class limit ≈ 350–400 MB) and kills the
  page at 100 %.
- **GC**: JSC/Riptide pauses ≤ ~3 ms — but the goal is **0 allocations/frame** steady
  state so GC never matters.
- **GPU uploads**: large `bufferSubData` uploads reportedly pause up to ~100 ms on
  mobile — budget ≤ ~512 KB of attribute uploads per frame and stagger activations.
- **Float32 precision**: ulp = 0.24 mm at 2,048 m, 7.8 mm at 65 km. Skid quads are
  0.28–0.52 m wide (half-width 0.14–0.26), and `SKID.y` z-offset is 25 mm ⇒ artifacts
  far before 65 km. Rebase the origin long before this (we choose 2,048 m).

## 3. Hard Constraints From the Current Code

The coupling audit (every consumer, with line refs) found:

1. **`buildWorld()` returns a 21-property facade** consumed at ~11 sites in
   `src/main.js` (collision arrays, `onDriftTrack`, `townCenter`, `updateBoundary`,
   `updateAtmosphere`, materials, debug handle). `updatePosts`, `updateCones`, and
   `applyWorldPreset` are module-level exports that *take* `world` as a parameter —
   their contracts must survive too. The refactor keeps the facade shape and
   **object identity** so `main.js` changes stay minimal (~6 sites).
2. **`resolveCollisions(carState, world)`** runs inside the 120 Hz fixed loop and
   mutates carState in place; returns `{crash, cones, posts}`. Its *math* is proven —
   keep it verbatim; only swap the arrays it iterates.
3. **`postList[k].i` is an InstancedMesh slot index** (knock-over animation writes
   `setMatrixAt(p.i, …)`). Any pooling scheme must keep these indices chunk-local.
4. **Preset tinting**: `applyWorldPreset` re-tints 5 shared neon materials + track
   lights. Shared material singletons must be hoisted to module scope so streamed
   chunks inherit tinting for free.
5. **Origin-anchored scene objects** break at known distances: ground plane half-extent
   2,600 m, sky dome 4,784 m, stars 4,420 m, sun disc 3,744 m, `camera.far` 5,200.
   All must become camera/car followers.
6. **Float32 absolute-coordinate buffers** that a rebase must shift: skid ring buffers
   (2 × 700 segments) **and their `prev` pen state**, smoke pool, dust motes, every
   InstancedMesh matrix, camera `position` + `smoothedLook` closure state, physics
   `prev/curr` interpolation snapshots.
7. **Zero-build & offline**: new modules must be plain ES modules, added to `sw.js`
   CORE (+ cache version bump) in the same commit; `build-www.mjs`/Dockerfile copy
   `src/` wholesale (no change needed there).
8. **Gameplay position coupling** is exactly 4 places: SPAWN (40,−30), `town`
   achievement (< 70 m of `townCenter`), Track Rat (`onDriftTrack`), boundary
   (deleted by this feature).

## 4. Architecture Overview

```
src/rand.js      seeded hashing + PRNG streams (pure, no three.js)
src/worldgen.js  pure describers: (seed, cx, cz) -> typed arrays / placement lists
src/roadnet.js   super-grid road network: nodes, edges, archetypes, junction pads
src/chunks.js    streamer: rings, chunk records, pools, build queue, rebase
src/world.js     facade (same 21-property API) + authored home region + shared builders
```

- **Chunk** = 256 m × 256 m, integer coords `(cx, cz)`, key packed as
  `((cx+0x8000)<<16) | (cz+0x8000)` into a `Map` (no string keys on hot paths).
- **SIM ring** (physics/collision): Chebyshev radius 1 (3×3) + a velocity-facing
  prefetch row at radius 2. Colliders for these chunks are built **synchronously**
  the moment the ring demands them (~0.2–0.5 ms of pure math, no GPU) — collision
  provably exists before the car can arrive (true top speed is 54 × 1.12 (Night
  Viper) × 1.28 (boost) ≈ **77.4 m/s** = 0.65 m per physics step, ~5.2 m per clamped
  render frame — always well inside the previously built 3×3). Cap synchronous
  collider builds at ≤ 2 per frame (spread across the prefetch row) so a corner
  crossing can't stack 5 builds into one frame and bust the hitch gate.
- **VISUAL ring**: radius 3 on low tier (7×7 = 49 chunk records), radius 4 on
  medium/high (9×9 = 81). Fog is the natural outer bound — content beyond it is
  invisible. **Note:** fog far is set by the *time-of-day preset* (night 700, golden
  820, dawn 860), not the quality tier — so the low tier pairs ring 3 (guaranteed
  coverage to ~768 m) with a fogFar clamp of ~720 on golden/dawn, or accepts minor
  pop-in in the 770–860 m band (decide in M2 by eye). Hysteresis: load at ≤ R,
  unload at > R+1 (no thrash at borders).
- **Chunk lifecycle**: `FREE → QUEUED → COLLIDERS → BUILT → LIVE`. Mesh realization is
  time-sliced (≤ 2.5 ms/frame; 1.5 ms on the 45 fps low tier), **one scene activation
  per frame**, ≤ 512 KB attribute upload per frame; the build queue is sorted by
  distance-ahead-of-velocity. **Edge realizations (§6.2) share the same upload
  budget** — a junction chunk demanding 3–4 edges (~147 KB each) staggers them across
  frames instead of uploading ~600 KB at once. `renderer.shadowMap.needsUpdate` is
  forced on any activation/removal/rebase frame (the shadow throttle otherwise
  caches stale maps).
- **Speed math**: at 77.4 m/s (fastest car, boosted) a 256 m chunk row is crossed in
  ≥ 3.3 s ≈ 200 frames — a whole row of chunks needs ~9 builds, so the 2.5 ms budget
  beats the deadline by >10×. (Full current world = 42 ms; a chunk is a small slice.)

## 5. Memory Model — Preallocate Once, Recycle Forever

**Decision:** zero GPU resource creation and zero `dispose()` during play — via
**per-chunk recycled meshes**, not global span-allocated pools. Rationale: per-chunk
meshes keep (a) per-chunk frustum culling (a global pool with `frustumCulled=false`
vertex-shades its FULL capacity every frame — a measured 85→55 fps regression pattern
on mobile-class GPUs), (b) `postList[k].i` chunk-local (no allocator to corrupt),
(c) the code debuggable in a repo with no test harness.

**Pool sizing must respect the hysteresis rule** (load ≤ R, unload > R+1): straight
cruise holds 9×10 = 90 live chunks, diagonals 10×10, corner-wander up to 11×11 = 121 —
plus the 36 never-unloaded home chunks. Therefore: **visual mesh checkouts are
released as soon as a chunk leaves ring R** (only records/colliders persist to R+1),
and pools are sized for the true worst case, not the nominal ring.

At boot, allocate:
- **~160 ChunkRecord objects** with SoA collider typed arrays (121 hysteresis worst
  case + 36 home + slack).
- **Road geometry pool**: 64 slots × 4,096 vertices; `position/normal/color`
  preallocated with `DynamicDrawUsage`; written in place with `setDrawRange`
  (the ring-buffer pattern proven by the skid marks in `effects.js`) plus
  `addUpdateRange` partial uploads (new usage — r160 supports it; verify on WKWebView
  in M3).
- **Per-species InstancedMesh pools** (~100 each — the ≤ R checkout worst case;
  instance matrices cost < 2 MB total: 296 capped instances/chunk × 64 B × 100),
  with per-chunk caps:
  trees **96** (trunk+canopy merged into ONE vertex-colored geometry — halves draws
  and matrices), rocks **48**, bushes **64**, buildings **24** (ONE instanced
  BoxGeometry + per-instance `instanceColor` — the pattern kerbs already use — killing
  today's ~45 materials/~90 meshes), posts **48**, cones **16**.
- Chunks **check meshes out** of the pool, write exact instance counts, and get a
  **manual boundingSphere** (chunk center, r ≈ 181 m + 30 m prop height) in the single
  chunk-activation function. Release = set count 0, return to pool. The old
  park-at-`y=−50` idiom is not carried over.
- Banner/sign `CanvasTexture`s are pre-baked at boot — **never** create textures in
  the streaming path.
- `renderer.compile()` warm-up at the start screen covers every material variant
  (including night/landmark) so no shader compiles mid-drive.

Steady-state allocation story: driving generates **no** new GPU buffers, no disposes,
no new JS objects on hot paths (physics snapshot pair and the collision-result object
are pooled too — both currently allocate 120×/s).

## 6. World Generation

### 6.1 Seeding & determinism (`src/rand.js`)
- **Scope (decided):** reproducibility beyond the running session is a NON-goal — no
  shareable seeds, no URL-hash persistence, no cross-device equality. What remains
  **load-bearing** is *within-session* determinism: an unloaded chunk must
  regenerate byte-identically when the car returns, or the world visibly mutates
  behind the player. Everything below serves only that.
- `sessionSeed` from `crypto.getRandomValues`, held in memory for the session (a
  page reload may produce a new world — accepted).
- Hash chain: `h = triple32(seed ^ SALT); h = triple32(h ^ (cx>>>0)); h = triple32(h ^ (cz>>>0))`
  → `mulberry32(h)` per (chunk, feature-type) stream. triple32 has near-floor
  avalanche bias (0.0209); mulberry32 period 2³² vs < 10³ draws per stream.
- Generation must be a pure function of (seed, cell) — never of load order or car
  path. Fixed build order: roads → junctions → clusters → props. Grep-lint: no
  `Math.random` in worldgen modules. (Integer-hash-only existence decisions stay as
  good practice, but the cross-engine float-drift rule is no longer a hard gate.)

### 6.2 Road network (`src/roadnet.js`) — the drift vocabulary
- **Super-grid nodes** every 512 m (2×2 chunks): position = cell center + jitter
  ±0.35 cell from `hash(seed, sx, sz, SALT_NODE)`. Symmetric E/S connection rule
  (each cell decides its east and south edges only — both neighbors compute the same
  answer), `p_skip = 0.15`, rare diagonals (~0.06) suppressed on crossings. No
  neighbor load-state dependency anywhere.
- **Edge archetypes** rolled from `hash(edgeId)`, all sized inside the car's
  grip-limited radius band `r = v²/17` (23 m @ 20 m/s … 171 m @ 54 m/s):
  - 40 % **sweeper** (radius 90–170 m)
  - 30 % **esses** (50–100 m)
  - 20 % **hairpin pair** (25–40 m bends + 80–120 m straight)
  - 10 % **straight**
- **Junction pads**: r = 1.5 × roadWidth = 27 m discs with kerb arcs on turn-in
  exteriors — junctions double as drift corners. Incident ribbons trimmed to the pad
  radius.
- **Ownership model (one model, stated precisely):** roads are realized **per edge**,
  not per chunk. An edge (chord up to ~940 m, spanning 4–6 chunks) is one geometry in
  **its own group anchored at the owner cell's origin** (vertices stay local ≤ ~1 km —
  same Float32 story as chunks); its lifecycle is keyed to the **edge registry**
  (refcounted by the chunks that can see it: realize on refCount 0→1, release on
  1→0), *never* parented to any single chunk — so a chunk unloading while the edge is
  still visible from another chunk cannot kill it. Road-slot groups are an explicit
  line in the floating-origin shift checklist (§9).
- **Deterministic tessellation**: sampling pinned at 3 m arc-length, quantized in
  absolute-grid units, so the same edge produces byte-identical vertices regardless
  of which chunk triggers realization — and junction-pad trim points solve
  identically on both sides.
- Pool exhaustion defers the farthest chunks' roads — never allocates.

### 6.3 Biomes & scenery
- Seeded value noise (integer-hash lattice + smoothstep), wavelength ~1,600 m,
  classified per feature cell:
  - **Open plain ~50 %** — the guaranteed drift-gap space,
  - meadow clusters with 60–120 m gaps (slalom gates),
  - forest with a 40 m carved road clearance,
  - rock fields.
- Scenery stays clustered (grove/field/patch placement like today), rejected near
  roads by distance-to-edge tests against the deterministic road set.

### 6.4 Landmarks (set pieces)
- 5×5 grid-maxima over super-cells (density 1/25, ≥ 1 km spacing, pure hashing, no
  neighbor state): 35 % **mini walled circuit** (reuses `buildTrackWall`, registers
  with `onDriftTrack`), 30 % **town** (compact variant of the building-grid
  generator, registers as a `townCenter` candidate), 20 % cone slalom, 15 % skidpad
  + banner.
- **Footprint rule:** a landmark must fit inside its owner chunk (≤ ~220 m diameter
  incl. collision margin) so its colliders live in one chunk record and the 3×3
  gather always sees them. That means mini circuits are genuinely *mini* (radius
  ≤ ~90 m — a fraction of the home circuit's ~300 m) and procedural towns are a 4×4
  grid (~180 m), not the home city's 9×9. Anything bigger must be split per-chunk
  deterministically — out of scope for v1. Per-chunk caps must absorb the set piece
  (slalom = 14 cones vs cap 16: no other cones in a slalom chunk).

### 6.5 Authored home region
- Reserved chunks `cx ∈ [−4..1], cz ∈ [−4..1]` (36 chunks = world [−1024, 512]²).
  Measured authored content occupies x ∈ [−806, 429], z ∈ [−769, 398] — the
  reservation **covers everything, but with thin margins** (east 83 m, north 115 m;
  nowhere a full chunk). Two consequences, both handled: (a) procedural cells
  **adjacent to the reservation** must include the authored road samples in their
  scenery-rejection set (static, precomputed once); (b) the legacy builder's
  tree/rock/bush scatter — which today spreads over the whole r≈1400 disc, with ~44 %
  of solids landing *outside* the reservation — is **clamped to the reservation
  rectangle**; procedural biomes own everything beyond. The perimeter hills (9 placed
  in the current build) are dropped from the authored path and become procedural
  biome content.
- Built once at boot by today's `buildWorld` path **minus** the boundary ring/glow
  wall and minus out-of-rect scatter. Never unloaded (its colliders are bucketed
  into the 36 chunk records at startup so the 3×3 collision gather is uniform).
- **Gateway nodes** (the connection rule treats reserved cells as containing exactly
  these): the road network has only **two real open ends** — the crossover road's
  endpoints at (−320, 170) and (330, −250) — which become two natural gateways
  extended outward. **Two to three additional authored stub roads are NEW M4 work**
  (explicitly budgeted), sited on the reservation edge away from the drift-track
  wall zone (the track's outer wall reaches x ≈ −806; nothing docks within its cull
  radius). Exact stub coordinates chosen during M4 against the verified geometry.
- SPAWN (40,−30) unchanged. `R` reset respawns to the nearest active road sample
  (with tangent heading) when > 3 km from home.
- Achievements (decided): **Track Rat and City Lights stay home-only** — no
  inflation. Procedural discoveries earn **new achievements** (e.g., drift a
  procedural mini-circuit, visit N procedural towns, drive X km from home), added in
  M5. `world.townCenter` stays pointed at the home town; `onDriftTrack` queries the
  home circuit; procedural circuits/towns feed the new stats via their own registry.

## 7. Collision

- Keep `resolveCollisions`' math and signature **verbatim except** the boundary
  branch, which is deleted. `world.solids/boxes/
  cones/postList` become **3×3 active-set arrays rebuilt in place** (preallocated,
  object identity preserved for the `window.__game.world` debug handle) at
  chunk-crossing rate — not per frame. `world.walls` becomes wall **groups**
  `[{cull:{x,z,r}, segs}]`, generalizing the existing `driftTrack.cull` pattern.
- Expected workload: ~270–450 tests/step vs ~1,560 today (≈ 4× win) — and O(1) in
  world size. A SoA Float32 rewrite of the hot loop is a documented v2 lever, only if
  profiling demands it.
- Delete the r = 1400 boundary branch, ring, and glow wall.
- Knocked-post/cone state persists per session in a `Map<chunkKey, bitset>` so
  revisited chunks remember what you flattened.

## 8. Rendering

- **Draw budget**: ≤ 100–120 total (high), ≤ 80–90 (low), asserted by a dev HUD
  reading `renderer.info` (calls, geometries, textures, programs). The math that
  closes this budget — stated as explicit assumptions, not hopes:
  1. **~50 % of chunks are empty plain and issue 0 draws** (the ground is one global
     follower plane; empty chunks have no meshes at all);
  2. **frustum culling** (per-chunk manual boundingSpheres) cuts the 81-chunk ring to
     ~40 in view;
  3. non-empty chunks cost **2–6 draws** (merged road ribbon + edge lines,
     shared-material instanced species).
  Expected view: ~40 in-frustum × ~50 % empty × ~3 draws ≈ 60 + ~15 globals
  (car ~10, skids 2, smoke, sky, ground, sun) ≈ **75** ✓. Worst case (forest/junction
  band + the home city in view) breaks the budget **unless the home city is
  instanced** — therefore instancing the authored city (one BoxGeometry +
  instanceColor, ~90 meshes → ~2 draws) is **pulled into M3**, not left as an open
  question. The M3/M4 dev HUD asserts the budget on-device.
- **Ground**: existing solid-color plane becomes a camera follower snapped to 256 m
  multiples (shares `ctx.groundMat`; preset recolor untouched). Sky dome, stars, and
  sun disc pinned to camera XZ inside the existing `trackSun`/`updateAtmosphere`
  hooks. `camera.far` = fogFar × 1.05 per preset (735–905) so fog is backed by real
  clipping.
- **Shadows**: keep the ±150 m ortho follower + `shadowEvery` throttle; OR-in a
  `streamerShadowDirty` flag; snap the light camera to shadow-texel increments
  (kills crawling); `castShadow` only in the 3×3 ring; consider PCF instead of
  PCFSoft on medium/low (filter cost scales with pixelRatio²).
- **Track lights**: `setTrackLights` becomes a registry with a hard cap of **5**
  shadowless PointLights world-wide (nearest circuits win; excess degrades to
  emissive-only).
- **Quality tiers** map to streaming: visual ring 3/4/4, build budget 1.5/2.5/2.5 ms,
  per-chunk caps can scale down on low.

## 9. Floating Origin

- **Rebase at |x| or |z| > 2,048 m**, shifting by the exact multiple of 256 m, executed
  atomically **between** physics and render. At top speed that's once per ≥ ~26 s and
  costs ~0.2 ms.
- One audited `rebase(dx, dz)` function with an explicit checklist:
  carState.x/z, `prev`/`curr` interpolation snapshots, `render` interp state,
  `cam.shift(dx,dz)` hook (camera position + `smoothedLook` closure — **never**
  `cam.reset()`), `effects.shift(dx,dz)` (both skid ring buffers **and**
  `SkidTrail.prev` pens + smoke pool), dust motes, sun/shadow anchors, all chunk
  `group.position`s, **road-slot groups** (per-edge geometry anchors, §6.2),
  active-set collider coordinates, **and every gameplay-query registry**:
  `townCenter` candidates, `driftTrack.center` + centreline samples used by
  `onDriftTrack`, the procedural-circuit registry, and all wall-group `cull`
  centers — miss one and Track Rat / City Lights silently stop crediting after the
  first rebase.
- **Vertex data is chunk-local** (each chunk/edge group positioned at its origin), so
  streamed geometry never needs touching and Float32 magnitudes stay ≤ ~1.2 km.
  **Exception — the home region**: today's builders bake absolute world coordinates
  into vertices, so the 36-chunk home group is shifted **as a unit** via
  `group.position`. That forces one refactor: `updatePosts`/`updateCones` (and the
  home `postList/cones` coordinates) must become **group-local** — otherwise a post
  knocked after a rebase renders double-shifted (parent offset + shifted coords).
  This lands in M6 with a dedicated test.
- Chunk integer coords are never rebased: an integer `originChunkOffset` pair maps
  local indices to absolute indices for hashing (hashing must see absolute coords or
  the world changes after a rebase).
- Dev-mode forced-rebase soak test (rebase every few seconds while driving) to flush
  out anything missed.

## 10. Worker Offload — Deliberately Deferred

Main-thread time-slicing ships first (Slow Roads proves it at scale — 100 m road
chunks, 5×5 terrain grid, 60 Hz loop, single thread). But `src/worldgen.js` is written
as a **pure `(seed,cx,cz) → typed arrays` describer with zero three.js imports**, so a
module Worker (Safari/iOS 15+; transferable Float32Arrays) is a drop-in upgrade if
profiling ever shows generation pressure. OffscreenCanvas is ruled out (iOS 17+ only
under Capacitor's system WebKit).

## 11. Facade & Integration Map

| Current (`world.*`) | Endless replacement |
|---|---|
| `solids, boxes, cones, postList` | same arrays, rebuilt in place from the 3×3 active set |
| `walls` (flat) + `driftTrack.cull` | wall groups `[{cull, segs}]` (home circuit = group 0) |
| `updateBoundary(carState, dt)` | renamed **`world.update(carState, dt)`** — streamer tick: ring maintenance, queue pump, active-set rebuild, rebase check |
| `boundary`, ring, glow wall | deleted |
| `onDriftTrack(x,z)` | unchanged (home circuit); procedural circuits use their own registry + new stats |
| `townCenter` | unchanged (home town); procedural towns tracked separately |
| `updateAtmosphere(camPos, dt)` | unchanged (dust already wraps around camera) + sky/ground follow |
| `applyWorldPreset(world, preset)` | unchanged API; tints module-scope shared materials + light registry |
| `updatePosts/updateCones` | unchanged; operate on active-set lists (indices chunk-local) |
| `roadCurves` | replaced by road-registry queries (used only for scenery rejection today) |
| `setTrackLights(on)` | light-registry `setNight(on)` behind same facade name |

`config.js` gains:

```js
export const CHUNK = {
  size: 256, simRing: 1,
  visualRing: { low: 3, medium: 4, high: 4 },
  buildMs:    { low: 1.5, medium: 2.5, high: 2.5 },
  rebaseAt: 2048,
  roadGeoPool: 64, roadGeoVerts: 4096,
  perChunkCaps: { trees: 96, rocks: 48, bushes: 64, buildings: 24, posts: 48, cones: 16 },
  lightCap: 5,
};
```

New files (`src/rand.js`, `src/worldgen.js`, `src/roadnet.js`, `src/chunks.js`) are
added to `sw.js` CORE + cache version bump in the same commit.

## 12. Milestones (each independently shippable)

| # | Deliverable | Acceptance gate |
|---|---|---|
| **M1** | Extract/hoist shared materials + builders; `rand.js`; chunk-bucketed collision on the *finite* world; snapshot/result pooling | Pixel-identical world; physics step ≤ 0.5 ms; zero behavior diffs |
| **M2** | Endless **empty plain**: streamer + record pool; ground/sky/camera-far followers; boundary deleted | Drive 10 km in any direction; `renderer.info` flat (calls/geometries/textures constant); no hitches > 4 ms (incl. corner crossings — sync collider builds capped at 2/frame) |
| **M3** | Biome scenery via recycled InstancedMesh pools; **home city converted to instanced rendering** (~90 meshes → ~2 draws) | 10-min device soak; ≤ 100 draws incl. the city view; zero geometry/texture count drift; heap flat |
| **M4** | Road network: super-grid, archetypes, junction pads, edge registry, gateway docking (**incl. 2–3 new authored stub roads**), far-from-home respawn | Junction-pad trim rule prototyped first; same seed ⇒ byte-identical chunk output regardless of visit order; drift-vocabulary radii verified vs `v²/17` |
| **M5** | Landmarks + light registry + **new procedural achievements** (mini-circuit drift, town discovery, distance-from-home) + knocked-prop persistence | Track Rat/tourist untouched (home-only); new achievements earnable procedurally; ≤ 5 PointLights ever |
| **M6** | Floating origin at 2,048 m with audited shift checklist | Forced-rebase soak: no skid streaks, no camera pop, world identical across rebases |
| **M7** | Hardening: thermal soaks ≥ 10 min/tier on **iPhone 13 (A15)** — the oldest supported device; Xcode memory gauge ≤ 300 MB (13's ~400–450 MB limit gives comfortable headroom); offline smoke test | Release gates green on device |

## 13. Testing & Verification

- **Determinism**: headless Node test — hash the full describer output of a 5×5 chunk
  block for a fixed seed; assert byte-identical across runs and across visit orders.
  (The physics test harness `test_physics.mjs` pattern already exists for this style.)
- **Leak detection**: `renderer.info.memory.geometries/textures` must be constant
  after N load/unload cycles (drive a 5 km loop repeatedly).
- **Hitch detection**: dev HUD plots frame time + build-queue depth; assert no frame
  > budget during a 10-min max-speed drive.
- **Rebase audit**: forced-rebase mode (every 5 s) + visual skid/camera inspection.
- **Collision parity**: record a scripted drive's collision events on the finite
  world (M1) and assert identical events after chunking.
- **Device gates**: WKWebView on the oldest supported iPhone is the release
  environment for the M7 soaks (thermal + memory).

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Junction-pad ribbon trimming (hardest geometry work) | Prototype the arc-length clip rule *before* scheduling M4; both chunks and the pad owner must emit matching vertices deterministically |
| Pool exhaustion (dense biome ring) | Caps sized for worst case measured in M3; exhaustion defers farthest chunks (visual-only degradation), never allocates |
| Shadow-throttle vs streaming (stale cached shadow maps) | `streamerShadowDirty` OR-ed into the existing `shadowEvery` logic (single line in main loop) |
| Tunneling into unbuilt chunks | Synchronous collider builds for SIM ring + velocity prefetch row (colliders are pure math, no GPU) |
| Within-session chunk-revisit non-determinism (world mutates behind the player) | Generation is a pure function of (seed, cell); no load-order or car-path inputs; determinism test in §13 exercises revisit order |
| Dual world paths (authored region on legacy builder) | Accepted permanently (decided): the home region stays as-is on the legacy path; only its city rendering is instanced (M3, content unchanged) |
| WKWebView memory kills | ≤ 300 MB total target vs iPhone 13's ~400–450 MB limit; score/best already persist in localStorage — a reload starting a fresh world is accepted |

## 15. Decisions (resolved 2026-07-03)

1. **Achievements**: Track Rat / City Lights stay home-only. Procedural content gets
   **new achievements** (mini-circuit drift, town discovery, distance-from-home),
   added in M5.
2. **Reproducibility**: no requirement beyond the running session — no shareable
   seeds, no cross-device equality, reload may produce a new world. *Within-session*
   chunk-revisit determinism remains load-bearing (see §6.1) — that part is
   engineering necessity, not product preference.
3. **Device floor**: **iPhone 13 (A15)**. Memory gates use the ~400–450 MB line
   (target stays ≤ 300 MB with headroom); ring 4 is affordable on medium/high.
4. **No auto-quality degradation** — the existing manual Graphics setting remains
   the only quality control.
5. Dashes/kerbs: per-chunk instanced meshes (pre-committed — merging into the
   4,096-vertex road slots would overflow on long edges). Revisit only if the M4
   draw HUD shows the +1–2 draws/chunk hurt.
6. **The current map stays as-is**; everything beyond it is generated on the fly.
   The home region remains on the legacy build path permanently — the only change to
   it is *rendering-internal* (M3 instances the city's ~90 meshes into ~2 draws;
   layout, collision, and gameplay content are untouched).

---

## Appendix A — Why these numbers

- **256 m chunks**: crossed in ≥ 3.3 s at max boost (77.4 m/s fastest car) — a
  comfortable generation deadline; small enough that a chunk build is 1–3 ms of the
  measured 42 ms full-world cost; large enough that the 9×9 visual ring is only 81
  chunks (~160 records with hysteresis + home region).
- **2,048 m rebase**: Float32 ulp there is 0.24 mm (invisible); skid quads
  (0.28–0.52 m wide) and the 25 mm skid z-offset stay safe with ~4× margin; rebase
  cadence ≥ ~26 s at top speed.
- **Fog as occlusion**: fog far 700–860 by *preset* ⇒ ring 4 fully covers all
  presets; ring 3 (low tier) needs the fogFar clamp (§4) on golden/dawn;
  `camera.far` tightened to fogFar × 1.05 makes clipping real.
- **Instancing math**: instance matrix = 64 B; all pools ≈ < 2 MB of matrices
  (296 capped instances × 64 B × ~100 pool slots). The merged trunk+canopy tree
  halves both draws and matrices vs today's two meshes.

## Appendix B — Alternatives considered

Three full architectures were developed independently and scored (1–10; risk 10 = safest):

| Proposal | Memory | Frame stability | Risk | Gameplay | Determinism |
|---|---|---|---|---|---|
| **P1 Facade-preserving evolution** (reuse world.js builders; per-chunk create/dispose) | 6 | 6 | **9** | 7 | 8 |
| **P2 TREADMILL** (global span-allocated instance pools, SoA-first, zero-alloc) | **9** | **9** | 5 | 7 | **9** |
| **P3 Drift Horizon** (road-vocabulary generation, per-chunk recycled meshes, chunk-local verts) | **9** | 8 | 6 | **9** | **9** |

**Verdict**: adopt **P1's migration ladder and facade discipline**, **P2's
boot-time-preallocation memory model**, and **P3's chunk-local coordinates, per-chunk
recycled meshes, and drift road vocabulary**. Explicitly rejected: P1's
create/dispose-per-chunk v1 (GL buffer churn is the documented WKWebView hitch
source; upgrading later would be a second migration) and P2's global span-allocator
pools (`frustumCulled=false` full-capacity vertex shading is a measured mobile
regression; span-index bugs would corrupt the knock-over post animation and are the
hardest thing to debug in a no-test-harness codebase).
