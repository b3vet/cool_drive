// ============================================================================
// car.js — selectable low-poly cars built from a definition (config.CARS).
// Distinct silhouettes via params (nose shape, ride height, wing, scoop, etc.).
// Forward = -Z.
//   car (root)      -> position + heading (yaw)
//     chassis       -> body parts; rolls/pitches for weight transfer
//     wheels        -> flat on ground; fronts steer, all spin (visible spokes)
//     cameraGoal/lookTarget -> chase anchors
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CAR_COLORS, PHYS, VIS } from './config.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Load a .glb/.gltf model as the car body. Auto-centres, scales to bodyL, and
// orients with def.modelRotation. Used when a car def has a `modelUrl`.
function buildGLBCar(def) {
  const car = new THREE.Group();
  car.name = 'car';
  const chassis = new THREE.Group();
  car.add(chassis);

  new GLTFLoader().load(
    def.modelUrl,
    (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      const targetLen = def.bodyL || 4.0;
      const longest = Math.max(size.x, size.z) || 1;
      const scale = def.modelScale || targetLen / longest;
      model.scale.setScalar(scale);
      // sit it on the ground, centred horizontally
      model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
      model.rotation.y = def.modelRotation || 0;
      model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
      chassis.add(model);
    },
    undefined,
    (err) => console.warn('CoolDrive: failed to load car model', def.modelUrl, err)
  );

  const cameraGoal = new THREE.Object3D();
  car.add(cameraGoal);
  const lookTarget = new THREE.Object3D();
  car.add(lookTarget);
  const hw = (def.bodyW || 1.85) / 2 + 0.05;
  const wbR = PHYS.wheelbase / 2 + 0.3;
  return {
    def, group: car, chassis, bodyMat: null,
    steerGroups: [], frontSpinners: [], rearSpinners: [], tails: [],
    tlMat: new THREE.MeshBasicMaterial(), // dummy so the brake-light wiring is harmless
    cameraGoal, lookTarget, frontAngle: 0, rearAngle: 0, prevFwd: 0,
    rearOffsets: [new THREE.Vector3(-hw, 0, wbR), new THREE.Vector3(hw, 0, wbR)],
  };
}

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: opts.roughness ?? 0.55,
    metalness: opts.metalness ?? 0.15,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
  });
}

function box(parent, w, h, d, x, y, z, m, rot) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  if (rot) mesh.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function makeWheel(radius) {
  const g = new THREE.Group();
  const tireMat = mat(CAR_COLORS.wheel, { roughness: 0.92, metalness: 0 });
  const spokeMat = mat(CAR_COLORS.rim, { metalness: 0.55, roughness: 0.35 });
  const w = radius * 0.82;

  const tire = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, w, 20), tireMat);
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  g.add(tire);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.48, radius * 0.48, w + 0.02, 14), spokeMat);
  hub.rotation.z = Math.PI / 2;
  g.add(hub);
  for (let k = 0; k < 2; k++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(w - 0.04, radius * 1.7, radius * 0.2), spokeMat);
    spoke.rotation.x = k * (Math.PI / 2);
    g.add(spoke);
  }
  return g;
}

