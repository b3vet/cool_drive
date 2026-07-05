# Batch 2 Implementation Plan — "Purpose & Juice"

Companion to [ROADMAP.md](ROADMAP.md) §Now. Ten features, one batch. Every anchor below
was verified against the code as of `0a39821`; line numbers are approximate anchors —
symbols are the source of truth.

The batch splits into five phases ordered by dependency. Phases are independent enough
to verify separately, but B–E all assume A's light/shadow architecture is in place.

---

## Phase A — Foundations (do first; everything else builds on this)

### A1. Stale-shadow fix (`shadowDirty`)

**Bug**: `renderer.shadowMap.autoUpdate = false` (scene.js `createRenderer`) with a
modulo throttle in main.js (`if (++shadowTick >= shadowEvery)` right before
`renderer.render`). The streamer adds/removes/moves geometry with no way to signal the
shadow system → freshly-activated chunks render up to `shadowEvery−1` frames with no
shadow; rebases shift every caster against a stale map.

**Fix**: a boolean `shadowDirty` in chunks.js, set at the **complete** set of scene-mutation
sites (the mapping confirmed there are exactly four):
1. `update()` time-sliced activation (`buildProc(rec); scene.add(rec.group)`)
2. `buildSimRing()` — synchronous, can add SEVERAL chunks in one frame (the ones next
   to the car; instrumenting only the queue path would miss exactly the visible pops)
3. `unloadChunk()` group removal (a whole ring can leave in one frame — flag, not counter)
4. `maybeRebase()` after repositioning home + all chunk groups

Expose `consumeShadowDirty()` on the streamer return + the `buildWorld` facade.
main.js throttle becomes:
`if (world.consumeShadowDirty() || ++shadowTick >= shadowEvery) { needsUpdate; shadowTick = 0; }`

Also: `cyclePreset()` moves the sun per preset and never sets `needsUpdate` — add it
there. Keep `setQuality()`'s unconditional `needsUpdate` (it disposes the map).

**Accept**: teleport-drive in preview → the frame a sim-ring chunk activates has
`shadowMap.needsUpdate === true`; no shadowless pop at chunk boundaries on `low` tier.

### A2. PointLight consolidation (10 → 5) + scalar night level

**Today**: two independent pools — world.js `trackPointLights` (5, children of
`home.group`, home-track pole heads, intensity 26 at night) and chunks.js
`circuitLights` (5, scene-rooted, reassigned to nearest circuits every 0.35 s,
intensity 24 at night). All 10 resident forever; three.js bakes `NUM_POINT_LIGHTS=10`
into every lit program → every fragment pays for 10 point lights, day and night.

**Change**:
- world.js: **delete** the 5 `trackPointLights` (keep all 10 emissive head/pool
  materials — they are not lights). `buildHomeRegion` returns
  `lightAnchors: [{x, y: 6.2, z} ×5]` (the `k%2===0` head positions, absolute coords —
  home-group-local == absolute since the group sits at `-shiftTotal`).
- chunks.js: the existing 5-light pool becomes the **only** pool.
  `assignCircuitLights` → `assignLights(carX, carZ)`: candidates = home `lightAnchors`
  (absolute→render via `shiftTotal`) **plus** circuit centers (`rec.procCircuit`), sort
  by squared distance to car, assign the 5 lights (y from the candidate), intensity
  `25 * nightLevel`. Keep the 0.35 s `lightAcc` throttle + the synchronous re-assign in
  `maybeRebase`.
- **Scalar night**: `nightOn:boolean` → `nightLevel:0..1`. `setProcNight(on)` stays as
  an alias (`setNightLevel(on?1:0)`); new `setNightLevel(t)` for the day/night lerp
  (D2). world.js `setTrackLights(on)` also becomes scalar-tolerant:
  `emissiveIntensity = 3.0*level`, pool `opacity = 0.6*level` (boolean callers pass 1/0).

**Invariant (load-bearing)**: the 5 lights are created inside `createStreamer` →
`buildWorld` (main.js line ~48), **before** `renderer.compile` (line ~544), and are
never scene.add/removed afterward — only intensity/position. `NUM_POINT_LIGHTS` drops
to 5 in every compiled program; the warm-up stays valid; no mid-drive recompiles.

