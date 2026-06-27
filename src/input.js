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
  const touchZones = new Map(); // touch identifier -> zone string

  // ---- gyroscope ------------------------------------------------------------
  let motionActive = false;
  let useTilt = false;
  let tiltRaw = 0;
  let tiltNeutral = null;
  let tiltSens = 1.0; // 1 = ~32° tilt for full lock
  let tiltInvert = true; // inverted feels right by default

  function onOrient(e) {
    if (e.beta === null && e.gamma === null) return;
    const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    // pick the axis that maps to left/right "wheel" tilt for the current orientation
    let t;
    if (angle === 90) t = e.beta;
    else if (angle === 270 || angle === -90) t = -e.beta;
    else if (angle === 180) t = -e.gamma;
    else t = e.gamma; // 0 / portrait
    tiltRaw = t;
    if (tiltNeutral === null) tiltNeutral = t; // calibrate to however it's first held
  }

  async function enableMotion() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission(); // iOS 13+ gesture-gated
        if (res !== 'granted') return false;
      }
      window.addEventListener('deviceorientation', onOrient);
      motionActive = true;
      useTilt = true;
      tiltNeutral = null;
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
    if (!motionActive || tiltNeutral === null) return 0;
    return clamp(tiltRaw - tiltNeutral, -55, 55) * (Math.PI / 180);
  };

  // ---- touch zones (multi-touch) -------------------------------------------
  function zoneOf(x, y) {
    const W = window.innerWidth, H = window.innerHeight;
    if (y > H * 0.8) return 'handbrake'; // bottom strip
    return x < W * 0.5 ? 'brake' : 'gas'; // left = brake, right = gas
  }
  function recomputeZones() {
    let g = false, b = false, h = false;
    for (const z of touchZones.values()) {
      if (z === 'gas') g = true;
      else if (z === 'brake') b = true;
      else if (z === 'handbrake') h = true;
    }
    touch.throttle = g;
    touch.brake = b;
    touch.handbrake = h;
  }
  function bindZones(layer) {
    if (!layer) return;
    const start = (e) => {
      for (const t of e.changedTouches) touchZones.set(t.identifier, zoneOf(t.clientX, t.clientY));
      recomputeZones();
      e.preventDefault();
    };
    const move = (e) => {
      for (const t of e.changedTouches) if (touchZones.has(t.identifier)) touchZones.set(t.identifier, zoneOf(t.clientX, t.clientY));
      recomputeZones();
      e.preventDefault();
    };
    const end = (e) => {
      for (const t of e.changedTouches) touchZones.delete(t.identifier);
      recomputeZones();
    };
    layer.addEventListener('touchstart', start, { passive: false });
    layer.addEventListener('touchmove', move, { passive: false });
    layer.addEventListener('touchend', end);
    layer.addEventListener('touchcancel', end);
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
    if (useTilt && motionActive && tiltNeutral !== null) {
      let d = tiltRaw - tiltNeutral;
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

  return {
    sample, consumePressed, clearPressed,
    bindZones, bindHold,
    enableMotion, recenterTilt, setTiltSensitivity, setTiltInvert, isMotionActive, deviceRoll,
    _keys: keys,
  };
}
