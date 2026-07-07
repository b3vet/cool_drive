# Optimization & Thermal Plan

> ## Implementation status (2026-07-07)
> **All six phases implemented and verified** (tests green, web build assembles, no console
> errors, no geometry/program leaks over a soak, materials/shadows visually confirmed on both
> tiers, thermal governor validated end-to-end: critical → floored pixelRatio).
>
> **Landed:** time-scheduled + texel-snapped shadows (High 60→40 Hz, Medium 30, Low 15; the car
> keeps its real shaped shadow — the time-based scheduler already decoupled cadence from what
> casts, so a blob was unnecessary and was reverted), pixelRatio cap 1.7 on phones,
> `alpha:false`/`stencil:false`, MSAA + Lambert big-surface shading per-tier at boot
> (shadow filter stays PCFSoft on ALL tiers — the 1-tap Basic filter blocked-out the car shadow on
> Medium/Low and was reverted; per-tier map size + tighter frustum keep the depth pass cheap
> instead), fog-distance visualRing 3
> (poolSlots 81), menu 30 fps + shadow gate, adaptive quality governor (fps + native
> `ProcessInfo.thermalState` via [AppDelegate.swift](ios/App/App/AppDelegate.swift)), dead/oversized
> smoke fixes, HUD dirty-check + boost `scaleX`, `backdrop-filter` removed, `ownedEdges` LRU
> memoize + AABB early-out, touch classify-once, achievements/trials/compass throttles,
> `updatePosts` alloc hoist, car-texture leak fix, fps remainder-carry, `vendor/` cache-first SW.
>
> **Deferred as lower-value / higher-risk** (kept out to protect correctness — revisit if the
> device soak still shows headroom): neon→MeshBasic (Lambert already cheap), `matrixAutoUpdate=false`
> on static chunk subtrees, skid-mark partial VBO upload (three update-range API unverified in the
> vendored build), `gather()` collider-object reuse, time-sliced unload, landmark-geometry cache,
> web audio suspend-on-hidden (would risk the hard-won mobile-audio fixes), FX count scaling by
> tier, junction-pad / landmark mesh merging, car GLB boot warm-up.
>
> **Note:** the web changes reach the iOS app via `npm run build:web` + `npx cap sync`; the native
> thermal signal in AppDelegate.swift additionally needs an Xcode rebuild (`npm run ios`).

The big pass promised in [THERMAL.md](THERMAL.md). Produced by a 65-agent audit
(9 lenses → adversarial verification of every finding → gap analysis; 77 confirmed,
1 refuted) combined with **live instrumentation** of the running game. Every item
below cites file:line and was verified against the actual code. Plan only — nothing
here is implemented yet.

**Targets**
- iPhone 17 Pro Max / any flagship: cool after 30+ min at High. Warm-up ok, hot not.
- Late-2018 iPhone (A12): playable at Low/Medium for a full session.
- Acceptance gate (from THERMAL.md): no thermal throttle over a 10-min straight-line
  soak on an iPhone 13 at Medium.

---

## 1. What we measured (live, real driving)

| Fact | Value |
|---|---|
| Shadow depth passes, **High**, any state | **1.000/frame — every frame** (`shadowEvery: 1` = throttle configured off, [config.js:67](src/config.js:67)) |
| Shadow depth passes, Medium, parked, cycle on | 0.548/frame (0.5 tick + day/night 5 Hz force at [main.js:238](src/main.js:238)) |
| Shadow depth passes, Medium, parked, cycle off | 0.500/frame exactly |
| Draw calls at ground level while streaming | ~100–113 (**not** a problem) |
| Triangles | 31–78 k (**not** a problem) |
| Scene | 428 renderables; **395 MeshStandardMaterial**; 214 shadow casters; 29 transparent |
| Geometry churn while driving | 0.5–0.9 disposals/s (modest) |
| Leaks over soak | none — programs 20, geometries 62–90, textures 6, heap ~16 MB all flat |
| Renderer | antialias:true (MSAA), canvas alpha:true, ACESFilmic, PCFSoftShadowMap, pixelRatio 2 (High) / 1.5 (Medium) |
| fps cap | holds 60 on 120 Hz (verified); Low's "45" actually renders 30 (60 Hz panel) / 40 (120 Hz) — timestamp quantization at [main.js:465](src/main.js:465) |