**Accept**: traverse scene → exactly 5 PointLights; at night near home the track is lit
(anchors win the sort); near a procedural circuit the circuit is lit; daytime all 5 at
intensity 0; draw calls / no recompile hitches when toggling preset.

---

## Phase B — Core loop (near-miss, links, haptics, boost FX)

### B1. Near-miss scoring

**Where**: `resolveCollisions` (world.js) — the solids / boxes / walls loops already
compute squared distance (`d2`, `wd2`) with the collision radius in scope. Posts and
cones are excluded (hitting them IS the interaction).

**Detection** (zero alloc, no sqrt):
- gate: `state.drifting && state.speed > SCORE.nearMissMinSpeed`
- enter: `d2 < (rr + SCORE.nearMissBand)²` while not colliding → count once
- re-arm hysteresis: per-object latch `o._nm = true`; cleared only when
  `d2 > (rr + nearMissBand*1.8)²`. Collider objects for solids/boxes/walls are
  **recreated on each gather** (chunk-cross), so latches self-reset — acceptable.
- `_colOut` gains `nearMisses` (count this substep). main.js must **accumulate per
  substep** inside the fixed-step loop exactly like `coneHits += col.cones` — `_colOut`
  is overwritten on the next 120 Hz call.

**Scoring** (`scoring.js`): `step(carState, dt, col)` gains the third param (main.js
already calls `scoring.step` immediately after `resolveCollisions` in the same substep).
When valid and `col.nearMisses > 0`:
- `banked += SCORE.nearMissPoints * multiplier * col.nearMisses` (rides the chain —
  a crash after the shave wipes it, correct risk/reward)
- `st.heat = 1` (style heat), decaying `heat -= dt/SCORE.heatDecay`; point rate becomes
  `pts *= 1 + st.heat * SCORE.heatBonus`
- one-frame event `st.justNearMiss += n` — main.js **must capture before `hud.update`**
  (the established capture-before-consume ordering; hud zeroes just* fields).

**HUD**: `#nearFlash` "CLOSE!" pop — a copy of the `#bankFlash` `.play` +
`@keyframes floatUp` restart pattern.

**Config** (SCORE block): `nearMissBand: 1.4`, `nearMissMinSpeed: 12`,
`nearMissPoints: 120`, `heatBonus: 0.5`, `heatDecay: 1.5`.

### B2. Transition / link scoring

**Where**: entirely inside `scoring.step` — `carState.slip` is signed (only `Math.abs`
is taken today).

State on `st`: `_slipSide` (−1/0/1), `_sideTime`. While valid and
`slipDeg > SCORE.linkMinSlipDeg`: `side = Math.sign(carState.slip)`. A **link** fires
when `side !== _slipSide && _slipSide !== 0 && _sideTime >= SCORE.linkDwell`:
`st.links++`, `multiplier = min(multiplier + SCORE.linkBonus, comboMax)`,
`st.justLink = st.links` (one-frame event). Reset `_slipSide/_sideTime/links` in
`bank()` and `fail()`.

**HUD**: `LINK ×N` tag beside `#combo` (child element — do NOT put a transform on
`#combo` itself; hud.update rewrites its inline transform every frame). Call the
existing (exported, currently unused) `pulseCombo()` on each link.

**Config**: `linkBonus: 0.4`, `linkDwell: 0.35`, `linkMinSlipDeg: 14`.

**Debounce is the whole feature** — the dwell requirement on BOTH sides is what stops a
twitchy countersteer from counting. Tune on the home esses first.

### B3. Achievements for B1/B2

Extend `ach.update` stats: `nearMisses` (cumulative), `bestLinks` (max links in one
chain). Two new entries (→ 21 total): `close_call` 🧷 "Close Call — shave past 25
obstacles mid-drift" (`nearMisses >= 25`); `linked_up` 🔗 "Linked Up — chain 4
direction changes in one drift" (`bestLinks >= 4`).

