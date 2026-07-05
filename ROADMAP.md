# CoolDrive Roadmap

Living document. The current batch sits at the top with a link to its implementation
plan; candidates below are roughly ordered by leverage; shipped history at the bottom.
Effort: **S** (<1 day) / **M** (a few days) / **L** (a week+).

## Now — Batch 2: "Purpose & Juice" (in progress)

Implementation plan: **[FEATURES_PLAN.md](FEATURES_PLAN.md)**

| # | Feature | Area | Effort | Why |
|---|---------|------|--------|-----|
| 1 | Beacon compass (home + nearest-landmark arrows) | HUD / world | M | Landmarks become findable — unlocks all exploration value |
| 2 | Near-miss + transition (link) scoring | scoring / feel | M | Props become risk/reward; chaining S-curves becomes the high-score path |
| 3 | iOS haptics (crash / bank / link / boost) | platform | S | Tactile payoff on the primary platform — currently zero haptics |
| 4 | Boost overdrive FX (speed lines, exhaust flames, tinted smoke) | presentation | S | Boost is a core reward loop but nearly invisible today |
| 5 | Region naming + "new region" discovery toast | world | S | Cheapest possible sense of place; gives distance texture |
| 6 | Circuit ring time-trials + new landmark kinds (ramp park, gate, lookout) | world | M | Landmarks gain repeatable purpose + navigation anchors |
| 7 | Rain weather + wet grip | atmosphere / physics | M | Surface variety that changes the *drift*, not just the look |
| 8 | Automatic day/night cycle (preset lerp) | atmosphere | M | Long sessions get visual progression; UI accent breathes with the sky |
| 9 | Fix: stale shadow map on chunk activation / rebase | perf / correctness | S | Live visual bug on the streaming path (plan §8 item, never wired) |
| 10 | Fix: consolidate double PointLight pool (10 → ≤5) | perf | M | Daytime per-fragment cost on A15; restores the plan's hard light cap |

## Next — strong candidates

- **Drift Cred currency + garage unlock** — skim a wallet off `bank()`, lock 2 of the 3 cars; first-session goal + retention backbone [S+M · high]
- **Daily Challenge** — date-derived shared seed, 90 s timed run, offline personal best (de-facto worldwide leaderboard) [M · high]
- **Collectible drift crates** at landmarks — persistent like knocked cones, gold rares gated by distance from home [M · high]
- **Session Runs + results card** — pick a goal, get an end screen (score / best chain / Cred / share) [M · high]
- **Impact camera kick + spark burst** on hard crashes — crashes are currently visually silent [M · high]
- **Photo mode + native share** — showcase cam, HUD hide, watermark, share sheet (`preserveDrawingBuffer`) [S · med]
- **Delivery / checkpoint runs** between landmarks — turns the road grid into routes [L · high]
- **Style multipliers** (angle / speed / handbrake-init) + drift-entry "clutch kick" punch [M · med]
- **Per-car engine voices** + impact SFX variety; **radio crossfade + music ducking** on big banks [M · med]
- **Gentle procedural elevation + crested jumps** — biggest "driving out feels different" lever; highest risk (physics stays 2D, render-Y follows a height field) [L · high]
- **M4 leftover: authored gateway roads** docking home ↔ procedural grid (removes the seam; guarantees a drivable route home) [L]
- **Tree distance-LOD** — canopy-only / billboard beyond the inner ring [M]
- **camera.far = fogFar × 1.05 per preset** — needs the sky dome pinned/following first [S]
- **Opt-in adaptive quality safety net** ("Auto-cool": steps one tier down on sustained low fps, never up) [M]
- **Liveries / color customization** as a Cred sink [M]
- **Game Center** leaderboards + achievement mirroring [L]
- **Spatialized landmark audio beacons** + fog-lit light shafts [L]
- **Analog keyboard steer** + countersteer "catch" feel on desktop [S]

## Validation debt

- **On-device soak**: iPhone 13, ≥10 min per quality tier, Xcode memory gauge ≤300 MB
  (use the perf HUD: backtick key or `?hud`)
- **Offline smoke test** on device (airplane mode; SW-cached boot)
- M4 polish: junction-pad ribbon trimming (pads currently overlay untrimmed ribbons)

## Shipped

- `0a39821` — **endless procedural world**: seed-per-session streaming chunks, floating-origin
  rebase, road super-grid with drift archetypes + junctions, biomes, landmarks
  (circuits/towns/slaloms/skidpads); procedural achievements; far-from-home respawn;
  wild-cone persistence; night-lit circuits; instanced home city + merged road draws;
  zero-alloc sim loop; shader warm-up; worldgen determinism test; dev perf HUD;
  3 new radio tracks; iOS build 5
- `fe10521` and earlier — mobile web UX, audio interruption fixes, design system pass
  (DESIGN.md), Tripo-AI car models, radio (generative + playlists), 3 cars,
  Pro/Simple modes, achievements, time-of-day presets
