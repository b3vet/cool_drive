// Headless physics verification — no browser, no input layer.
import { createCarState, stepPhysics } from './src/physics.js';
import { PHYS } from './src/config.js';

const deg = (r) => (r * 180) / Math.PI;
const STEP = PHYS.STEP;
const I = (steer, hb = false, throttle = true, brake = false) => ({ throttle, brake, steer, handbrake: hb, boost: false });

function fresh() { return createCarState(0, 0, 0); }
function warm(s, targetSpeed) {
  // accelerate straight until ~targetSpeed
  let guard = 0;
  while (s.forwardSpeed < targetSpeed && guard++ < 6000) stepPhysics(s, I(0), STEP);
}

// Hold a steady steering input at a given cruise speed; report gripped turn radius + drift state.
// Throttle is feathered to HOLD the target speed so radius is measured at that speed.
function corner(speed, steerInput, seconds = 4) {
  const s = fresh();
  warm(s, speed);
  let driftFrames = 0, n = 0;
  const radii = [];
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    const thr = s.forwardSpeed < speed; // hold speed, don't keep accelerating
    stepPhysics(s, { throttle: thr, brake: false, steer: steerInput, handbrake: false, boost: false }, STEP);
    if (i * STEP > seconds - 1.5) {
      n++;
      if (s.drifting) driftFrames++;
      if (Math.abs(s.omega) > 1e-3) radii.push(Math.abs(s.forwardSpeed / s.omega));
    }
  }
  const r = radii.length ? radii.reduce((a, b) => a + b, 0) / radii.length : Infinity;
  return { radius: r, drifting: driftFrames / n > 0.5, speed: s.speed, slip: deg(s.slip) };
}

console.log('=== GRIPPED TURN RADIUS (moderate steer, should NOT drift) ===');
for (const v of [8, 18, 30, 45]) {
  const c = corner(v, 0.35);
  const g = (c.speed * c.speed) / c.radius / 9.81; // lateral g
  console.log(`v≈${v}m/s steer0.35 -> radius ${c.radius.toFixed(0)}m  ~${g.toFixed(1)}g  drift=${c.drifting ? 'YES' : 'no'} slip=${c.slip.toFixed(0)}°`);
}
console.log('\n=== LOW-SPEED FULL LOCK (tight gripped U-turn) ===');
{
  const c = corner(8, 1.0);
  console.log(`v≈8 full lock -> radius ${c.radius.toFixed(1)}m drift=${c.drifting ? 'YES' : 'no'}`);
}
console.log('\n=== POWER SLIDE: throttle HELD + full lock from a cruise (should drift) ===');
for (const v of [22, 32]) {
  const s = fresh(); warm(s, v);
  const slips = []; let driftN = 0, n = 0;
  for (let i = 0; i < Math.round(3 / STEP); i++) {
    stepPhysics(s, I(1.0), STEP); // throttle + full lock
    if (i * STEP > 1.0) { n++; if (s.drifting) driftN++; slips.push(Math.abs(deg(s.slip))); }
  }
  const avg = slips.reduce((a, b) => a + b, 0) / slips.length;
  console.log(`cruise ${v} -> drift=${driftN / n > 0.5 ? 'YES' : 'no'} avgSlip=${avg.toFixed(0)}° endSpeed=${s.speed.toFixed(0)}m/s`);
}

// --- drift regression (donut / handbrake / flick / recovery) ---
function steady(input, sec = 7) {
  const s = fresh(); warm(s, 30);
  const slips = []; let maxOm = 0;
  for (let i = 0; i < Math.round(sec / STEP); i++) {
    stepPhysics(s, input, STEP);
    maxOm = Math.max(maxOm, Math.abs(s.omega));
    if (i * STEP > sec - 2) slips.push(deg(s.slip));
  }
  return { slip: slips.reduce((a, b) => a + b, 0) / slips.length, amp: Math.max(...slips) - Math.min(...slips), speed: s.speed, maxOm };
}
function flick() {
  const s = fresh(); warm(s, 30);
  for (let i = 0; i < Math.round(1.6 / STEP); i++) stepPhysics(s, I(-1, true), STEP);
  let peak = 0, spun = false;
  for (let i = 0; i < Math.round(2.5 / STEP); i++) {
    stepPhysics(s, I(1, true), STEP);
    const a = Math.abs(deg(s.slip)); peak = Math.max(peak, a); if (a > 75) spun = true;
  }
  return { peak, spun };
}
function recover() {
  const s = fresh(); warm(s, 30);
  for (let i = 0; i < Math.round(2 / STEP); i++) stepPhysics(s, I(-1, true), STEP);
  for (let i = 0; i < Math.round(2 / STEP); i++) stepPhysics(s, I(0, false, false), STEP);
  return deg(s.slip);
}

console.log('\n=== DECELERATION FEEL (start ~30 m/s = 108 km/h) ===');
function decel(label, input, sec) {
  const s = fresh(); warm(s, 30);
  const v0 = s.forwardSpeed;
  for (let i = 0; i < Math.round(sec / STEP); i++) stepPhysics(s, input, STEP);
  const v1 = s.forwardSpeed;
  console.log(`${label}: ${(v0 * 3.6).toFixed(0)}->${(v1 * 3.6).toFixed(0)} km/h over ${sec}s  (avg ${((v0 - v1) / sec).toFixed(1)} m/s²)`);
}
decel('coast (lift off gas)', { throttle: false, brake: false, steer: 0, handbrake: false, boost: false }, 3);
decel('brake', { throttle: false, brake: true, steer: 0, handbrake: false, boost: false }, 3);
decel('handbrake only (no steer)', { throttle: false, brake: false, steer: 0, handbrake: true, boost: false }, 3);

console.log('\n=== DRIFT REGRESSION ===');
const donut = steady(I(-1));
const hb = steady(I(-1, true));
const fl = flick();
const rec = recover();
console.log(`donut(full lock): ${donut.slip.toFixed(0)}° ±${donut.amp.toFixed(1)} ${donut.speed.toFixed(0)}m/s maxOm ${donut.maxOm.toFixed(2)}`);
console.log(`handbrake: ${hb.slip.toFixed(0)}° ${hb.speed.toFixed(0)}m/s`);
console.log(`flick L->R: peak ${fl.peak.toFixed(0)}° ${fl.spun ? 'SPUN!' : 'stable'}`);
console.log(`recovery final slip: ${rec.toFixed(1)}°`);