### B4. iOS haptics — new `src/haptics.js`

- Call via the **injected bridge** `window.Capacitor?.Plugins?.Haptics` — no ES import
  (node_modules never ships to web; the import map only has `three`). Web fallback:
  none (navigator.vibrate is unsupported in WKWebView/iOS Safari) — module no-ops.
- Install: `npm i @capacitor/haptics@^8` + `npm run ios:sync` (SPM `Package.swift` is
  CLI-managed; sync fills `packageClassList` — never hand-edit).
- API: `createHaptics()` → `{ impact(style), notify(type), setEnabled(on), enabled }`.
  Settings checkbox (native only), persisted `cooldrive.haptics` (default on).
- Triggers, all in the existing main.js event funnel (already one-shot per frame):
  `crashed` → Heavy; `bankedAmt>0` → Medium (Success notify when `isNewBest`);
  `justLink` → Light; boost ignition edge (`carState.boosting && !wasBoosting`) →
  Medium; achievement toast → Success notify. No continuous drift buzz in v1 (battery,
  mushiness).
- Move the `isNative` detection up next to `isMobile` (line ~77) — it's currently
  declared at line ~491, below the funnel code.
- **Ship checklist**: sw.js CORE += `./src/haptics.js`, CACHE bump `cooldrive-v4`→`v5`.

### B5. Boost overdrive FX

- **Exhaust flames**: all 3 shipped cars are GLB (`buildGLBCar` builds NO exhausts —
  the procedural exhaust code never runs). Add a `flames` group + `flameMat` facade
  field in **both** build paths: two small additive-blend cones at
  `(±0.4, ~ride, bodyL/2)` parented to `chassis` (exists synchronously; don't anchor to
  the async-loaded GLB). Drive in `applyCarVisual` (it receives full `carState` incl.
  `boosting`, plus `dt`): opacity lerp toward `boosting ? 0.9 : 0` + per-frame scale
  flicker.
- **Speed lines**: CSS-only overlay `#speedLines` **inside `#rotor`** (it must rotate
  with the portrait layout), styled like `.hud` (fixed, inset 0, pointer-events none).
  Toggled via `body.boosting` class set on the existing boost edge in main.js. Low-
  opacity streak gradient + subtle animation. Add the repo's **first**
  `@media (prefers-reduced-motion: reduce)` rule to disable it.
- **Smoke tint**: Smoke has ONE material-level color uniform
  (`smoke.mat.uniforms.color.value`) — lerp toward the preset accent while
  `state.boosting`, back to `SMOKE.color` otherwise, inside `effects.update`. New
  `effects.setAccent(hex)` called at boot + preset change. (Single uniform = all live
  particles tint together; acceptable, boost is a global state.)

---

## Phase C — World purpose (compass, regions, trials, new landmarks)

### C0. Streamer seed-helpers (prerequisite)

`streamerSeed` is closure-private and nothing exposes it — the compass/regions/trials
all need pure worldgen queries. Follow the `nearestRoad` precedent (render coords in →
`+shiftTotal` → pure query → `−shiftTotal` out). Add to the streamer return + facade:

- `nearestLandmarks(x, z, k=3)` — scan LM cells (`LM_CELL=5` chunks = 1280 m) in a
  bounded spiral (±3 cells) around the car's absolute chunk; `landmarkFor` costs 2
  hashes + 2 PRNG draws per cell, trivial at 4 Hz. Returns
  `[{kind, x, z, d}]` in render coords, sorted.
- `regionAt(x, z)` — see C2.
- `circuitNear(x, z)` — nearest live circuit `{key, cx, cz, x, z, r}` or null (for C3).

### C1. Beacon compass

- **worldgen**: nothing new — `landmarkFor` is already pure/cheap.
- **main.js**: piggyback the existing 4 Hz `procTownCheckAcc` block: refresh
  `compassTargets` = home (render `(-shift.x, -shift.z)`, shown when
  `homeDist > 500`) + top-3 `nearestLandmarks`. **Rebase**: targets are render coords —
  shift them in the existing `world.setRebase` callback (same place carState/cam/
  effects shift) or simply re-fetch; do both (shift immediately, refresh at next tick).
