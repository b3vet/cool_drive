# Thermal / performance issue — to address later

> **Update:** the full audit ran and the plan now lives in
> **[OPTIMIZATION.md](OPTIMIZATION.md)** — including verified verdicts on every
> suspect below (some confirmed, some redirected, some exonerated). This file is
> kept as the original repro/context record.

**Deferred.** Captured during playtest so we don't lose the context. This is the big
optimization pass promised in ROADMAP.md's validation debt.

## Repro (device report)

- **Device:** iPhone 17 Pro Max (latest, top-tier) — Safari, latest web build.
- **Symptom:** phone near hand-burning hot after ~20 min of play.
- **Session shape:** ~30 km travelled, driving *straight ahead non-stop, no turning* —
  i.e. a constant stream of new-chunk generation along the path.
- **Graphics:** ~half in High, ~half in Medium.

That an A19-class phone gets this hot means we have a real steady-state cost problem,
not a spike. Straight-line travel is the worst case: chunks load/build/unload every
second forever, and nothing behind is ever revisited.

## Prime suspects to investigate (rough priority)

1. **Shadow map re-render on every chunk activation.** `renderer.shadowMap.autoUpdate`
   is off and we throttle to every Nth frame — BUT the `shadowDirty` flag (added for the
   stale-shadow fix) forces `needsUpdate = true` on *every* chunk activation. Driving
   straight non-stop activates a chunk roughly every frame or two, so the shadow map is
   effectively re-rendering continuously (2048² / 1024² depth pass), defeating the
   throttle. Combined with `trackSun` panning the shadow camera every frame, this is the
   single most likely heat source. Fix idea: coalesce — mark dirty but still honour a
   *minimum* interval, or only force on rebase (not per-activation), or render shadows to
   a smaller/cascaded map.
2. **Per-chunk geometry build churn.** Every proc chunk creates + disposes BufferGeometry
   for roads/edges/landmarks (time-sliced, but continuous while moving). Straight-line =
   never-ending allocate→upload→dispose. Consider caching/pooling road ribbon geometry,
   or coarser far-chunk geometry.
3. **No scenery LOD.** Trees (trunk+canopy, cap 110/chunk) render full geometry to the
   full visual ring (~1 km). Distance LOD / billboards would cut vertex + draw load.
4. **Draw calls + overdraw.** Re-measure ground-level draw calls while streaming; the
   dev HUD (backtick / `?hud`) reports calls/tris/geo/queue live — use it on-device.
5. **Frame-rate cap.** Confirm the fps cap actually holds on ProMotion (120 Hz) displays;
   an uncapped or 120-fps loop doubles everything.
6. **Per-frame O(records) scans.** compass (4 Hz), `assignLights` (throttled), gate/town
   checks — cheap individually but they iterate ~120 records; verify none slipped to
   per-frame at full rate.
7. **Fixed pool footprint.** 121 slots × {trunk,canopy,rock,bush} InstancedMeshes are
   resident forever (~3 MB matrices + GPU buffers) — memory, not heat, but worth a look
   during the memory soak.
8. **Point lights / PBR.** Now 5 shadowless point lights + MeshStandardMaterial
   everywhere; measure fragment cost, consider MeshLambert or cheaper shading for the
   low tier.

## Method when we tackle it

Measure first (dev HUD + Xcode GPU/energy gauges on a real device), find the dominant
cost, fix that one, re-measure. Don't blind-optimize. Target: no thermal throttle over a
10-min straight-line soak on iPhone 13 at Medium.