export function buildCar(def) {
  if (def.modelUrl) return buildGLBCar(def); // use an imported .glb model if provided

  const car = new THREE.Group();
  car.name = 'car';
  const chassis = new THREE.Group();
  car.add(chassis);

  const bodyMat = mat(def.color, { roughness: 0.4, metalness: 0.25 });
  const darkMat = mat(def.accent, { roughness: 0.7 });
  const glassMat = mat(CAR_COLORS.glass, { metalness: 0.5, roughness: 0.12 });

  const W = def.bodyW, L = def.bodyL, H = def.bodyH, ride = def.ride;
  const floor = ride; // top of skirt
  const beltline = floor + H; // top of main body

  // lower skirt / chassis
  box(chassis, W + 0.08, 0.26, L - 0.3, 0, floor - 0.05, 0, darkMat);
  // main body
  box(chassis, W, H, L, 0, floor + H / 2, 0, bodyMat);
  // upper body taper (narrower deck) for a less blocky look
  box(chassis, W - 0.5, 0.16, L - 0.7, 0, beltline - 0.02, -0.1, bodyMat);

  // nose
  if (def.nose === 'sharp') {
    box(chassis, W - 0.25, 0.3, 1.1, 0, floor + 0.18, -L / 2 - 0.2, bodyMat, [0.12, 0, 0]);
    box(chassis, W - 0.6, 0.1, 0.5, 0, floor + 0.02, -L / 2 - 0.55, darkMat); // splitter
  } else if (def.nose === 'blunt') {
    box(chassis, W - 0.1, H + 0.06, 0.7, 0, floor + (H + 0.06) / 2, -L / 2 - 0.1, bodyMat);
    box(chassis, W - 0.2, 0.12, 0.5, 0, floor + 0.02, -L / 2 - 0.35, darkMat);
  } else {
    box(chassis, W - 0.2, 0.32, 0.95, 0, floor + 0.2, -L / 2 - 0.1, bodyMat, [0.08, 0, 0]);
    box(chassis, W - 0.5, 0.1, 0.45, 0, floor + 0.02, -L / 2 - 0.4, darkMat); // splitter
  }

  // hood scoop (muscle)
  if (def.scoop) box(chassis, 0.7, 0.18, 1.0, 0, beltline + 0.06, -0.9, darkMat);

  // greenhouse / cabin: sloped windshield + roof + rear glass
  const cz = def.cabinZ, cw = def.cabinW, cl = def.cabinL, ch = def.cabinH;
  const cy = beltline + ch / 2;
  box(chassis, cw, ch, cl, 0, cy, cz, darkMat); // cabin shell
  box(chassis, cw + 0.02, ch * 0.82, cl * 0.55, 0, cy + 0.02, cz - cl * 0.28, glassMat, [-0.5, 0, 0]); // windshield
  box(chassis, cw + 0.02, ch * 0.8, cl * 0.4, 0, cy + 0.02, cz + cl * 0.34, glassMat, [0.5, 0, 0]); // rear glass
  box(chassis, cw - 0.06, ch * 0.6, 0.06, cw / 2 - 0.04, cy, cz, glassMat); // side glass L
  box(chassis, cw - 0.06, ch * 0.6, 0.06, -cw / 2 + 0.04, cy, cz, glassMat); // side glass R
  // roof cap
  box(chassis, cw - 0.12, 0.1, cl * 0.7, 0, cy + ch / 2 - 0.02, cz + 0.05, bodyMat);

  // side mirrors
  for (const sx of [-1, 1]) box(chassis, 0.12, 0.1, 0.22, sx * (cw / 2 + 0.12), cy + 0.05, cz - cl * 0.35, darkMat);

  // wing
  if (def.wing === 'big') {
    box(chassis, 0.08, 0.4, 0.5, -W / 2 + 0.25, beltline + 0.2, L / 2 - 0.2, darkMat);
    box(chassis, 0.08, 0.4, 0.5, W / 2 - 0.25, beltline + 0.2, L / 2 - 0.2, darkMat);
    box(chassis, W + 0.1, 0.09, 0.5, 0, beltline + 0.42, L / 2 - 0.2, bodyMat);
  } else if (def.wing === 'medium') {
    box(chassis, 1.3, 0.06, 0.45, 0, beltline + 0.12, L / 2 - 0.25, darkMat);
    box(chassis, W - 0.1, 0.08, 0.42, 0, beltline + 0.26, L / 2 - 0.22, bodyMat);
  } else {
    box(chassis, W - 0.1, 0.12, 0.5, 0, beltline + 0.02, L / 2 - 0.3, darkMat); // ducktail
  }

  // exhaust pipes
  for (const sx of [-0.4, 0.4]) box(chassis, 0.16, 0.16, 0.3, sx, floor - 0.02, L / 2 + 0.05, mat(0x9aa0ad, { metalness: 0.7, roughness: 0.3 }));

  // headlights + tails
  const hlMat = mat(CAR_COLORS.light, { emissive: CAR_COLORS.light, emissiveIntensity: 1.5, roughness: 0.3 });
  const noseZ = -L / 2 - (def.nose === 'blunt' ? 0.42 : 0.45);
  for (const x of [-0.55, 0.55]) box(chassis, 0.36, 0.16, 0.08, x, floor + 0.2, noseZ, hlMat);
  const tlMat = mat(CAR_COLORS.brake, { emissive: CAR_COLORS.brake, emissiveIntensity: 1.2, roughness: 0.4 });
  const tails = [];
  for (const x of [-0.55, 0.55]) tails.push(box(chassis, 0.42, 0.15, 0.06, x, floor + 0.28, L / 2 + 0.02, tlMat));

  // wheels + fender arches
  const rw = def.wheel;
  const hw = W / 2 + 0.05;
  const wbF = -PHYS.wheelbase / 2 - 0.05;
  const wbR = PHYS.wheelbase / 2 + 0.3;
  const steerGroups = [];
  const frontSpinners = [];
  const rearSpinners = [];
  const archMat = darkMat;

  function placeWheel(x, z, steer) {
    const spinner = makeWheel(rw);
    const anchor = new THREE.Group();
    anchor.position.set(x, rw, z);
    anchor.add(spinner);
    car.add(anchor);
    // fender arch
    box(chassis, 0.18, 0.3, rw * 2.4, x > 0 ? hw : -hw, rw + 0.15, z, archMat);
    if (steer) { steerGroups.push(anchor); frontSpinners.push(spinner); }
    else rearSpinners.push(spinner);
  }
  placeWheel(-hw, wbF, true);
  placeWheel(hw, wbF, true);
  placeWheel(-hw, wbR, false);
  placeWheel(hw, wbR, false);

  const cameraGoal = new THREE.Object3D();
  car.add(cameraGoal);
  const lookTarget = new THREE.Object3D();
  car.add(lookTarget);

  return {
    def,
    group: car,
    chassis,
    bodyMat,
    steerGroups,
    frontSpinners,
    rearSpinners,
    tails,
    tlMat,
    cameraGoal,
    lookTarget,
    frontAngle: 0,
    rearAngle: 0,
    prevFwd: 0,
    rearOffsets: [new THREE.Vector3(-hw, 0, wbR), new THREE.Vector3(hw, 0, wbR)],
  };
}