- **HUD**: chip row under `#scoreWrap` (top-left — free on both layouts; mobile
  top-center is taken by `#radio`). Each chip: arrow glyph rotated by
  `bearing − carState.heading`, kind icon (🏁 🌃 ⛳ 🅿️ ⌂ …), distance ("1.2km").
  Per-frame rotation update in `hud.update` from cached targets (cheap); target refresh
  at 4 Hz. Styling: `--facet-sm` clip, `var(--accent)` line, Chakra Petch, skewX —
  per DESIGN.md (read it before building).

### C2. Region naming + discovery toast

- **worldgen**: `regionName(seed, rx, rz)` — supercell = `floor(cx/8)` (2048 m
  regions). Name = adjective + biome-keyed noun (`plain→Flats, meadow→Fields,
  forest→Woods, rock→Ridge`), adjective from a curated ~24-word list via `hash01` with
  a **new** `SALT.REGION`. Supercells overlapping the home reservation return
  `"Home Turf"`.
- **SALT collision warning** (from the mapping): occupied values include the visible
  table PLUS derived salts `0x1112`, `0x555C`, `0x7778` and chunks.js's raw literal
  `0xabcd`. Use `REGION: 0xbb01`, `RING: 0xbb02` and register them in the SALT table;
  also promote `0xabcd` into the table as `TOWN_BUILD` while there.
- **main.js**: in the 4 Hz block, compare current supercell key to last; on change →
  toast + add to a session `Set` (per-session seed ⇒ session-only is correct).
- **hud.toast**: parameterize — `toast(a, kicker='ACHIEVEMENT', cls)`; region toasts
  use kicker `NEW REGION`, a `.toast.region` variant with `--accent` inset bar instead
  of gold.
- **Achievement**: `pathfinder` 📍 "Pathfinder — discover 8 regions"
  (`regionsSeen >= 8`). (→ 22 total.)

### C3. Circuit ring time-trials — new `src/trials.js`

- **Deterministic path**: extract the circuit centerline math out of
  `buildLandmark` into worldgen: `circuitPath(cx, cz)` (the 9 control points via
  `rr(i)=70*(0.75+0.25*sin(i*1.7+cx))` + closed resample — it depends only on `cx`).
  chunks.js imports it for geometry; trials.js imports it for gate placement. Single
  source of truth, no stored geometry.
- **Rings**: fixed pool of **7 torus meshes** created once at boot (before
  `renderer.compile`), scene-rooted, two shared materials (idle: transparent neon at
  0.25; active: full + pulse). **No PointLights** (the 5-light invariant is hard).
- **State machine** in trials.js: IDLE → car enters a circuit (`circuitNear` +
  radius) → ARM (place rings evenly along the path, `celebrate('RING RUN', …)`) →
  START on first ring pass → pass rings in order (radius check vs next ring only,
  O(1)/frame) → FINISH: reward = `3000 + max(0, par − time) * 400` where
  `par = pathLen / 18`. ABORT on leaving the circuit radius ~+40 m (also covers the
  chunk unloading — you left anyway).
- **Reward path**: new `scoring.award(pts)` — adds straight to `st.score` with a
  one-frame `st.justAward` for the HUD (trial rewards should not be crash-wipeable).
- **Rebase**: ring positions are render coords → `trials.shift(dx,dz)` wired into the
  same `setRebase` callback.
- **Best times**: `Map` keyed by chunk key, knockedCones lifecycle (session-only —
  correct under a per-session seed).
- **HUD**: timer chip near `#speedWrap` while active.
- **Achievement**: `ring_runner` 💫 "Ring Runner — complete a ring run". (→ 23 total.)

### C4. New landmark kinds

`landmarkFor` kind ladder re-slice (session seeds ⇒ no save-compat concerns):
`circuit <0.28 | town <0.52 | slalom <0.68 | skidpad <0.80 | park <0.87 | gate <0.94 | lookout`.

