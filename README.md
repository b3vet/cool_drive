# CoolDrive 🚗💨

A drift-focused 3D arcade driving game built with **three.js**, inspired by the calm low-poly vibe of slowroads.io / slowdrive.io and the combo-scoring of Drift Hunters.

**The whole point:** the car *almost drifts itself*. The handling is deliberately forgiving — slides auto-initiate and auto-stabilize, so a first-time player can hold a long, photogenic, scoring drift without fighting the wheel.

## Run it

No build step. Just serve the folder over HTTP (ES modules need a server, not `file://`):

```bash
npm start          # -> http://localhost:5173
# or: node server.js 8080
```

Then open the URL and press **DRIVE**.

## Controls

| Key | Action |
|-----|--------|
| `W` / `↑` | Accelerate |
| `S` / `↓` | Brake / reverse |
| `A` `D` / `← →` | Steer |
| `Space` | Handbrake (kick the rear out) |
| `Shift` | Boost (spend a full meter, filled by drifting) |
| `C` | Cycle camera (chase / far / hood / overhead) |
| `P` | Cycle time of day (Golden / Dawn / Night) |
| `R` | Reset to spawn |
| `M` | Mute / unmute all sound |
| `Esc` | Settings (fine-tune feel + view achievements) |

Touch controls (joystick + buttons) appear automatically on touch devices.

## Cars, modes & achievements

The start screen lets you pick a **driving mode** — **PRO** (default: low grip, light assist,
slidey) or **SIMPLE** (grippy, forgiving) — and one of **three cars** (Falcon GT / Night Viper /
Brute V8), each with a distinct silhouette and light stat differences. Both are defined as data in
`config.js` (`PROFILES`, `CARS`), so adding cars or modes is just data.

**Achievements** (14 of them) unlock as you play and persist in `localStorage`
(`cooldrive.achievements`); view them in Settings. They animate in as toasts, and completing a big
combo or beating your best fires a celebration.

## Sound & radio (no audio files needed)

All SFX (engine, tyre skid, boost, crash, UI, chimes) are **synthesized at runtime** with the Web
Audio API — zero asset files. The **radio** defaults to a built-in **generative music station**
(also synthesized, no files, no licensing). To add real music, append entries to `RADIO_STATIONS`
in `src/audio.js`:

```js
export const RADIO_STATIONS = [
  { name: 'CoolDrive FM', generative: true },     // built-in, no files
  { name: 'My Mix', url: 'https://cdn.example.com/mix.mp3' },  // your file or a stream URL
];
```

URL stations stream through an `<audio>` element, so host them on cheap object storage / a CDN or
point at an internet-radio stream — you never have to serve large files off your VPS.

## How to drift

- **Throttle + steer** at speed → the rear eases out into a held ~18° four-wheel slide.
- **Handbrake + steer** → break traction hard for a dramatic ~34° drift.
- **Flick** the steering left↔right to chain drifts — the combo multiplier keeps climbing
  (a 1.1s grace window bridges transitions). Straighten out to bank the points.
- Drifting fills the **boost** meter; spend it with `Shift` for a speed burst.

Soft failure only: a hard wall crash drops your *pending* combo, never your banked score. There's no game-over.

## The physics (why it "drifts itself")

A hand-rolled kinematic arcade model (`src/physics.js`), no physics engine. Each fixed
1/120s step:

1. **Decompose** world velocity into forward/lateral components in the car's frame.
2. **Engine/brake** acts on forward; **grip** scrubs the lateral component
   (high grip = stuck, low grip = slide). Dropping rear grip is what starts a drift.
3. **Recompose** world velocity using the *old* heading — so velocity lags the car.
   That lag *is* the drift.
4. **Yaw** = a grip-limited **bicycle model** (turn radius widens with speed, like a real car —
   tight at low speed, wide at high speed) **+ a drift-assist restoring torque** that
   auto-counter-steers toward the velocity vector, plus yaw damping and a hard slip-angle
   clamp (~49°). Gentle steering grips and carves; a drift needs commitment (or the handbrake)
   and then bleeds speed so it settles into a stable, photogenic angle instead of spinning out.

Tunables live in `src/config.js`. The model was verified headless (`node test_physics.mjs`):
the donut sustains indefinitely, holds speed, survives full-lock flick transitions without
spinning, and recovers to 0° slip on release.

## Architecture

```
index.html        importmap (three@0.160.0, jsDelivr) + DOM HUD + start/settings UI
server.js         zero-dependency static dev server
src/
  config.js       ALL tunables: physics, palette, camera, scoring, presets, CARS, PROFILES
  physics.js      pure stepPhysics() integrator + drift assist (no three.js dep -> testable)
  scene.js        renderer, gradient-sky shader, sun/moon disc, stars, lights, fog
  car.js          selectable low-poly cars (buildCar(def)); spoked wheels, chassis roll/pitch
  world.js        open road network, collidable obstacles + knock-over posts, atmosphere
  input.js        keyboard + touch joystick, sampled into one struct/frame
  camera.js       spring chase cam, drift framing, FOV punch, 4 view modes
  effects.js      skid-mark ribbons (ring buffer) + smoke (custom Points shader)
  scoring.js      combo multiplier, grace window, banking; SCORE = session total, BEST = best single drift (localStorage)
  audio.js        Web Audio SFX (synth, no files) + generative radio + URL stations
  achievements.js localStorage-persisted achievements with a stats/event API
  hud.js          DOM overlay, combo/best celebrations, achievement toasts, radio label
  main.js         bootstrap + fixed-timestep loop; wires modes, cars, audio, achievements
test_physics.mjs  headless physics regression test
```

## Notes

- Single-player, local high score. Multiplayer is out of scope for v1.
- Tested in Chromium. Needs WebGL2 and ES-module / importmap support (all evergreen browsers).
