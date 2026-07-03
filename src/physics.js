// ============================================================================
// physics.js — pure arcade drift integrator.
//
// The whole drift mechanic is here. Each fixed step:
//   1. decompose world velocity into forward/lateral (car-local) components
//   2. apply engine/brake to forward, grip-scrub the lateral component
//   3. RECOMPOSE world velocity using the OLD heading (velocity lags the car)
//   4. rotate heading by yaw = steering + drift-assist counter-steer
//   5. integrate position
// The mismatch between where the car points and where it travels IS the drift.
// ============================================================================

import { PHYS } from './config.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const moveToward = (cur, target, maxDelta) => {
  if (Math.abs(target - cur) <= maxDelta) return target;
  return cur + Math.sign(target - cur) * maxDelta;
};

// Create a fresh car physics state.
export function createCarState(x = 0, z = 0, heading = 0) {
  return {
    x,
    z,
    heading,
    vx: 0,
    vz: 0,
    steerAngle: 0,
    grip: PHYS.gripNormal,
    omega: 0, // current yaw rate (rad/s), retained for damping
    // derived/telemetry (read by effects, scoring, hud, camera)
    forwardSpeed: 0,
    lateralSpeed: 0,
    slip: 0, // signed slip angle (rad)
    speed: 0, // |velocity| (m/s)
    drifting: false,
    intensity: 0, // 0..1 drift intensity
    boost: 0, // boost meter 0..1
    boosting: false,
  };
}