### The corrected heat model

The phone is not hot because of scene complexity, memory, churn, or audio. It is hot
because **every pixel is expensive and there are too many passes**:

```
per frame on High =
    main pass:  ~1.68 M px (pixelRatio 2)
                × MeshStandardMaterial PBR with a 7-light program
                  (5 always-compiled PointLights + sun + hemi — even at intensity 0)
                × 16 PCFSoft shadow taps on ~half the pixels
                × ACES tone mapping
                × 4x MSAA
  + shadow pass: full 2048² depth re-render of ~214 casters — EVERY frame
  + ~40 % of chunk draws are 100 % behind the fog wall (ring 4 at 768–1150 m vs fogFar 700–860)
  + DOM overlay: per-frame textContent/style writes onto glow-shadowed, layer-heavy
    elements + 3 backdrop-filter chips re-blurred 60×/s over a canvas that
    invalidates every frame
```

≈ 101 M heavy fragment invocations/s + ~252 M shadow texel writes/s (~1 GB/s depth
traffic), sustained for 20 minutes. That is the fire.

### THERMAL.md suspect verdicts

| # | Suspect | Verdict |
|---|---|---|
| 1 | shadowDirty per activation defeats throttle | **Redirected.** The dirty-force adds only ~2 % (build queue drains 1 chunk/frame; ~9 dirty frames per 8.5 s). The real cost is the **baseline cadence**: `shadowEvery: 1` on High + the 5 Hz day/night force. Same fire, different fuse. |
| 2 | Per-chunk geometry churn | **Mostly exonerated** on GPU (0.5–0.9 disposals/s). Real CPU spike found instead: worldgen re-derives the road network **26×** per chunk build ([worldgen.js:116](src/worldgen.js:116)), and unload tears down ~9–11 chunks in one frame. |
| 3 | No scenery LOD | **Reframed.** LOD is unnecessary — the fog wall already hides the far field; we just keep *drawing* behind it. Fog-distance culling is the win, not billboards. |
| 4 | Draw calls / overdraw | Draw calls fine (~110). Overdraw real in three spots: fog-hidden rings, unclamped smoke sprites, dead smoke slots rasterizing forever. |
| 5 | fps cap on ProMotion | **Holds** (60 on 120 Hz). Minor: Low's 45 quantizes to 30/40. |
| 6 | Per-frame O(records) scans | **Negligible** (verified — all throttled or trivially cheap). |
| 7 | Pool footprint | Memory fine. Bonus: ring 3 lets poolSlots drop 121 → 81. |
| 8 | Point lights + PBR everywhere | **Confirmed critical.** 395/428 meshes on full PBR incl. ground/roads = most screen pixels; 7-light program compiled into every lit shader. |

New fires the suspect list missed: **pixelRatio 2 fragment bill** (critical), **PCFSoft
16 taps/px on every receiver fragment** regardless of update cadence (high), **fog-ring
overdraw** (high), **no adaptive governor** (high — nothing *ever* reduces load as the
device heats), the **DOM/compositor cluster** (backdrop-filter, glow re-rasters,
per-frame writes), **menu idle burns like gameplay** under a full-screen blur, the
**car GLB path** (DoubleSide PBR + it's the sole dynamic caster pinning shadow
refresh), and `document.elementFromPoint` per touch per touchmove.

---

## 2. The plan

Six phases, each an independently shippable, testable PR. Order = impact per risk.
Rule from THERMAL.md stands: **measure → fix the dominant cost → re-measure.**
Never blind-optimize; land Phase 0 first and capture a baseline on device.

Invariants every change respects: constant 5 PointLights created before
`renderer.compile`; no new material *types* after compile (pre-created twins are
fine); deterministic worldgen; zero-build ES modules; absolute coords.

---

### Phase 0 — Measurement rig (prerequisite, ~half a day)

Build the ruler before cutting.

- [ ] **Dev HUD: shadow passes/s + effective fps.** Count frames where
      `renderer.shadowMap.needsUpdate` was true before render in [main.js:603](src/main.js:603);
      show in the backtick HUD ([main.js:647](src/main.js:647)). This is the #1 metric of the whole plan.