New `buildLandmark` branches (conventions: meshes chunk-local into `rec.group`,
colliders ABSOLUTE into `col.*`, per-build geometry into `disp`, shared geo/materials
NOT disposed, instanced-pool checkouts null-guarded):

- **`park` (stunt park)**: banked wedge berms (shared module-level `wedgeGeo`, built
  once) arranged around a skid circle (reuse `padGeo`), plus a short cone slalom
  (persist-tagged like the wild slalom). Berm colliders as oriented `col.boxes`.
  *Scope note: this ships WITHOUT airtime — the drift physics is 2D; real ramps/jumps
  arrive with the elevation feature (ROADMAP §Next). Do not fake a hop.*
- **`gate`**: a neon arch — two pillars + beam (shared `buildingGeo` scaled, neon
  `wallCapMat` beam). If the chunk has a road (`desc.roads` non-empty), place ON the
  road at the sample nearest chunk-center, oriented to its tangent; else hash-oriented
  at center. Pillar colliders as two `col.solids` (r 0.7). Driving through
  (`rec.procGate` + streamer `procGateAt` + 4 Hz check) grants `+0.25` boost fill + a
  chime, once per visit (latch on rec).
- **`lookout`**: a ~42 m tapered tower (3 stacked scaled boxes, one shared boot-time
  `towerMat`) + neon beacon cap (`wallCapMat`). One `col.solids` (r 4). Its job is to
  be visible over the fog line as a navigation anchor for the compass.

All three inherit the existing 120 m scenery-clear disc automatically (kind-independent
in `describeChunk`). Known pre-existing quirk (unchanged): roads can slice through
landmark chunks — gates exploit this deliberately; park/lookout tolerate it.

---

## Phase D — Atmosphere (day/night cycle, rain + wet grip)

### D1. Preset blend plumbing (prerequisite for D2/D3)

`applyPreset` today: constructs a NEW `THREE.Fog`, string-branches on the preset key
for sunDisc/stars, and `ctx.preset` **aliases the shared PRESETS config object** —
mutating it for a lerp would corrupt the constants. Add to scene.js:

- `applyPresetBlend(ctx, renderer, a, b, t)` — writes into a module-owned **blended
  copy** (`ctx.preset = blended`, own `sunPos` array — `trackSun()` reads
  `ctx.preset.sunPos` every frame, so the lerp flows through it for free). Mutates in
  place: sky uniform Colors, `scene.fog.color/near/far` + `setClearColor`, hemi, sun
  color/intensity, `groundMat.color`, and per-key tables for sunDisc
  (tint/opacity/scale) and star opacity turned into lerpable values.
- Discrete-today things that must lerp or threshold: `setAccent(lerpedNeon)` +
  world material recolors (throttle to ~5 Hz — Color.setHex churn is cheap but
  pointless per-frame), `nightLevel = smoothstep` around the night keyframe →
  `world.setTrackLights(level)` + `streamer.setNightLevel(level)` (the A2 scalar API),
  `presetName` = nearest keyframe's name, `ach.event('night')` on first
  `nightLevel > 0.5`.

### D2. Automatic day/night cycle

- main.js: `autoCycle` toggle (settings checkbox, persisted `cooldrive.autocycle`,
  **default ON**), phase `cycleT` advancing `dt / CYCLE.secondsPerLeg` through
  golden→dawn→night→golden (full loop ~8 min; night leg weighted longer).
- Manual `cyclePreset` (P key / button) with auto ON = jump `cycleT` to the next
  keyframe and keep cycling; with auto OFF = today's discrete `applyPreset` path,
  untouched (zero-risk fallback).
- Shadow stepping under a continuously-moving sun is bounded by `shadowEvery`
  (≤3 frames on low) — acceptable; no per-frame `needsUpdate`.

### D3. Rain + wet grip — new `src/weather.js`

- **Rain layer**: clone of the dust template (world.js `updateAtmosphere`): one
  `Points` with ~500 particles, position+velocity buffers, camera-relative while-loop
  wrap over ±70 m x/z, `vy ≈ −22`, ground reset; huge boundingSphere +
  `frustumCulled=false` (copy BOTH or it gets culled); `PointsMaterial` size 0.9,
  opacity 0.35. Scene-rooted render-space — the wrap self-corrects after rebase, no
  shift() needed. Updated next to `world.updateAtmosphere` in the frame loop.
