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

// Cache-buster for car models. The dev server / CDN caches .glb for a week, so bump
// this whenever a model file in /models changes to force clients to refetch it.
const MODEL_VER = '4';
const bust = (url) => url + (url.includes('?') ? '&' : '?') + 'v=' + MODEL_VER;

// Twin additive boost flames at the rear (+Z). Parented to the chassis (exists
// synchronously even for async GLB bodies). Driven by applyCarVisual on boost.
function makeFlames(def) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x8fd8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const geo = new THREE.ConeGeometry(0.17, 0.95, 8);
  const rearZ = (def.bodyL || 4) / 2 + 0.26, y = (def.ride || 0.35) + 0.06;
  for (const sx of [-0.42, 0.42]) {
    const f = new THREE.Mesh(geo, mat);
    f.position.set(sx, y, rearZ);
    f.rotation.x = Math.PI / 2; // apex points backward (+Z)
    group.add(f);
  }
  group.visible = false;
  return { group, mat };
}

// Load a .glb/.gltf model as the car body. Auto-centres, scales to bodyL, and
// orients with def.modelRotation. Used when a car def has a `modelUrl`.
function buildGLBCar(def) {
  const car = new THREE.Group();
  car.name = 'car';
  const chassis = new THREE.Group();
  car.add(chassis);

  // Wheel wiring — filled in async once the model loads (see rigGLBWheels). These
  // arrays are returned by reference so applyCarVisual animates the wheels the frame
  // they appear. GLB wheels live on the CAR ROOT (not the chassis) so they stay
  // planted on the ground while the body rolls/pitches.
  const steerGroups = [];
  const frontSpinners = [];
  const rearSpinners = [];

  new GLTFLoader().load(
    bust(def.modelUrl),
    (gltf) => {
      const model = gltf.scene;
      // Orient first (game forward = -Z), so scale + recentre are measured from the
      // ACTUAL on-screen pose — otherwise a rotated model sits off its pivot.
      model.rotation.y = def.modelRotation || 0;
      model.updateMatrixWorld(true);
      const size = new THREE.Vector3();
      new THREE.Box3().setFromObject(model).getSize(size);
      const targetLen = def.bodyL || 4.0;
      const longest = Math.max(size.x, size.z) || 1;
      const scale = def.modelScale || targetLen / longest;
      model.scale.setScalar(scale);
      // measure the scaled+rotated box, then centre horizontally + drop onto ground.
      // `modelLift` raises the body above the ground (ride height) — the wheels stay
      // planted, so it opens up ground clearance under the arches.
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const center = new THREE.Vector3();
      box.getCenter(center);
      model.position.set(-center.x, -box.min.y + (def.modelLift || 0), -center.z);
      model.updateMatrixWorld(true);
      // Flat shading (faceted, per-face normals) to match the game's low-poly look —
      // the AI models come out smooth/soft otherwise. Disable with `flatShading: false`.
      const flat = def.flatShading !== false;
      model.traverse((o) => {
        if (!o.isMesh) return;
        // The car casts a real shaped shadow. That's cheap now: the shadow map is TIME-scheduled
        // (main.js), so the car's ~5k tris just join the depth pass at the fixed cadence — it does
        // NOT force an every-frame re-render. Also strip the material to the cheapest correct PBR path.
        o.castShadow = true; o.receiveShadow = false;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          if (!m) return;
          // FrontSide: GLBs load DoubleSide → uncullable interior faces double the car's
          // fragments (it's the biggest near-camera object). Drop the normal + metal/rough
          // maps (flatShading fights the normal map anyway) with constants so the car doesn't
          // render fully-metallic once the MR texture is gone. Dispose the freed textures.
          if (m.side !== THREE.FrontSide) m.side = THREE.FrontSide;
          if (m.normalMap) { m.normalMap.dispose(); m.normalMap = null; }
          if (m.metalnessMap) { m.metalnessMap.dispose(); m.metalnessMap = null; }
          if (m.roughnessMap) { m.roughnessMap.dispose(); m.roughnessMap = null; }
          m.metalness = 0.2; m.roughness = 0.6;
          if (flat) m.flatShading = true;
          m.needsUpdate = true;
        });
      });
      chassis.add(model);

      // Tripo models bake the wheels into one merged, fragmented shell (they can't be
      // spun individually), so we add real spinning/steering wheels at the detected
      // hub positions. Disable per-car with `wheels: false`.
      if (def.wheels !== false) rigGLBWheels(def, car, model);
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
  const flames = makeFlames(def);
  chassis.add(flames.group);
  return {
    def, group: car, chassis, bodyMat: null,
    steerGroups, frontSpinners, rearSpinners, tails: [],
    tlMat: new THREE.MeshBasicMaterial(), // dummy so the brake-light wiring is harmless
    flameGroup: flames.group, flameMat: flames.mat, _flame: 0,
    cameraGoal, lookTarget, frontAngle: 0, rearAngle: 0, prevFwd: 0,
    rearOffsets: [new THREE.Vector3(-hw, 0, wbR), new THREE.Vector3(hw, 0, wbR)],
  };

  // --- helpers (closures over car's wheel arrays) ------------------------------

  // Add four spinning/steering wheels into the (wheel-less) GLB body's arches.
  // Placed SYMMETRICALLY from the model's bounding box — the bodies are generated
  // without tyres, so there's nothing to detect; instead we use the footprint plus
  // per-car fractions (tunable in config: wheelTrack, wheelBase, wheelSize, wheelHubY).
  function rigGLBWheels(def, car, model) {
    let mesh = null;
    model.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
    if (!mesh) return;
    const pos = mesh.geometry.attributes.position;
    // local geometry bbox
    let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
      if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
    }
    // transform the 8 corners by model.matrix -> car-LOCAL AABB (chassis is identity
    // at build, so model.matrix maps model-local -> car-root; setFromObject would give
    // WORLD space, which is wrong once the car is already at its spawn position)
    model.updateMatrix();
    const m = model.matrix, p = new THREE.Vector3();
    let cx0 = 1e9, cz0 = 1e9, cx1 = -1e9, cz1 = -1e9;
    for (const X of [mnx, mxx]) for (const Y of [mny, mxy]) for (const Z of [mnz, mxz]) {
      p.set(X, Y, Z).applyMatrix4(m);
      if (p.x < cx0) cx0 = p.x; if (p.x > cx1) cx1 = p.x;
      if (p.z < cz0) cz0 = p.z; if (p.z > cz1) cz1 = p.z;
    }
    const ctrX = (cx0 + cx1) / 2, ctrZ = (cz0 + cz1) / 2, halfX = (cx1 - cx0) / 2, halfZ = (cz1 - cz0) / 2;
    const r = def.wheelSize || def.wheel || 0.42;    // wheel radius (game units)
    const track = (def.wheelTrack ?? 0.80) * halfX;  // left/right offset from centre
    const base = (def.wheelBase ?? 0.66) * halfZ;    // front/rear offset from centre
    const hubY = def.wheelHubY ?? r;                 // hub height (sits r above ground)
    const shiftZ = def.wheelOffsetZ || 0;            // shift ALL wheels along Z (+ = toward the rear)
    // forward is -Z, so front wheels are at -base
    const spec = [
      { x: track, z: -base, front: true }, { x: -track, z: -base, front: true },
      { x: track, z: base, front: false }, { x: -track, z: base, front: false },
    ];
    for (const w of spec) {
      const spinner = makeWheel(r);
      const anchor = new THREE.Group();
      anchor.position.set(ctrX + w.x, hubY, ctrZ + w.z + shiftZ);
      anchor.add(spinner);
      car.add(anchor); // ROOT — does not roll with the body
      if (w.front) { steerGroups.push(anchor); frontSpinners.push(spinner); }
      else rearSpinners.push(spinner);
    }
  }
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

  const flames = makeFlames(def);
  chassis.add(flames.group);
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
    flameGroup: flames.group,
    flameMat: flames.mat,
    _flame: 0,
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

  // boost flames: ease in/out, flicker length + opacity while lit
  if (car.flameGroup) {
    const target = state.boosting ? 1 : 0;
    car._flame += (target - car._flame) * Math.min(dt * 14, 1);
    const fl = car._flame;
    if (fl > 0.02) {
      car.flameGroup.visible = true;
      car.flameMat.opacity = fl * (0.5 + Math.random() * 0.4);
      car.flameGroup.scale.set(1, 1, 0.6 + fl * (0.7 + Math.random() * 0.6));
    } else {
      car.flameGroup.visible = false;
    }
  }
}
