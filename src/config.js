// ============================================================================
// config.js — ALL tunables live here. The "feel" of the game is iterated here.
// Units are roughly metric: meters and meters/second. Heading is radians.
// Car forward = local -Z. Heading h rotates the car group about +Y.
//   forward vector  F = (-sin h, 0, -cos h)
//   right   vector  R = ( cos h, 0, -sin h)
// ============================================================================

// ---- Physics: the drift model ----------------------------------------------
export const PHYS = {
  STEP: 1 / 120, // fixed physics timestep (s). 120Hz for rock-solid drift.

  // Drivetrain (accelerations, m/s^2)
  engine: 22, // throttle forward acceleration
  brake: 15, // brake deceleration (~1.5g) — firm but not a dead stop
  maxSpeed: 54, // forward speed cap (m/s) ~195 km/h
  maxReverse: 15, // reverse speed cap (m/s)
  linearDrag: 0.1, // passive coast decay (fraction/s) — gentle, like lifting off the gas
  rollingDrag: 1.4, // extra decay applied near-idle to settle the car to a stop

  // Steering — realistic bicycle model. Turn radius = wheelbase/tan(steer) at low
  // speed, but grip-limited (maxLatAccel) at speed so the radius widens like a real car.
  maxSteer: 0.58, // max wheel angle (rad) ~33 deg (tight low-speed lock)
  steerSpeedFalloff: 0.28, // mild — most speed-widening comes from the grip cap now
  steerInputRate: 6.0, // how fast steer ramps toward target (1/s)
  steerReturnRate: 9.0, // how fast wheel auto-centers with no input (rad/s)
  maxLatAccel: 17, // max lateral accel while gripped (m/s^2, ~1.7g) -> speed-based radius

  // Grip = rate at which lateral (sideways) velocity is scrubbed (1/s).
  // High grip = sticky/gripped. Low grip = the rear slides = drift.
  gripNormal: 7.0, // gripped driving
  gripDrift: 0.8, // while drifting (lower = slidier) -> ~18 deg throttle donut
  handbrakeGrip: 0.45, // rear grip while handbrake held (very loose) -> ~34 deg slides
  gripBlendRate: 7.0, // how fast grip lerps between normal<->drift (1/s)
  handbrakeDrag: 0.07, // handbrake barely slows you — it's for breaking traction, not stopping

  // Drift initiation
  minDriftSpeed: 7, // below this speed, no drift triggers (m/s)
  driftSteerThreshold: 0.24, // need a committed steer angle (rad) to power-slide
  driftSlipFactor: 1.45, // drift starts when yaw demand exceeds grip cap by this much
  driftYawMul: 1.7, // while drifting, yaw cap = latCap * this (bounded, controllable angle)
  driftScrub: 0.6, // forward speed drag while sliding (sideways-tyre scrub) — settles the angle

  // ---- Drift ASSIST: the "drives itself" magic ----
  kAssist: 1.6, // restoring torque toward velocity dir (counter-steer assist)
  maxAssist: 2.2, // clamp on assist yaw contribution (rad/s)
  yawDamping: 3.4, // angular velocity response/damping (1/s) — kills oscillation
  maxYawRate: 3.4, // hard clamp on yaw rate (rad/s) — allows tight low-speed + drift kicks
  maxDriftAngle: 0.86, // hard clamp on slip angle (rad) ~49 deg — no death spins

  // Chassis dimensions (for yaw + visuals)
  wheelbase: 2.6,
  wheelRadius: 0.42, // for wheel-spin visuals (rolling = v / radius)

  // Boost
  boostFill: 0.30, // boost meter filled per second of drifting (intensity-scaled)
  boostDrain: 0.5, // boost meter drained per second while boosting
  boostSpeedMul: 1.28, // top speed multiplier while boosting
  boostAccelMul: 1.6, // engine accel multiplier while boosting
};

