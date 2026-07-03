// ============================================================================
// camera.js — spring chase camera. Position lags the car; the look-target lags
// even more, so the car reads "loose". While drifting the camera slides toward
// the side opposite the slide and the FOV punches with speed/boost.
// ============================================================================

import * as THREE from 'three';
import { CAM, PHYS } from './config.js';

const MODES = ['chase', 'far', 'hood', 'overhead', 'showcase'];

export function createChaseCam(camera, car) {
  const smoothedLook = new THREE.Vector3();
  const goalWorld = new THREE.Vector3();
  const lookWorld = new THREE.Vector3();
  const carWorld = new THREE.Vector3();
  let mode = 0;
  let started = false;
  let framedX = 0; // smoothed lateral drift-frame offset
  let rollSmoothed = 0; // counter-roll to keep the view level while tilting the phone
  let rollBaseline = 0; // slowly-adapting reference so a held tilt never gets "stuck"

  // place the look anchor (ahead of the car)
  car.lookTarget.position.set(0, CAM.lookUp, -CAM.lookAhead);

  function cycle() {
    mode = (mode + 1) % MODES.length;
    return MODES[mode];
  }

  function setMode(name) {
    const i = MODES.indexOf(name);
    if (i >= 0) mode = i;
  }

  function offsetsFor(state) {
    switch (MODES[mode]) {
      case 'far':
        return { behind: CAM.behind + 4.5, up: CAM.up + 2.4, fovBias: -4 };
      case 'hood':
        return { behind: -0.2, up: 1.25, fovBias: 6 };
      case 'overhead':
        return { behind: 0.01, up: 26, fovBias: -12 };
      case 'showcase':
        // in FRONT of the car (-Z) and off to the right (+X), aimed at the car body
        return {
          behind: -CAM.showcaseAhead, up: CAM.showcaseUp, side: CAM.showcaseSide,
          fovBias: CAM.showcaseFovBias, lookAtCar: true, lookHeight: CAM.showcaseLook,
        };
      default:
        return { behind: CAM.behind, up: CAM.up, fovBias: 0 };
    }
  }

  function update(state, dt, rollTarget = 0) {
    const o = offsetsFor(state);

    // drift framing: offset opposite the slide, scaled by slip
    const noFrame = MODES[mode] === 'overhead' || MODES[mode] === 'showcase';
    const targetFrame =
      THREE.MathUtils.clamp(
        -Math.sign(state.lateralSpeed || 0) * (Math.abs(state.slip) / PHYS.maxDriftAngle) * CAM.driftFrame,
        -CAM.driftFrame,
        CAM.driftFrame
      ) * (noFrame ? 0 : 1);
    framedX += (targetFrame - framedX) * Math.min(dt * 4, 1);

    // position the goal anchor in car-local space (forward is -Z, so behind = +Z;
    // o.side pushes it to the car's right for the showcase cam)
    car.cameraGoal.position.set(framedX + (o.side || 0), o.up, o.behind);
    car.cameraGoal.getWorldPosition(goalWorld);
    if (o.lookAtCar) {
      // aim at the car body itself (heading-independent) so it stays framed as it turns
      car.group.getWorldPosition(lookWorld);
      lookWorld.y += o.lookHeight || 0.7;
    } else {
      car.lookTarget.getWorldPosition(lookWorld);
    }

    if (!started) {
      camera.position.copy(goalWorld);
      smoothedLook.copy(lookWorld);
      started = true;
    }

    const posT = 1 - Math.pow(CAM.posDecay, dt);
    const lookT = 1 - Math.pow(CAM.lookDecay, dt);
    camera.position.lerp(goalWorld, MODES[mode] === 'overhead' ? Math.min(dt * 6, 1) : posT);
    smoothedLook.lerp(lookWorld, MODES[mode] === 'overhead' ? Math.min(dt * 6, 1) : lookT);

    // Keep a minimum distance from the car so it never clips the lens when the
    // car slides/recoils BACKWARD toward the camera (reversing, wall bounce, hard
    // stop). Only for the trailing cams — hood/overhead sit on the car on purpose.
    if (MODES[mode] === 'chase' || MODES[mode] === 'far') {
      car.group.getWorldPosition(carWorld);
      const dx = camera.position.x - carWorld.x;
      const dz = camera.position.z - carWorld.z;
      const d = Math.hypot(dx, dz);
      if (d < CAM.minDist && d > 1e-3) {
        const s = CAM.minDist / d;
        camera.position.x = carWorld.x + dx * s;
        camera.position.z = carWorld.z + dz * s;
      }
    }
    camera.lookAt(smoothedLook);
    // Counter-roll the view so you can see WHILE tilting, but auto-recenter so a
    // held tilt (or a calibration offset) eases back to level instead of getting
    // stuck: compensate the CHANGE in tilt, let a slow baseline absorb the rest.
    rollBaseline += (rollTarget - rollBaseline) * Math.min(dt * 0.6, 1); // slow adapt (~1.6s)
    const rel = rollTarget - rollBaseline;
    rollSmoothed += (rel - rollSmoothed) * Math.min(dt * 9, 1); // track the change (gentle)
    if (Math.abs(rollSmoothed) > 1e-4) camera.rotateZ(rollSmoothed);

    // FOV punch with speed + boost
    const speedFrac = THREE.MathUtils.clamp(state.speed / PHYS.maxSpeed, 0, 1);
    const targetFov = CAM.fov + o.fovBias + (state.boosting ? 8 : speedFrac * 5);
    camera.fov += (targetFov - camera.fov) * Math.min(dt * 3, 1);
    camera.updateProjectionMatrix();
  }

  function reset() {
    started = false;
    framedX = 0;
  }

  // floating-origin rebase: shift the smoothed camera state by (dx,dz) without a snap
  function shift(dx, dz) {
    camera.position.x += dx; camera.position.z += dz;
    smoothedLook.x += dx; smoothedLook.z += dz;
    goalWorld.x += dx; goalWorld.z += dz;
    lookWorld.x += dx; lookWorld.z += dz;
  }

  return { update, cycle, setMode, reset, shift, get mode() { return MODES[mode]; } };
}