// Push physics state into the car visuals: transform, steering, wheel spin, roll/pitch.
export function applyCarVisual(car, render, state, input, dt) {
  car.group.position.set(render.x, 0, render.z);
  car.group.rotation.y = render.heading;

  for (const g of car.steerGroups) g.rotation.y = render.steerAngle;

  const rollOmega = state.forwardSpeed / PHYS.wheelRadius;
  const stopped = state.speed < 3;
  if (!(input.brake && stopped)) car.frontAngle -= rollOmega * dt;
  for (const sp of car.frontSpinners) sp.rotation.x = car.frontAngle;

  if (!input.handbrake) {
    const launch = input.throttle
      ? VIS.launchSpin * clamp(1 - Math.abs(state.forwardSpeed) / PHYS.maxSpeed, 0, 1)
      : 0;
    car.rearAngle -= (rollOmega + launch) * dt;
  }
  for (const sp of car.rearSpinners) sp.rotation.x = car.rearAngle;

  const accel = (state.forwardSpeed - car.prevFwd) / Math.max(dt, 1e-4);
  car.prevFwd = state.forwardSpeed;
  const targetRoll = clamp(-state.lateralSpeed / 16, -1, 1) * VIS.rollMax;
  const targetPitch = clamp(accel / 22, -1, 1) * VIS.pitchMax;
  const k = clamp(VIS.bodyLerp * dt, 0, 1);
  car.chassis.rotation.z += (targetRoll - car.chassis.rotation.z) * k;
  car.chassis.rotation.x += (targetPitch - car.chassis.rotation.x) * k;
}