- [ ] **Move `fpsEMA` out of the `hudOn` gate** ([main.js:648](src/main.js:648)) — it currently
      only updates while the dev HUD is open; Phase 4's governor needs it always-on (~3 ops/frame).
- [ ] **Soak protocol** (repeat after every phase):
      device + Xcode Metal/energy gauges, 10-min straight-line drive, autoCycle on,
      record: shadow passes/s, fps, GPU frame time, energy impact, thermal state,
      device temperature by feel. Baseline on iPhone 17 Pro Max @ High AND @ Medium
      before Phase 1 lands.
- [ ] Optional: log `ProcessInfo.thermalState` from a stub native plugin early (it
      becomes the Phase 4 governor input anyway — same `packageClassList` pattern as
      the haptics plugin).

---

### Phase 1 — Stop the fires: config + one-liners (S effort, biggest wins first)

Nothing structural; parameter changes and visibility toggles. Expected combined:
**~40–55 % of sustained GPU load on High, ~20–30 % on Medium.**

**Shadow cadence**
- [ ] `QUALITY.high.shadowEvery: 1 → 2` ([config.js:67](src/config.js:67)). Halves High's
      shadow pass today. Zero risk. (Full cadence overhaul in Phase 2.)
- [ ] **Delete** the `shadowDirty = true` writes at [chunks.js:501](src/chunks.js:501) and
      [chunks.js:426](src/chunks.js:426). Verified: activations happen ≥768 m out, unloads
      ≥1280 m — both far outside the 150 m shadow frustum ([config.js:208](src/config.js:208));
      the forced refresh renders an identical map. Keep the flag at :465 (rebase) and
      :519 (sim-ring sync builds — within 256 m).
- [ ] Route the day/night force through the throttle: at [main.js:238](src/main.js:238) don't
      set `needsUpdate` directly — set a `sunMoved` flag consumed by the line-603 gate
      so it can never exceed the tier cadence. (Manual preset jump at :217 stays immediate.)

**Fragment bill**
- [ ] `QUALITY.high.pixelRatio: 2 → 1.7` on coarse-pointer devices ([config.js:67](src/config.js:67))
      — ~28 % fewer fragments through the most expensive path, visually near-identical on
      a 3× phone. Also lower the boot default at [scene.js:10](src/scene.js:10) to match
      (first paint happens before `setQuality`). Any ratio change must go
      setPixelRatio → setSize → applyLayout ([main.js:63-65](src/main.js:63)).
- [ ] Device-class boot default: hoist the `isMobile` check ([main.js:80](src/main.js:80)) above
      quality init ([main.js:59](src/main.js:59)); default mobile → Medium (already the global
      default — keep) and consider never offering `shadowEvery: 1` on coarse-pointer.

**Fog-wall overdraw (~40 % of resident chunks are invisible)**
- [ ] `CHUNK.visualRing: { low: 2, medium: 3, high: 3 }` ([config.js:222](src/config.js:222)).
      Ring-3 nearest edge (640–896 m) still reaches the fog wall in every preset
      (fogFar 700–860). Test at dawn (clearest, 860 m) for edge pop-in.
- [ ] Lower `CHUNK.poolSlots` 121 → 81 ([config.js:231](src/config.js:231)) — chunks.js takes
      `max(poolSlots, derived)`, so without this the pools stay 121 and the memory/build
      win evaporates.
- [ ] (Alternative kept for Phase 6 if High must keep the long sightline: per-chunk
      `rec.group.visible = dist < fogFar + margin` piggybacked on the throttled 0.35 s
      light tick at [chunks.js:508](src/chunks.js:508) — **exempt lookout-tower chunks**;
      beacons are meant to be seen above the fog.)

**Menu/idle burn (menu idle currently costs the same as gameplay, plus a blur)**
- [ ] Cap menu fps: at [main.js:465](src/main.js:465) use
      `running ? targetFrameMs : Math.max(targetFrameMs, 33)` (don't mutate state in
      startGame — settings can change quality mid-menu).
- [ ] Gate the shadow tick while `!running`: e.g. effective shadowEvery × 4 on the menu.
- [ ] Remove `backdrop-filter: blur(3px)` from `#startScreen` ([index.html:173](index.html:173))
      — its own gradients carry the look; iOS re-blurs the whole screen every frame
      because the canvas beneath invalidates every frame.