// ---- Graphics quality presets (reduce GPU load / heat) ---------------------
// pixelRatio is capped against the device ratio. shadow = shadow-map size.
// fps caps the render rate (skips frames above it). shadowEvery throttles how
// often the shadow map re-renders (every Nth frame).
export const QUALITY = {
  high: { label: 'High', pixelRatio: 2, shadow: 2048, fps: 60, shadowEvery: 1 },
  medium: { label: 'Medium', pixelRatio: 1.5, shadow: 1024, fps: 60, shadowEvery: 2 },
  low: { label: 'Low (cool & quiet)', pixelRatio: 1, shadow: 512, fps: 45, shadowEvery: 3 },
};
export const DEFAULT_QUALITY = 'medium';

// ---- Difficulty profiles (chosen on the start screen) ----------------------
// PRO is the default: low grip, light assist — slidey and rewarding.
// SIMPLE is forgiving: more grip, strong auto-counter-steer assist.
export const PROFILES = {
  pro: {
    label: 'PRO',
    blurb: 'Barely any assist, low grip. Raw and twitchy — countersteer is on you.',
    gripNormal: 5.2,
    gripDrift: 0.55,
    handbrakeGrip: 0.35,
    kAssist: 0.2,
    driftSlipFactor: 1.25,
    driftYawMul: 1.9,
  },
  simple: {
    label: 'SIMPLE',
    blurb: 'Grippy and forgiving. Strong auto-counter-steer keeps you pointing the right way.',
    gripNormal: 7.0,
    gripDrift: 0.85,
    handbrakeGrip: 0.5,
    kAssist: 1.7,
    driftSlipFactor: 1.5,
    driftYawMul: 1.6,
  },
};

// ---- Selectable cars (cosmetic silhouette + light stat flavour) -------------
export const CARS = [
  {
    id: 'falcon',
    name: 'Falcon GT',
    tag: 'Balanced all-rounder',
    color: 0xe8463a,
    accent: 0x20232c,
    bodyW: 1.85, bodyL: 4.0, bodyH: 0.5, ride: 0.34,
    cabinW: 1.5, cabinL: 1.9, cabinH: 0.5, cabinZ: -0.15,
    nose: 'tapered', wing: 'medium', scoop: false, wheel: 0.42,
    engineMul: 1.0, speedMul: 1.0, gripMul: 1.0,
  },
  {
    id: 'viper',
    name: 'Night Viper',
    tag: 'Low, fast, slippery',
    color: 0x16c9b6,
    accent: 0x0c1a1d,
    bodyW: 1.92, bodyL: 4.35, bodyH: 0.42, ride: 0.28,
    cabinW: 1.42, cabinL: 1.55, cabinH: 0.42, cabinZ: -0.32,
    nose: 'sharp', wing: 'big', scoop: false, wheel: 0.44,
    engineMul: 1.12, speedMul: 1.12, gripMul: 0.9,
  },
  {
    id: 'brute',
    name: 'Brute V8',
    tag: 'Heavy muscle, big slides',
    color: 0xf0a020,
    accent: 0x2a2018,
    bodyW: 2.02, bodyL: 4.35, bodyH: 0.6, ride: 0.4,
    cabinW: 1.6, cabinL: 1.8, cabinH: 0.55, cabinZ: 0.05,
    nose: 'blunt', wing: 'none', scoop: true, wheel: 0.46,
    engineMul: 1.08, speedMul: 0.96, gripMul: 1.12,
  },
];

// ---- Visual feel (wheel spin, body roll/pitch) -----------------------------
export const VIS = {
  launchSpin: 22, // extra wheel-spin (rad/s) at full throttle from low speed (burnout feel)
  rollMax: 0.16, // max body roll into a turn/slide (rad ~9 deg)
  pitchMax: 0.07, // max nose dive/squat under brake/accel (rad ~4 deg)
  bodyLerp: 7, // how fast the chassis leans toward its target (1/s)
};

