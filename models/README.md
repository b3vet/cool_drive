# Car models

The three shipping cars use AI-generated **wheel-less** low-poly bodies (Tripo **P1**)
plus the game's own procedural wheels dropped into the arches (they spin + steer). Point
a car at a `.glb` in `src/config.js` (the `CARS` array):

```js
{
  id: 'falcon', name: 'Falcon GT', tag: 'Balanced all-rounder',
  color: 0xe8463a, accent: 0x20232c,
  bodyW: 1.85, bodyL: 4.0, bodyH: 0.5, ride: 0.34, wheel: 0.42,
  engineMul: 1.0, speedMul: 1.0, gripMul: 1.0,
  modelUrl: './models/falcon_gt.glb', // use the imported body instead of the primitive car
  modelRotation: Math.PI / 2,         // Y rotation so the FRONT faces -Z (see below)
  // procedural wheels placed symmetrically in the (wheel-less) body's arches:
  wheelSize: 0.32,                    // wheel radius (game units)
  wheelTrack: 0.60,                   // L/R offset, fraction of body half-WIDTH
  wheelBase: 0.66,                    // F/R offset, fraction of body half-LENGTH
  // modelScale: 1.0,                 // optional: override the auto-fit scale
  // flatShading: false,              // optional: keep smooth shading for this car
  // wheels: false,                   // optional: no procedural wheels (body has its own)
}
```

## Why wheel-less bodies?

Tripo bakes the tyres **into one merged, fragmented mesh** — they can't be separated in
code to spin them (tried topology/spatial/colour carves; all destroy the body). So the
bodies are generated **without wheels** (empty arches) and the game adds real
spinning/steering wheels. This also fixes the tyres-lift-off-the-ground problem: the
procedural wheels live on the car **root**, not the rolling chassis.

## Requirements

- **Format:** `.glb` (binary glTF — geometry + materials + textures in one file).
- **No tyres:** paint the wheels out of the source image first (leave empty wheel arches),
  or the AI bakes them in. See "Generating models" below.
- **Orientation:** the game's forward is **−Z**. The loader auto-centres + grounds the
  model but can't guess facing. Set `modelRotation` (radians): front faces −Z → `0`;
  +Z → `Math.PI`; **+X → `Math.PI/2`** (what our Tripo cars need); −X → `-Math.PI/2`.
  Unsure? Open `model_viewer.html` (dev-only, repo root) on the dev server:
  `…/model_viewer.html?model=./models/falcon_gt.glb&rot=0.5` (`rot` is in units of π).
  Yellow arrow = forward (−Z); click **front** and the nose should face the camera.
- **Wheels:** tune `wheelSize` / `wheelTrack` / `wheelBase` per car so they fill the arches
  (front wheels steer, all spin, all stay planted through body roll).
- **Poly budget:** keep under ~50k triangles. P1 comes out ~5k — no decimation needed.
- **Cache-busting:** the dev server / CDN caches `.glb` for a week. After changing any model
  file, bump `MODEL_VER` in `src/car.js` so clients refetch.

## Generating models with Tripo AI

Made image→3D with the [Tripo](https://platform.tripo3d.ai) API. **P1** (`model_version:
"P1-20260311"`) is the low-poly model — best-in-class for this cubic aesthetic, ~50 credits
per model (v2.5 is ~30 but soft/high-poly). Flat shading is applied automatically at load.

0. **Remove the wheels** from the reference PNG (empty wheel arches). A human editor does
   this far more reliably than automated fills.
1. **Upload** (free): `POST /v2/openapi/upload`, multipart field `file` → `{data:{image_token}}`.
2. **Create** (spends credits):
   ```bash
   curl -X POST https://api.tripo3d.ai/v2/openapi/task \
     -H "Authorization: Bearer $TRIPO_KEY" -H "Content-Type: application/json" \
     -d '{"type":"image_to_model","model_version":"P1-20260311","file":{"type":"png","file_token":"<token>"}}'
   ```
3. **Poll** `GET /v2/openapi/task/<id>` until `status == "success"`; download
   `data.output.pbr_model`. Balance: `GET /v2/openapi/user/balance`.
4. **Optimize** — P1 is already low-poly, so just shrink textures (keep all triangles):
   ```bash
   TRI_RATIO=1.0 scripts/optimize-car-model.sh models/_raw/car.glb models/car.glb
   # keeps ~5k tris, 2K textures -> 1K, ~900 KB -> ~600 KB
   # (for a high-poly v2.5 model instead, use TRI_RATIO=0.03 to decimate hard)
   ```
5. Raw outputs live in `models/_raw/` (git-ignored, excluded from the www bundle by
   `scripts/build-www.mjs`) so you can re-optimize without re-spending credits.
