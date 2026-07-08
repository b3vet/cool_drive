// ============================================================================
// input.js — unified input, sampled into one struct per frame.
//   • Desktop: keyboard (WASD/arrows, space, shift).
//   • Mobile:  gyroscope steering (tilt) + invisible touch zones
//              (left half = brake, right half = gas, bottom strip = handbrake)
//              + held buttons (boost) and tap buttons (settings).
// ============================================================================

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createInput() {
  const keys = new Set();
  const pressed = new Set();
  const input = { throttle: false, brake: false, steer: 0, handbrake: false, boost: false };

  // ---- keyboard -------------------------------------------------------------
  const down = (e) => {
    const k = e.key.toLowerCase();
    if (!keys.has(k)) pressed.add(k);
    keys.add(k);
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  };
  const up = (e) => keys.delete(e.key.toLowerCase());
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', () => keys.clear());

  // ---- mobile touch state ---------------------------------------------------
  const touch = { throttle: false, brake: false, handbrake: false, boost: false };

  // ---- portrait-rotation state (set from main's applyLayout) ----------------
  // On a portrait mobile browser the whole game is CSS-rotated 90° to landscape,
  // so touch coords must be mapped into that rotated "game space" and the gyro
  // must read the landscape tilt axis.
  let rotated = false;
  let rvw = window.innerWidth, rvh = window.innerHeight;
  const setRotated = (on, vw, vh) => { rotated = on; if (vw) rvw = vw; if (vh) rvh = vh; };

  // ---- gyroscope (gravity-vector steering) ----------------------------------
  // Steering reads the GRAVITY direction (devicemotion) and derives a bank angle via atan2 —
  // NOT a single raw Euler angle. Holding the phone upright in landscape sits at beta≈±90, the
  // Euler gimbal-lock singularity, where a raw beta/gamma flips sign even when the device is
  // perfectly still (the old "sudden full-left" glitch). A gravity vector never gimbal-locks, so
  // atan2 of its screen-plane projection is continuous through the whole banking range.
  let motionActive = false;
  let useTilt = false;
  let tiltRaw = null;    // smoothed bank angle (deg); null until the first reading
  let tiltNeutral = null;
  let tiltSens = 1.0;    // 1 = ~32° tilt for full lock
  let tiltInvert = true; // inverted feels right by default
  const wrap180 = (a) => a - 360 * Math.round(a / 360); // shortest arc into (-180, 180]

  function onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null || g.y == null) return;
    // rotate device-frame gravity into SCREEN space so landscape-left/right (and the CSS-rotated
    // portrait path) all steer the same way, then take a gimbal-lock-free roll from its projection.
    let deg = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    if (rotated) deg += 90; // the game is CSS-rotated another 90° over the device orientation
    const a = deg * (Math.PI / 180), ca = Math.cos(a), sa = Math.sin(a);
    const sx = g.x * ca + g.y * sa, sy = -g.x * sa + g.y * ca;
    const roll = Math.atan2(sx, -sy) * (180 / Math.PI); // 0 ≈ upright; sign = bank direction
    if (tiltRaw === null) { tiltRaw = roll; if (tiltNeutral === null) tiltNeutral = roll; return; }
    let dd = wrap180(roll - tiltRaw);
    if (Math.abs(dd) > 40) return; // a >40°/sample jump is a sensor spike, not a real tilt — drop it
    tiltRaw = wrap180(tiltRaw + dd * 0.35); // low-pass: isolates gravity from hand-motion noise
    if (tiltNeutral === null) tiltNeutral = tiltRaw;
  }

  async function enableMotion() {
    try {
      // iOS 13+ gesture-gated permission (one "Motion & Orientation" grant). We read devicemotion.
      const DME = typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : null;
      if (DME && typeof DME.requestPermission === 'function') {
        const res = await DME.requestPermission();
        if (res !== 'granted') return false;
      } else if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission(); // fallback grant path
        if (res !== 'granted') return false;
      }
      window.addEventListener('devicemotion', onMotion);
      motionActive = true;
      useTilt = true;
      tiltNeutral = null; tiltRaw = null;
      return true;
    } catch (e) {
      return false;
    }
  }
  const recenterTilt = () => { tiltNeutral = tiltRaw; };
  const setTiltSensitivity = (v) => { tiltSens = v; };
  const setTiltInvert = (b) => { tiltInvert = b; };
  const isMotionActive = () => motionActive;
  // raw screen-roll (radians) for the camera to counter so the view stays level
  const deviceRoll = () => {
    if (!motionActive || tiltNeutral === null || tiltRaw === null) return 0;
    let d = wrap180(tiltRaw - tiltNeutral);
    if (tiltInvert) d = -d; // same inversion as steering, so the view rolls the correct way
    return clamp(d, -55, 55) * (Math.PI / 180);
  };

  // ---- touch zones (multi-touch) -------------------------------------------
  // Map a raw viewport touch into "game space". When the game is CSS-rotated 90°
  // CW about the top-left, screen (sx,sy) -> game (sy, innerWidth - sx).
  function gameCoords(cx, cy) {
    if (rotated) return { x: cy, y: rvw - cx, W: rvh, H: rvw };
    return { x: cx, y: cy, W: rvw, H: rvh };
  }
  function zoneOf(gx, gy, W, H) {
    // right half = gas (full height); the whole LEFT half is braking, split top/bottom:
    // top half = regular brake, bottom half = handbrake. (Boost is its own centre-bottom button.)
    if (gx >= W * 0.5) return 'gas';
    return gy < H * 0.5 ? 'brake' : 'handbrake';
  }
  // Recompute every driving control from the FULL set of active touches on each
  // event. Reading window-level `e.touches` (not per-element changedTouches) makes
  // multitouch reliable in a WKWebView, where the 2nd finger's events can be
  // captured by whatever element it lands on instead of the touch layer. Each
  // touch is classified by what's under it, so menu/gear taps still work and
  // gas + handbrake (+ boost) hold simultaneously.
  const TAP_CONTROLS = '#gearBtn, #camBtn, #radio, #settings, #startScreen';
  let boostBtnEl = null;
  // Classify each touch ONCE (at touchstart) instead of hit-testing every touch on every
  // touchmove: document.elementFromPoint forces a synchronous style/layout flush, and thumbs
  // resting on gas/brake fire touchmove up to 120x/s. 'zone' touches still re-resolve gas/brake/
  // handbrake by pure math each move (so sliding between them works); 'boost'/'ui' stay put.
  const touchClass = new Map(); // touch.identifier -> 'boost' | 'ui' | 'zone'
  function classify(t) {
    // elementFromPoint uses the on-screen (post-transform) hit test, so raw client coords
    // correctly resolve buttons even when the game is rotated to landscape.
    const el = document.elementFromPoint(t.clientX, t.clientY);
    if (el && el.closest) {
      if (el.closest('#btnBoostM')) return 'boost';
      if (el.closest(TAP_CONTROLS)) return 'ui';
    }
    return 'zone';
  }
  function recomputeTouches(list, changed) {
    if (changed) for (const t of changed) if (!touchClass.has(t.identifier)) touchClass.set(t.identifier, classify(t));
    let g = false, b = false, h = false, bo = false;
    const seen = new Set();
    for (const t of list) {
      seen.add(t.identifier);
      let cls = touchClass.get(t.identifier);
      if (cls === undefined) { cls = classify(t); touchClass.set(t.identifier, cls); } // safety net
      if (cls === 'boost') { bo = true; continue; } // boost button (a held control)
      if (cls === 'ui') continue; // menu/gear/radio — not a driving control
      const gc = gameCoords(t.clientX, t.clientY); // pure math — no DOM hit-test
      const z = zoneOf(gc.x, gc.y, gc.W, gc.H);
      if (z === 'gas') g = true;
      else if (z === 'brake') b = true;
      else if (z === 'handbrake') h = true;
    }
    for (const id of touchClass.keys()) if (!seen.has(id)) touchClass.delete(id); // drop lifted touches
    touch.throttle = g;
    touch.brake = b;
    touch.handbrake = h;
    touch.boost = bo;
    if (!boostBtnEl) boostBtnEl = document.getElementById('btnBoostM');
    if (boostBtnEl) boostBtnEl.classList.toggle('active', bo);
  }
  function bindZones() {
    const onTouch = (e) => recomputeTouches(e.touches, e.changedTouches);
    // passive: no preventDefault needed — body has touch-action:none + user-scalable=no
    window.addEventListener('touchstart', onTouch, { passive: true });
    window.addEventListener('touchmove', onTouch, { passive: true });
    window.addEventListener('touchend', onTouch, { passive: true });
    window.addEventListener('touchcancel', onTouch, { passive: true });
  }

  // held button (boost on mobile); also works with mouse for testing
  function bindHold(el, prop) {
    if (!el) return;
    const on = (e) => { e.preventDefault(); touch[prop] = true; el.classList.add('active'); };
    const off = () => { touch[prop] = false; el.classList.remove('active'); };
    el.addEventListener('touchstart', on, { passive: false });
    el.addEventListener('touchend', off);
    el.addEventListener('touchcancel', off);
    el.addEventListener('mousedown', on);
    window.addEventListener('mouseup', off);
  }

  // ---- sample ---------------------------------------------------------------
  function sample() {
    const kThrottle = keys.has('w') || keys.has('arrowup');
    const kBrake = keys.has('s') || keys.has('arrowdown');
    const kLeft = keys.has('a') || keys.has('arrowleft');
    const kRight = keys.has('d') || keys.has('arrowright');
    const kHand = keys.has(' ');
    const kBoost = keys.has('shift');

    input.throttle = kThrottle || touch.throttle;
    input.brake = kBrake || touch.brake;
    input.handbrake = kHand || touch.handbrake;
    input.boost = kBoost || touch.boost;

    // steering: tilt takes over on mobile when motion is active; else keyboard
    let steer = (kLeft ? 1 : 0) - (kRight ? 1 : 0);
    if (useTilt && motionActive && tiltNeutral !== null && tiltRaw !== null) {
      let d = wrap180(tiltRaw - tiltNeutral);
      if (tiltInvert) d = -d;
      // progressive analog mapping (like a real wheel): proportional to tilt angle,
      // with a soft deadzone so center is calm but there's no on/off jump.
      const dead = 1.5; // degrees
      const range = 32 / clamp(tiltSens, 0.3, 3); // degrees for full lock
      const m = clamp((Math.abs(d) - dead) / (range - dead), 0, 1);
      steer = Math.sign(d) * m;
    }
    input.steer = steer;
    return input;
  }

  function consumePressed(key) {
    if (pressed.has(key)) { pressed.delete(key); return true; }
    return false;
  }
  function clearPressed() { pressed.clear(); }

  // live tilt values for the perf overlay — lets you confirm on-device that the bank angle
  // moves continuously through the whole range (no sudden opposite flips) and steers correctly.
  function tiltReadout() {
    if (!motionActive || tiltNeutral === null || tiltRaw === null) return null;
    let d = wrap180(tiltRaw - tiltNeutral); if (tiltInvert) d = -d;
    return { raw: tiltRaw, d, steer: input.steer };
  }

  return {
    sample, consumePressed, clearPressed,
    bindZones, bindHold, setRotated,
    enableMotion, recenterTilt, setTiltSensitivity, setTiltInvert, isMotionActive, deviceRoll, tiltReadout,
    _keys: keys,
  };
}