// ---- Scoring ---------------------------------------------------------------
export const SCORE = {
  minSlipDeg: 11, // ignore slip below this (deg) — wobble isn't a drift
  speedRef: 14, // speed normaliser for points (m/s)
  pointsRate: 16, // base points scalar
  comboPerSecond: 0.12, // multiplier gained per continuous second drifting
  comboMax: 10, // multiplier cap
  graceTime: 1.1, // seconds you can be straight before combo banks/resets
};

// ---- Camera ----------------------------------------------------------------
export const CAM = {
  fov: 70,
  fovBoost: 78, // FOV while boosting / at high speed
  // chase offsets (car-local, forward is -Z so behind is +Z)
  behind: 6.2,
  up: 3.0,
  lookAhead: 6.0,
  lookUp: 1.0,
  posDecay: 0.0016, // position lerp base (smaller = more lag/spring)
  lookDecay: 0.0009, // look-target lerp base (lags more than position)
  driftFrame: 2.6, // lateral camera offset while drifting (units)
};

// ---- World -----------------------------------------------------------------
export const WORLD = {
  groundSize: 2400, // huge ground plane (fog hides the far edge)
  boundary: 680, // soft circular boundary radius — gently turns you back, no crash
  roadWidth: 18, // drift-friendly road width (units)
  shadowRadius: 150, // sun-shadow frustum half-size; follows the car
  carRadius: 1.5, // car collision radius for hitting solid objects
  hitRestitution: 0.35, // bounce off solid objects
};

// ---- Time-of-day visual presets -------------------------------------------
// Horizon color MUST equal fog color MUST equal clear color so the edge vanishes.
export const PRESETS = {
  golden: {
    name: 'Golden Hour',
    skyTop: 0x3a59a8,
    skyHorizon: 0xf6b878,
    sun: 0xfff0d2,
    sunIntensity: 1.7,
    hemiSky: 0xbcd6ff,
    hemiGround: 0x8a6a42,
    hemiIntensity: 0.85,
    fog: 0xf6b878,
    fogNear: 130,
    fogFar: 620,
    sunPos: [-60, 64, -30],
    groundColor: 0x4a4f60,
    neon: 0x33e0a1,
  },
  dawn: {
    name: 'Cool Dawn',
    skyTop: 0x1b2550,
    skyHorizon: 0xbcd0e8,
    sun: 0xdfe9ff,
    sunIntensity: 1.0,
    hemiSky: 0xbcd0e8,
    hemiGround: 0x4a5260,
    hemiIntensity: 0.7,
    fog: 0xbcd0e8,
    fogNear: 140,
    fogFar: 640,
    sunPos: [50, 55, 30],
    groundColor: 0x40454f,
    neon: 0x4ad6ff,
  },
  night: {
    name: 'Neon Night',
    skyTop: 0x0a1130,
    skyHorizon: 0x27407a,
    sun: 0xb4c8ff,
    sunIntensity: 0.95,
    hemiSky: 0x4257a0,
    hemiGround: 0x14182c,
    hemiIntensity: 0.7,
    fog: 0x27407a,
    fogNear: 100,
    fogFar: 520,
    sunPos: [40, 70, -50],
    groundColor: 0x2c3252,
    neon: 0x44ffd6,
  },
};

// ---- Car palette -----------------------------------------------------------
export const CAR_COLORS = {
  body: 0xe8463a,
  cabin: 0x1d2230,
  glass: 0x2a3550,
  wheel: 0x15171c,
  rim: 0x9aa0ad,
  light: 0xffe7a8,
  brake: 0xff3b30,
};

export const SKID = {
  color: 0x1a1a1f,
  opacity: 0.5,
  maxSegments: 700, // per rear wheel (ring buffer)
  y: 0.025, // lift above ground to avoid z-fight
};

export const SMOKE = {
  max: 260, // particle pool size
  color: 0xdfe3ea,
  spawnRate: 90, // particles/sec at full intensity
  life: 1.1, // seconds
  rise: 2.2, // upward velocity
  grow: 2.4, // size growth per second
  startSize: 0.7,
};