**Invisible things that still draw**
- [ ] `stars.visible = opacity > 0.01` wherever star opacity is set
      ([scene.js:158](src/scene.js:158), [scene.js:201](src/scene.js:201)) — 700 unculled points
      draw all day at opacity 0. Same for `sunDisc` ([scene.js:69](src/scene.js:69)) and the
      lamp-pool discs at day.
- [ ] Dust motes: early-return + `dust.visible = false` when `dustMat.opacity < 0.01`
      ([world.js:655-677](src/world.js:655)) — the JS loop and full VBO re-upload run every
      frame even when fully faded.
- [ ] Dead smoke slots: in the dead branch ([effects.js:199](src/effects.js:199)) also zero
      `size[i]` (inside the dirty guard, and in `clear()` at :227). Verified ~180 dead
      slots rasterize ~70–220 px sprites of pure discarded fragments — ~0.5–1 M wasted
      fragments/frame during drift (the core loop). GLES clamps pointSize 0 → 1 px; fine.
- [ ] Clamp smoke sprite screen size: `gl_PointSize = min(computed, uMaxPoint)` in the
      existing vertex shader ([effects.js:149](src/effects.js:149)), uniform per tier
      (140 High / 96 Medium / 64 Low, framebuffer px). Shader-source edit at boot =
      compiled once before `renderer.compile` — no runtime recompile.

**DOM quick hits**
- [ ] Dirty-check every HUD write ([hud.js:54-132](src/hud.js:54)): compare-before-assign
      caches (`if (last.x !== s) { last.x = s; el.textContent = s }`) for score, best,
      speed, comboVal, banked, boost width, `--c` (quantize hue to integer), combo
      transform (quantize scale to 0.01), compass arrow transforms (quantize to
      ~0.02 rad). WebKit dirties layout even on identical assignment — the compare
      must happen before the write. Kills ~300–780 style/layout/paint passes per second.
- [ ] Boost bar: animate `transform: scaleX()` instead of `width`
      ([index.html](index.html) `#boostFill`, [hud.js:129](src/hud.js:129)) — width is a layout
      property with a CSS transition retriggered on every write.