- **Wet grip**: compose in `applyTuning` — the single profile×car derivation point:
  `PHYS.gripNormal = p.gripNormal * c.gripMul * wetMul` (same for `gripDrift`,
  `handbrakeGrip`). `wetMul = WEATHER.gripMul (0.86)` when raining. Physics already
  lerps `s.grip` at `gripBlendRate` — the toggle transitions smoothly for free.
  Weather change → re-run `applyTuning()` (known pre-existing quirk: this stomps
  manual slider tweaks — same as car/mode change today; acceptable).
- **Wet look**: new `world.setWet(t)` (closure access to `home.shared` + `groundMat` +
  dust): road/track roughness → ~0.55, ground darkened, dust hidden. Fog: multiply the
  **blended** fog output by `WEATHER.fogPull (0.85)` inside the D1 applier (weather
  composes after the preset lerp — the ordering rule).
- **Spray**: in `effects.update`, when wet and `speed > 15`, low-intensity
  `smoke.emit` at the rear contacts even when not drifting.
- **Setting**: Weather select — `Clear / Rain / Surprise` (Surprise ≈ 30 % rain rolled
  per session), persisted `cooldrive.weather`, default **Surprise**.
- Config: `WEATHER { gripMul: 0.86, fogPull: 0.85, rainCount: 500, ... }`.
- **Ship checklist**: sw.js CORE += `./src/weather.js` (+ `./src/trials.js` from C3).

---

## Phase E — Verification & ship

1. **Headless** (`npm test`, extend `test_worldgen.mjs`):
   - `regionName` determinism + non-empty for a grid of cells; home supercell special-case
   - `nearestLandmarks`-equivalent pure scan determinism + bounded cost
   - `circuitPath` determinism (same `cx` → identical polyline)
   - kind-distribution sanity: all 7 landmark kinds appear in a wide scan
2. **Preview** (the established teleport-drive harness):
   - zero console errors across boot / drive / preset cycle / weather toggle / trial
   - **exactly 5 PointLights** in the scene graph (traverse assert)
   - draw calls at ground level ≤ 120 on High; leak re-run (22 km serpentine →
     `renderer.info.memory.geometries` flat)
   - shadow: activation frame forces `needsUpdate`
   - near-miss: scripted drive-by a tree inside the band while drifting → `justNearMiss`
   - links: scripted slip sign flips with dwell → `LINK ×N`, multiplier bump
   - trial: teleport onto a circuit, script ring passes → award fires
   - rain: grip delta measurable (turn-radius harness from test_physics), spray visible
   - cycle: accelerate `cycleT`, confirm smooth fog/sky/accent lerp + night threshold
     firing once
3. **Ship**: sw.js CORE += haptics/weather/trials, CACHE `v5`; `npm i
   @capacitor/haptics@^8`; `npm test`; `npm run build:web`; `npm run bump`;
   `npm run ios` (sync pulls the haptics pod/SPM target in). Dockerfile/build-www need
   nothing (recursive `src/` copy).

## Cross-cutting rules (from the code mapping — violations are bugs)

- **Light count is frozen at 5** after `createStreamer`; only intensity/position change.
- **`_colOut` is pooled** — new fields must be read inside the substep loop.
- **Capture just\* events before `hud.update`** — it zeroes them.
- **New SALTs** must dodge `0x1112 / 0x555C / 0x7778 / 0xabcd` (derived + raw literals).
- **Render-coord caches** (compass targets, trial rings) must shift in the
  `setRebase` callback.
- **Per-chunk mutable state** follows the knockedCones Map lifecycle (read in build,
  write in unload) and tolerates `gather()` rewriting cone `.x/.z` to render coords.
- **New src modules**: sw.js CORE entry + cache bump, by hand, same commit.
- **Any visual/UI work**: DESIGN.md first — facets, neon edges, skewX, accent vars,
  left-anchored layout, Chakra Petch.