// Advance the car state by one fixed timestep `dt`.
// `input` = { throttle, brake, steer(-1..1), handbrake, boost }
export function stepPhysics(s, input, dt) {
  const P = PHYS;

  // --- heading basis vectors -------------------------------------------------
  const sinH = Math.sin(s.heading);
  const cosH = Math.cos(s.heading);
  const fwdX = -sinH,
    fwdZ = -cosH;
  const rightX = cosH,
    rightZ = -sinH;

  // --- decompose current world velocity into car-local axes ------------------
  let vForward = s.vx * fwdX + s.vz * fwdZ;
  let vLateral = s.vx * rightX + s.vz * rightZ;
  const speed = Math.hypot(s.vx, s.vz);

  // --- steering: ramp toward a speed-scaled target, auto-center otherwise -----
  const speedFrac = clamp(Math.abs(vForward) / P.maxSpeed, 0, 1);
  const steerTarget = input.steer * P.maxSteer * (1 - P.steerSpeedFalloff * speedFrac);
  if (input.steer !== 0) {
    s.steerAngle += (steerTarget - s.steerAngle) * clamp(P.steerInputRate * dt, 0, 1);
  } else {
    s.steerAngle = moveToward(s.steerAngle, 0, P.steerReturnRate * dt);
  }

  // --- boost bookkeeping ------------------------------------------------------
  s.boosting = input.boost && s.boost > 0.02;
  if (s.boosting) s.boost = clamp(s.boost - P.boostDrain * dt, 0, 1);
  const speedCap = s.boosting ? P.maxSpeed * P.boostSpeedMul : P.maxSpeed;
  const accel = s.boosting ? P.engine * P.boostAccelMul : P.engine;

  // --- engine / brake on the forward component -------------------------------
  if (input.throttle) vForward += accel * dt;
  if (input.brake) {
    if (vForward > 0.5) vForward -= P.brake * dt; // braking
    else vForward -= P.engine * 0.6 * dt; // reverse from a near-stop
  }
  vForward = clamp(vForward, -P.maxReverse, speedCap);

  // passive drag (stronger near idle so the car settles cleanly)
  if (!input.throttle && !input.brake) {
    vForward *= 1 - P.linearDrag * dt;
    if (Math.abs(vForward) < 1.5) vForward *= 1 - P.rollingDrag * dt;
    if (Math.abs(vForward) < 0.05) vForward = 0;
  }
  if (input.handbrake) vForward *= 1 - P.handbrakeDrag * dt;

  // --- steering lateral demand vs tyre grip (drives both turning AND drift) ---
  const absF = Math.max(Math.abs(vForward), 0.001);
  // geometric yaw desire from the front wheels (bicycle): radius = wheelbase/tan(steer)
  const yawGeo = (vForward / P.wheelbase) * Math.tan(s.steerAngle);
  // grip caps lateral accel (= v*omega), so the gripped turn radius widens with speed
  const latCap = P.maxLatAccel / Math.max(Math.abs(vForward), 5);

  // --- decide grip target: a drift starts when the wheels are OVERWHELMED -----
  // i.e. you crank enough steer at enough speed that the demand blows past grip,
  // OR you pull the handbrake. Gentle/moderate cornering stays gripped, so the
  // car carves like a real car instead of sliding on every input.
  const speedOK = Math.abs(vForward) > P.minDriftSpeed;
  const overwhelmed =
    Math.abs(s.steerAngle) > P.driftSteerThreshold &&
    Math.abs(yawGeo) > latCap * P.driftSlipFactor;
  const steerDrift = overwhelmed && input.throttle && speedOK;
  const driftActive = input.handbrake || steerDrift;
  let gripTarget = driftActive ? P.gripDrift : P.gripNormal;
  if (input.handbrake) gripTarget = Math.min(gripTarget, P.handbrakeGrip);
  s.grip += (gripTarget - s.grip) * clamp(P.gripBlendRate * dt, 0, 1);

  // --- scrub lateral velocity by current grip (forward is preserved) ---------
  vLateral *= clamp(1 - s.grip * dt, 0, 1);

  // --- hard-clamp slip angle so the car can never exceed a stylish angle -----
  const maxLat = Math.tan(P.maxDriftAngle) * absF;
  vLateral = clamp(vLateral, -maxLat, maxLat);

  // --- drifting scrubs forward speed (sideways tyres drag) --------------------
  // This is what keeps it a "slow drive": power slides bleed speed and settle into
  // a photogenic angle instead of holding flat-out where drifts are shallow.
  if (s.grip < P.gripNormal * 0.8) {
    const slideFrac = clamp(Math.abs(vLateral) / 14, 0, 1);
    vForward *= 1 - P.driftScrub * slideFrac * dt;
  }

  // --- recompose world velocity using the OLD heading (velocity lags car) ----
  s.vx = vForward * fwdX + vLateral * rightX;
  s.vz = vForward * fwdZ + vLateral * rightZ;

  // --- yaw: grip-limited bicycle (speed-based radius), relaxed while drifting --
  // When gripped, yaw is capped by latCap (wide turns at speed). While drifting
  // (low grip) the cap relaxes so the wheel gives full counter-steer authority.
  const gripFrac = clamp((s.grip - P.gripDrift) / (P.gripNormal - P.gripDrift), 0, 1);
  const yawGrip = clamp(yawGeo, -latCap, latCap); // gripped: wide, realistic radius
  const driftCap = latCap * P.driftYawMul;
  const yawSlide = clamp(yawGeo, -driftCap, driftCap); // drifting: stronger but bounded
  let omega = yawGrip * gripFrac + yawSlide * (1 - gripFrac);

  // --- DRIFT ASSIST: restoring torque toward the velocity vector -------------
  // slip>0 means velocity points to the car's right; rotating heading right
  // (negative omega) aligns the car with travel -> auto counter-steer.
  const slip = Math.atan2(vLateral, absF);
  const assist = clamp(-P.kAssist * slip, -P.maxAssist, P.maxAssist);
  omega += assist;

  // --- stabilise: blend toward target omega, damp, clamp ---------------------
  s.omega += (omega - s.omega) * clamp(P.yawDamping * dt, 0, 1);
  s.omega = clamp(s.omega, -P.maxYawRate, P.maxYawRate);
  s.heading += s.omega * dt;

  // --- integrate position ----------------------------------------------------
  s.x += s.vx * dt;
  s.z += s.vz * dt;

  // --- telemetry for the rest of the game ------------------------------------
  s.forwardSpeed = vForward;
  s.lateralSpeed = vLateral;
  s.slip = slip;
  s.speed = Math.hypot(s.vx, s.vz);
  const slipDeg = Math.abs(slip) * (180 / Math.PI);
  s.drifting = (slipDeg > 9 || input.handbrake) && Math.abs(vForward) > P.minDriftSpeed;
  s.intensity = s.drifting
    ? clamp(Math.abs(slip) / P.maxDriftAngle, 0, 1) * clamp(Math.abs(vForward) / P.maxSpeed, 0, 1)
    : 0;

  // fill boost while drifting
  if (s.drifting) s.boost = clamp(s.boost + P.boostFill * (0.4 + s.intensity) * dt, 0, 1);
}

// Snapshot just the renderable transform (for interpolation).
export function snapshot(s) {
  return { x: s.x, z: s.z, heading: s.heading, steerAngle: s.steerAngle, speed: s.speed };
}

// Fill an existing snapshot object in place — lets the fixed-step loop ping-pong two
// buffers instead of allocating a snapshot every physics step (120/s).
export function snapshotInto(t, s) {
  t.x = s.x; t.z = s.z; t.heading = s.heading; t.steerAngle = s.steerAngle; t.speed = s.speed;
  return t;
}