- [ ] Remove `backdrop-filter` from the three persistent chips (#radio, #gearBtn,
      #camBtn — [index.html:160](index.html:160)); bump chip background alpha to ~0.8
      (new `--panel-chip` token; check [DESIGN.md](DESIGN.md)). 3 GPU blur passes × 60/s, gone.
- [ ] `setAccent` / presetName at 5 Hz under autoCycle ([main.js:235](src/main.js:235)):
      cache last-applied hex + label, skip when unchanged (quantize channels) — writes
      drop to ~every few seconds naturally.

---

### Phase 2 — Shadow system overhaul (M effort)

The structural version of Phase 1's patches. Expected: shadow pass from 30–60/s to
**8–15/s with zero visible change**, and each pass cheaper.

- [ ] **Texel-snapped sun.** In `trackSun` ([main.js:165](src/main.js:165)) quantize
      sun.position/target to the shadow texel grid in light-space basis —
      `worldTexel = 2 * WORLD.shadowRadius / ctx.sun.shadow.mapSize.x` (read the LIVE
      mapSize — it changes per tier: 0.146 m / 0.293 m / 0.586 m). This is what makes a
      low refresh rate shimmer-free.
- [ ] **Time-based cadence per tier** replacing frame counting at [main.js:603](src/main.js:603):
      `if (dirty || now - lastShadowMs >= q.shadowMs)` with High 30 Hz / Medium 20 Hz /
      Low 12 Hz. Handle the autoCycle sun-direction lerp via the same scheduler
      (`sunMoved` flag from Phase 1). Force immediately only on rebase + manual preset jump.
- [ ] **Blob shadow for the car; car stops casting.** The car is the *sole dynamic
      caster* — the only reason shadows need refreshing at all while cruising straight.
      `castShadow = false` on GLB meshes ([car.js:83](src/car.js:83)) + tires
      ([car.js:199](src/car.js:199)); add one persistent scene-level radial-gradient quad
      (MeshBasicMaterial + CanvasTexture, created before `renderer.compile`,
      `depthWrite: false`, y above road decals) that copies car x/z + yaw each frame.
      **Not parented to car.group** — the car group is rebuilt on selection.
      Unlocks cruising cadence toward the dirty-driven minimum.
- [ ] **Shadow filter per tier, chosen at boot** (before `renderer.compile`; quality key
      is already read from localStorage first): High = PCFSoft (16 taps), **Medium/Low =
      BasicShadowMap (1 tap)**. ⚠ Verified in vendored r160: plain `PCFShadowMap` is
      **17 taps — more than PCFSoft**. Do not ship PCF anywhere. Hard-edged shadows suit
      the low-poly art; Low's 512 map is already blocky. Mid-session tier change: apply
      filter on next launch (note in settings) or accept the one-time user-initiated recompile.
- [ ] **Shadow frustum per tier**: `WORLD.shadowRadius` 150 everywhere today
      ([config.js:208](src/config.js:208)) → e.g. 150/110/80. Smaller frustum = fewer casters
      per pass + better texel density (offsets Basic's hard edge).
- [ ] **Trim the caster set**: `castShadow = false` on tree trunks (hidden under canopy
      shadows), cones, posts ([chunks.js:59-66](src/chunks.js:59)); fix the ~48 % oversized
      pooled bounding spheres (radius `CS*1.05`) that inflate shadow-pass culling.

---

### Phase 3 — Fragment diet (M effort)

Make the average pixel cheap. Expected: **~40–60 % of main-pass fragment ALU on
Medium/Low**, plus wins on High.

- [ ] **Lambert twins for big-area materials.** At boot, build MeshLambertMaterial
      twins (same color/flatShading/vertexColors) for: ground ([scene.js:115](src/scene.js:115)),
      road/track asphalt ([world.js:111](src/world.js:111), [world.js:238](src/world.js:238)),
      trunk/canopy/rock/bush/building pools ([chunks.js:59-66](src/chunks.js:59)), TOWER_MATS.
      `setQuality` swaps `mesh.material` by tier (Medium/Low → Lambert, High → Standard).
      Warm-up: attach each twin to a hidden mesh that **mirrors its real user**
      (r160 `compile` collects via `scene.traverse`, and the program cache key includes
      object-level bits — pooled users need a hidden 1-instance InstancedMesh twin).
      Pre-created twins are explicitly invariant-legal.
- [ ] **Neon/glow → MeshBasicMaterial.** Road edges, posts, wall caps, window bands,
      lamp heads are MeshStandardMaterial with emissive today — they should be unlit
      (no lighting math at all, no shadow taps). Same boot-time twin mechanism.
      Verify the bloom-ish look survives; these are small-area, so this is polish+cheap.
- [ ] **Car material strip** ([car.js:81-88](src/car.js:81)): per material —
      `side = FrontSide` (GLTFLoader maps doubleSided:true; interior faces double the
      car's fragments), `normalMap = null` (flatShading already overrides normals),
      `metalnessMap/roughnessMap = null` with constants `metalness 0.2 / roughness 0.6`
      (**required** — glTF defaults metallicFactor 1.0 → near-black without the map),
      keep only `map`; `needsUpdate = true` once before `chassis.add`; dispose the
      detached textures. Run unconditionally (not only in the `flat` branch).
      ~3–4× cheaper car draw, every frame, biggest near-camera object.
- [ ] **Canvas `alpha: false`** + `stencil: false` in the WebGLRenderer options
      ([scene.js:9](src/scene.js:9)) — the page never shows through (opaque clear color);
      saves compositor blending of a full-screen surface.
- [ ] **MSAA per tier**: `antialias: false` on Low (boot-time context flag; requires
      the tier read before renderer creation — already true). Consider keeping MSAA
      on Medium/High (cheap-ish on TBDR, big visual value).
- [ ] Road center dashes: `transparent: false` + alphaTest or plain opaque
      ([world.js:212](src/world.js:212)) — nearly-opaque transparency forces them out of
      the early-z opaque path.
- [ ] Measure-then-decide: ACES → `NoToneMapping`/Linear on Low only (per-tier at boot).
      Skip if the soak shows it's noise.

---

### Phase 4 — Adaptive quality governor (M effort) — the safety net

Nothing above prevents a hot day + a long session from cooking a lesser phone.
The governor is what makes "as playable as possible, as long as possible, on most
devices" *true* rather than tuned-for-today.

- [ ] **Native thermal input**: tiny Capacitor plugin exposing
      `ProcessInfo.processInfo.thermalState` + change notifications (same
      `packageClassList` pattern as the haptics plugin). This is the *reliable* signal.
- [ ] **Web fallback signal**: long-window fps degradation. ⚠ Verified caveat: rAF
      timestamps are vsync-quantized on iOS — a GPU at 95 % load still reports
      ~16.7 ms — so frame-time EMA only detects *sustained* misses. Use missed-vsync
      ratio over 10 s windows, not instantaneous ms.
- [ ] **Governor offset, NOT `setQuality()`**: setQuality persists to localStorage
      ([main.js:72](src/main.js:72)) and would clobber the user's chosen tier. Keep a
      separate non-persisted offset that drives the knobs directly, clamped so recovery
      never exceeds the user's tier.
- [ ] **Step-down ladder** (all pre-existing state, no recompiles):
      1. pixelRatio −0.15 steps (floor 1.0)
      2. shadow cadence ×2 (floor: dirty-only)
      3. FX scale (smoke spawn/grow, rain count — Phase 6 wires these to a scalar)
      4. visualRing −1 (via the existing `world.setQuality`-style path)
      5. fps target 60 → 45 → 30
      Policy: `thermalState ≥ serious` or sustained fps deficit → step down one rung
      per 10 s; `nominal` for 60 s → step up one rung, never above the user's tier.
      Show a subtle HUD hint ("cooling") so it never feels like mystery jank.
- [ ] iOS Low Power Mode: rAF drops to ~30 Hz — ensure dt handling stays smooth
      (cap exists at [main.js:468](src/main.js:468); verify physics substeps don't spiral).

---

### Phase 5 — CPU / GC sweep (S items, bundled into one PR)

Main-thread heat: individually small, together ~2–5 ms/frame on old phones.

- [ ] **Memoize `ownedEdges(seed,cx,cz)`** in worldgen.js with a ~256-entry LRU Map
      (deterministic pure function — caching can't break determinism). `describeChunk`
      currently re-derives the road network **26×** per chunk build
      ([worldgen.js:116](src/worldgen.js:116)): ~1,400–1,600 transient `{x,z}` objects +
      ~2,800–3,200 cubic evals per activation. Add a precomputed per-edge AABB
      (inflated by roadClear) to early-out `distToEdges`. ⚠ Cached arrays are returned
      by reference and carry the `_nodes` expando — document immutability (current
      callers already comply).
- [ ] **Cache fixed-shape landmark geometries** (skidpad/park/gate/lookout prototypes) —
      rebuilt + disposed on every activation despite being deterministic.
- [ ] **Time-slice unload**: ~9–11 chunks torn down in one frame today, each mesh
      check-in doing an O(726) linear scan. Slice like builds (1–2/frame) and index the
      pool free-list.
- [ ] **Touch: classify once at touchstart** ([input.js:113](src/input.js:113)) via the
      existing `elementFromPoint`, store per `touch.identifier`
      ('boost' | 'ui' | 'zone'), and on touchmove skip the DOM query entirely (zones
      are pure math via gameCoords). ⚠ Don't cache rects — #settings/#startScreen move
      via transforms without resize events. Removes up to ~360 forced hit-tests +
      ~120 layout flushes/s during all of mobile gameplay.
- [ ] **`matrixAutoUpdate = false` for static chunk subtrees** — ~470 static Object3Ds
      recompose local matrices + rewrite matrixWorld every frame, twice when the shadow
      pass runs. Set matrices once at build; keep auto only on car/rings/beacon/particles.
- [ ] **Skid-mark partial uploads**: ring buffer re-uploads the full 50 KB attribute per
      rear wheel per frame while drifting — use `addUpdateRange` around the written span.
- [ ] **`gather()` allocation reuse** ([chunks.js](src/chunks.js)): reuse collider objects
      in the pooled `_colOut` arrays instead of ~1,000 fresh literals per crossing.
- [ ] **trials.updateHud**: only rewrite `innerHTML` when ring index changes; the
      per-frame timer text goes in a cached text node ([trials.js:84](src/trials.js:84)).
- [ ] **Compass**: keep 4 Hz rebuild, but cache per-arrow transform strings (quantized)
      — 240 inline style writes/s today ([hud.js:124](src/hud.js:124)).
- [ ] **Achievements**: throttle predicate scan (23 predicates + fresh stats object per
      frame) to 4 Hz — event-driven ones already fire via `ach.event`.
- [ ] **updatePosts** ([world.js](src/world.js)): hoist the 3 Matrix4 + 1 Vector3 temps;
      early-out when no post is animating.
- [ ] Consolidate the 2–3 full records-Map proximity scans per frame (onProcGate /
      trials circuitNear / onProcCircuit) into one shared nearest-landmark result
      computed at the existing throttle cadence.

---

### Phase 6 — Platform polish & leftovers (S, low individual impact)

- [ ] **disposeCar GPU texture leak**: ~16.8 MB leaked per car-selector switch
      (textures never disposed) — unbounded across a session spent browsing cars.
- [ ] **Car GLB warm-up**: the selected car's shader compiles mid-frame after boot,
      bypassing the `renderer.compile` warm-up (a hitch, and an invariant violation in
      spirit) — compile the car materials at boot too.
- [ ] **Audio on hidden web page**: engine/skid drone + the 60 ms generative timer keep
      running in background tabs; suspend the AudioContext on `visibilitychange`/
      `pagehide`, resume on show ([audio.js](src/audio.js)). (Audio was otherwise
      exonerated — the graph is small; muted still renders, so also gate the keep-alive.)
- [ ] **Service worker**: network-first re-downloads radio MP3s mid-game on the web
      PWA — cache-first for `vendor/` + radio assets ([sw.js](sw.js)).
- [ ] **fps cap remainder-carry** ([main.js:465](src/main.js:465)):
      `lastFrameTime += targetFrameMs` (with drift clamp) instead of
      `lastFrameTime = now` — fixes Low's "45" rendering as 30/40 and makes any future
      30-fps governor step actually deliver 30.
- [ ] **Boost speed-lines**: full-viewport `mix-blend-mode` gradient with an infinite
      scale animation — gate it to boost duration only (it already is visually) and
      ensure the animation is fully removed (not opacity-0) when idle.
- [ ] **FX tier scaling**: wire smoke spawnRate/grow and `WEATHER.rainCount` to the
      quality tier (and the governor's FX scalar) — fixed constants today.
- [ ] Junction pads: merge into the chunk road-surface geometry (same material, free
      draw-call removal). Landmark builders: merge small static boxes per landmark
      (slalom 14 draws → 1–2, lookout 5 → 2). Home region: share the 10 duplicate
      light-pole materials.

---

## 3. Expected cumulative impact

| Phase | Sustained GPU | Main-thread CPU | Risk |
|---|---|---|---|
| 1 | −40–55 % (High), −20–30 % (Medium) | −1–3 ms/frame (DOM) | Low — config + toggles |
| 2 | shadow pass 60/s → 8–15/s, each pass cheaper | — | Medium — visual QA on shadows |
| 3 | −40–60 % main-pass ALU on Med/Low; car 3–4× cheaper | — | Medium — material twins need warm-up QA |
| 4 | bounds worst case on every device | negligible | Medium — policy tuning |
| 5 | — | −2–5 ms/frame on old phones | Low |
| 6 | small | small | Low |

Phases 1+2+3 together target the ~101 M heavy-fragments/s + ~252 M shadow-texels/s
steady state down to roughly a third on High — which is the difference between
"hand-burning at 20 min" and "warm". Phase 4 makes it degrade gracefully everywhere else.

## 4. Verification per phase

1. `npm test` (worldgen determinism must survive memoization — Phase 5 especially).
2. Desktop preview instrumentation (the Phase 0 counters): shadow passes/s at
   parked/driving × High/Medium, draw calls, geometry churn, heap.
3. Visual QA: shadow shimmer at texel-snap cadence (Phase 2), Lambert vs Standard
   side-by-side per preset (Phase 3), fog-edge pop at dawn (Phase 1 ring change).
4. Device soak (the Phase 0 protocol) — the acceptance gate is the iPhone 13 @ Medium
   10-min soak with no thermal throttle, and iPhone 17 Pro Max @ High merely warm.
