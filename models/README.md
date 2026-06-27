# Car models

Drop your **`.glb`** (binary glTF) car models here, then point a car at one in
`src/config.js` (the `CARS` array) by adding a `modelUrl`:

```js
{
  id: 'falcon', name: 'Falcon GT', tag: 'Balanced all-rounder',
  color: 0xe8463a, accent: 0x20232c,
  bodyW: 1.85, bodyL: 4.0, bodyH: 0.5, ride: 0.34, wheel: 0.42,
  engineMul: 1.0, speedMul: 1.0, gripMul: 1.0,
  modelUrl: './models/falcon.glb',   // <-- use the imported model instead of the primitive car
  modelRotation: 0,                  // Y rotation (radians) so the FRONT faces -Z (see below)
  // modelScale: 1.0,                // optional: override the auto-fit scale
}
```

## Requirements

- **Format:** `.glb` (binary glTF — single file with geometry + materials + textures).
  Not `.obj`/`.fbx`/`.blend` — convert those to `.glb` first.
- **Orientation:** the game's forward is **−Z**. The loader auto-centres the model and
  drops it onto the ground, but it can't guess which way it faces. Set `modelRotation`:
  - front already faces −Z → `0`
  - front faces **+Z** (toward camera) → `Math.PI`
  - front faces **+X** → `-Math.PI/2`
  - front faces **−X** → `Math.PI/2`
- **Scale:** auto-fitted to the car's `bodyL` (~4 units). Override with `modelScale` if needed.
- **Poly budget:** keep it reasonable (under ~50k triangles) for smooth performance.
- The body **leans and pitches** with the physics; for GLB cars the wheels don't spin
  individually (that needs separately-named wheel nodes — ask and I'll wire it).
