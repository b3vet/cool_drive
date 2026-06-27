// ============================================================================
// input.js — keyboard + touch input, sampled into a single struct each frame.
// ============================================================================

export function createInput() {
  const keys = new Set();
  const input = {
    throttle: false,
    brake: false,
    steer: 0, // -1..1 (analog target; smoothing happens in physics)
    handbrake: false,
    boost: false,
  };

  // edge-triggered actions the game polls + clears
  const pressed = new Set();

  const down = (e) => {
    const k = e.key.toLowerCase();
    if (!keys.has(k)) pressed.add(k);
    keys.add(k);
    // prevent page scroll on arrows/space
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  };
  const up = (e) => keys.delete(e.key.toLowerCase());
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', () => keys.clear());

  // ---- touch joystick + buttons --------------------------------------------
  const touch = { steer: 0, throttle: false, brake: false, handbrake: false, boost: false };

  function bindTouch(els) {
    if (!els) return;
    const { joy, knob, gas, brakeBtn, hb, boostBtn } = els;
    if (joy && knob) {
      let active = false;
      let id = null;
      let cx = 0,
        cy = 0;
      const R = 55;
      const start = (e) => {
        active = true;
        const t = e.changedTouches ? e.changedTouches[0] : e;
        id = t.identifier;
        const r = joy.getBoundingClientRect();
        cx = r.left + r.width / 2;
        cy = r.top + r.height / 2;
        move(e);
      };
      const move = (e) => {
        if (!active) return;
        let t = e;
        if (e.changedTouches) {
          t = [...e.changedTouches].find((x) => x.identifier === id) || e.changedTouches[0];
        }
        const dx = t.clientX - cx;
        const dy = t.clientY - cy;
        const d = Math.min(Math.hypot(dx, dy), R);
        const a = Math.atan2(dy, dx);
        const kx = Math.cos(a) * d;
        const ky = Math.sin(a) * d;
        knob.style.transform = `translate(${kx}px, ${ky}px)`;
        touch.steer = Math.max(-1, Math.min(1, dx / R));
        touch.throttle = dy < -R * 0.25;
        touch.brake = dy > R * 0.45;
      };
      const end = () => {
        active = false;
        knob.style.transform = 'translate(0,0)';
        touch.steer = 0;
        touch.throttle = false;
        touch.brake = false;
      };
      joy.addEventListener('touchstart', start, { passive: false });
      window.addEventListener('touchmove', move, { passive: false });
      window.addEventListener('touchend', end);
      window.addEventListener('touchcancel', end);
    }
    const hold = (el, prop) => {
      if (!el) return;
      const on = (e) => {
        e.preventDefault();
        touch[prop] = true;
        el.classList.add('active');
      };
      const off = () => {
        touch[prop] = false;
        el.classList.remove('active');
      };
      el.addEventListener('touchstart', on, { passive: false });
      el.addEventListener('touchend', off);
      el.addEventListener('touchcancel', off);
      el.addEventListener('mousedown', on);
      window.addEventListener('mouseup', off);
    };
    hold(gas, 'throttle');
    hold(brakeBtn, 'brake');
    hold(hb, 'handbrake');
    hold(boostBtn, 'boost');
  }

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
    let steer = (kLeft ? 1 : 0) - (kRight ? 1 : 0); // left = +1 (heading increases)
    if (steer === 0 && touch.steer !== 0) steer = -touch.steer; // joystick: right = +x
    input.steer = steer;
    return input;
  }

  function consumePressed(key) {
    if (pressed.has(key)) {
      pressed.delete(key);
      return true;
    }
    return false;
  }
  function clearPressed() {
    pressed.clear();
  }

  return { sample, consumePressed, clearPressed, bindTouch, _keys: keys };
}
