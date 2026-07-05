// ============================================================================
// main.js — bootstrap, wiring, fixed-timestep loop with render interpolation.
// Integrates car selection, Pro/Simple modes, audio, achievements, and the
// open world's collisions/atmosphere.
// ============================================================================

import * as THREE from 'three';
import { PHYS, PRESETS, PROFILES, CARS, QUALITY, DEFAULT_QUALITY, CYCLE, WEATHER } from './config.js';
import { createRenderer, createScene, applyPreset, applyPresetBlend, onResize } from './scene.js';
import { buildWorld, resolveCollisions, updateCones, updatePosts, applyWorldPreset } from './world.js';
import { buildCar, applyCarVisual } from './car.js';
import { createCarState, stepPhysics, snapshot, snapshotInto } from './physics.js';
import { createInput } from './input.js';
import { createChaseCam } from './camera.js';
import { createEffects } from './effects.js';
import { createScoring } from './scoring.js';
import { createHUD } from './hud.js';
import { createAudio } from './audio.js';
import { createAchievements } from './achievements.js';
import { createHaptics } from './haptics.js';
import { createTrials } from './trials.js';
import { createWeather } from './weather.js';

const el = (id) => document.getElementById(id);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
// drive the CSS accent (+ derived tints) from the active time-of-day neon so the
// whole UI recolours with the sky (golden → dawn → night). See DESIGN.md.
function setAccent(hexNum) {
  const r = (hexNum >> 16) & 255, g = (hexNum >> 8) & 255, b = hexNum & 255;
  const s = document.documentElement.style;
  s.setProperty('--accent', `rgb(${r},${g},${b})`);
  s.setProperty('--accent-soft', `rgba(${r},${g},${b},0.13)`);
  s.setProperty('--accent-dim', `rgba(${r},${g},${b},0.42)`);
  s.setProperty('--accent-glow', `rgba(${r},${g},${b},0.5)`);
}
const darken = (c) => {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  return hex(((r * 0.45) << 16) | ((g * 0.45) << 8) | (b * 0.45));
};

const BASE_ENGINE = PHYS.engine;
const BASE_SPEED = PHYS.maxSpeed;

const mount = el('app');
const renderer = createRenderer(mount);
const ctx = createScene();
const presetOrder = ['golden', 'dawn', 'night'];
let presetIdx = 0;
applyPreset(ctx, renderer, presetOrder[presetIdx]);

const world = buildWorld(ctx.scene, ctx.preset);
applyWorldPreset(world, ctx.preset);

// ---- graphics quality (caps GPU load / heat) ------------------------------
let targetFrameMs = 1000 / 60;
let shadowEvery = 2;
let shadowTick = 0;
let layoutReady = false; // true once applyLayout() has run (handles rotation-aware sizing)
let qualityKey = localStorage.getItem('cooldrive.quality') || DEFAULT_QUALITY;
function setQuality(key) {
  const q = QUALITY[key] || QUALITY.medium;
  qualityKey = key;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (layoutReady) applyLayout(); // re-apply rotation-aware size after a pixelRatio change
  ctx.sun.shadow.mapSize.set(q.shadow, q.shadow);
  if (ctx.sun.shadow.map) { ctx.sun.shadow.map.dispose(); ctx.sun.shadow.map = null; }
  renderer.shadowMap.needsUpdate = true;
  targetFrameMs = 1000 / q.fps;
  shadowEvery = q.shadowEvery;
  if (world && world.setQuality) world.setQuality(key); // streaming radius per tier
  try { localStorage.setItem('cooldrive.quality', key); } catch (e) {}
}
setQuality(qualityKey);

const audio = createAudio();
const ach = createAchievements();
const hud = createHUD();
const input = createInput();
const isMobile = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
if (isMobile) document.body.classList.add('mobile');
const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const haptics = createHaptics(isNative); // native-only; no-ops on web
const scoring = createScoring();
const effects = createEffects(ctx.scene);
effects.setAccent(ctx.preset.neon);
const trials = createTrials({ scene: ctx.scene, streamer: world.streamer, scoring, hud, onComplete: () => { ringRunTotal += 1; } });
const weather = createWeather(ctx.scene);

// compass helpers
const LM_ICON = { circuit: '🏁', town: '🌃', slalom: '⛳', skidpad: '🅿️', park: '🛝', gate: '⛩️', lookout: '🗼' };
const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + 'km' : Math.round(m) + 'm');
let lastRegionKey = null;
const regionSeen = new Set();

// ---- car (rebuilt on selection) -------------------------------------------
let selectedCarIndex = 0;
let mode = 'pro'; // PRO is the default
let car = null;
let cam = null;

function disposeCar(c) {
  if (!c) return;
  c.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
  ctx.scene.remove(c.group);
}

function buildSelectedCar() {
  const prevMode = cam ? cam.mode : 'chase';
  disposeCar(car);
  car = buildCar(CARS[selectedCarIndex]);
  ctx.scene.add(car.group);
  cam = createChaseCam(ctx.camera, car);
  cam.setMode(prevMode);
  cam.reset();
}
buildSelectedCar();

const carState = createCarState(0, 0, 0);
const SPAWN = { x: 40, z: -30, heading: 2.0 };

// ---- tuning: mode profile + car multipliers -------------------------------
let wetMul = 1; // 1 dry, WEATHER.gripMul while raining (composed from base here)
function applyTuning() {
  const p = PROFILES[mode];
  const c = CARS[selectedCarIndex];
  PHYS.gripNormal = p.gripNormal * c.gripMul * wetMul;
  PHYS.gripDrift = p.gripDrift * c.gripMul * wetMul;
  PHYS.handbrakeGrip = p.handbrakeGrip * c.gripMul * wetMul;
  PHYS.kAssist = p.kAssist;
  PHYS.driftSlipFactor = p.driftSlipFactor;
  PHYS.driftYawMul = p.driftYawMul;
  PHYS.engine = BASE_ENGINE * c.engineMul;
  PHYS.maxSpeed = BASE_SPEED * c.speedMul;
  // reflect into sliders
  setSlider('assist', PHYS.kAssist, (v) => v.toFixed(1));
  setSlider('gripDrift', PHYS.gripDrift, (v) => v.toFixed(2));
  setSlider('engine', PHYS.engine, (v) => v.toFixed(0));
}
function setSlider(id, val, fmt) {
  const s = el(id), out = el(id + 'Val');
  if (s) s.value = val;
  if (out) out.textContent = fmt ? fmt(Number(val)) : val;
}

// ---- interpolation state ---------------------------------------------------
let prev = snapshot(carState);
let curr = snapshot(carState);
const render = { x: SPAWN.x, z: SPAWN.z, heading: SPAWN.heading, steerAngle: 0, speed: 0 };
function lerpAngle(a, b, t) { const d = Math.atan2(Math.sin(b - a), Math.cos(b - a)); return a + d * t; }

function resetCarState(x = SPAWN.x, z = SPAWN.z, heading = SPAWN.heading) {
  carState.x = x; carState.z = z; carState.heading = heading;
  carState.vx = 0; carState.vz = 0; carState.omega = 0; carState.steerAngle = 0;
  carState.grip = PHYS.gripNormal; carState.boost = 0;
  carState.forwardSpeed = 0; carState.lateralSpeed = 0; carState.slip = 0; carState.speed = 0;
  carState.drifting = false; carState.intensity = 0; carState.boosting = false;
}
resetCarState();
prev = snapshot(carState); curr = snapshot(carState);

function trackSun() {
  ctx.sun.position.set(car.group.position.x + ctx.preset.sunPos[0], ctx.preset.sunPos[1], car.group.position.z + ctx.preset.sunPos[2]);
  ctx.sun.target.position.set(car.group.position.x, 0, car.group.position.z);
  ctx.sun.target.updateMatrixWorld();
}

// ---- game flow -------------------------------------------------------------
let running = false;
const clock = new THREE.Clock();
let acc = 0;

function startGame() {
  if (running) return;
  audio.start(); // unlock/resume audio FIRST — before the gyro-permission dialog can interfere
  if (isMobile && !input.isMotionActive()) input.enableMotion(); // gesture-gated on iOS
  running = true;
  document.body.classList.add('playing'); // triggers the one-time zone-hint fade
  el('startScreen').classList.add('hidden');
  applyTuning();
  rollWeather(); // roll this session's weather (clear / rain / surprise)
  ach.event('car', CARS[selectedCarIndex].id);
  clock.start();
  clock.getDelta();
}

function resetCar() {
  scoring.bank();
  // far from home, R drops you back onto the nearest road (facing along it) instead
  // of teleporting all the way home; near home it still returns to the fixed spawn.
  let placed = false;
  if (world.homeDist && world.homeDist(carState.x, carState.z) > 3000 && world.nearestRoad) {
    const r = world.nearestRoad(carState.x, carState.z);
    if (r) { resetCarState(r.x, r.z, r.heading); placed = true; }
  }
  if (!placed) resetCarState();
  car.prevFwd = 0;
  car.chassis.rotation.set(0, 0, 0);
  prev = snapshot(carState); curr = snapshot(carState);
  effects.reset();
  cam.reset();
}

function cyclePreset() {
  audio.sfx.ui();
  if (autoCycle) { cycleT = (Math.floor(cycleT) + 1) % presetOrder.length; return; } // jump to next keyframe
  presetIdx = (presetIdx + 1) % presetOrder.length;
  const key = presetOrder[presetIdx];
  const p = applyPreset(ctx, renderer, key);
  applyWorldPreset(world, p);
  setAccent(p.neon);
  effects.setAccent(p.neon);
  el('presetName').textContent = p.name;
  renderer.shadowMap.needsUpdate = true; // the sun jumped — refresh shadows now
  if (key === 'night') ach.event('night');
}

// ---- auto day/night cycle --------------------------------------------------
let autoCycle = true;
try { autoCycle = (localStorage.getItem('cooldrive.autocycle') || '1') !== '0'; } catch (e) {}
let cycleT = 0, cycleAcc = 0;
function updateCycle(dt) {
  if (!autoCycle) return;
  cycleT += dt / CYCLE.secondsPerLeg;
  while (cycleT >= presetOrder.length) cycleT -= presetOrder.length;
  const i = Math.floor(cycleT), t = cycleT - i;
  const bl = applyPresetBlend(ctx, renderer, presetOrder[i], presetOrder[(i + 1) % presetOrder.length], t);
  world.setNight(bl.night); // smooth light fade every frame
  cycleAcc += dt;
  if (cycleAcc >= 0.2) { // throttle accent / neon recolor / label
    cycleAcc = 0;
    setAccent(bl.neon); effects.setAccent(bl.neon); world.setNeon(bl.neon);
    el('presetName').textContent = bl.name;
    if (bl.night > 0.6) ach.event('night');
    renderer.shadowMap.needsUpdate = true; // sun keeps moving
  }
}

// ---- weather ---------------------------------------------------------------
let weatherMode = 'surprise';
try { weatherMode = localStorage.getItem('cooldrive.weather') || 'surprise'; } catch (e) {}
let wet = false;
function applyWeather(raining) {
  wet = raining;
  wetMul = raining ? WEATHER.gripMul : 1;
  applyTuning();
  world.setWet(raining ? 1 : 0);
  effects.setWet(raining);
  weather.setRain(raining);
}
function rollWeather() {
  const raining = weatherMode === 'rain' || (weatherMode === 'surprise' && Math.random() < WEATHER.surpriseChance);
  applyWeather(raining);
}
function setWeatherMode(m) { weatherMode = m; try { localStorage.setItem('cooldrive.weather', m); } catch (e) {} rollWeather(); }
function setAutoCycle(on) { autoCycle = !!on; try { localStorage.setItem('cooldrive.autocycle', on ? '1' : '0'); } catch (e) {} }
// wet-fog thickening — runs every frame regardless of auto-cycle. With the cycle ON the
// blend just reset fog to its base this frame (multiply once); with it OFF, set from the
// current preset's base × factor so it's idempotent and reverts cleanly when it dries.
function applyFogWet() {
  const f = ctx.scene.fog; if (!f) return;
  if (autoCycle) { if (wet) { f.near *= WEATHER.fogPull; f.far *= WEATHER.fogPull; } }
  else { const p = PRESETS[presetOrder[presetIdx]]; const k = wet ? WEATHER.fogPull : 1; f.near = p.fogNear * k; f.far = p.fogFar * k; }
}

// ---- car/mode selection (start screen + settings) -------------------------
function refreshSel() {
  document.querySelectorAll('.mode').forEach((m) => m.classList.toggle('sel', m.dataset.mode === mode));
  document.querySelectorAll('.carcard, .settingsCar').forEach((c) => c.classList.toggle('sel', Number(c.dataset.i) === selectedCarIndex));
}
// switch car. resetPos=true on the start screen; false when changing mid-game in settings
function selectCar(i, resetPos) {
  selectedCarIndex = i;
  buildSelectedCar();
  if (resetPos) { resetCarState(); prev = snapshot(carState); curr = snapshot(carState); }
  applyTuning();
  ach.event('car', CARS[i].id);
  refreshSel();
  audio.sfx.select();
  drainAchievements();
}
function buildStartUI() {
  const modeRow = el('modeRow');
  modeRow.innerHTML = '';
  for (const key of ['pro', 'simple']) {
    const p = PROFILES[key];
    const d = document.createElement('div');
    d.className = 'mode';
    d.dataset.mode = key;
    d.innerHTML = `<div class="mname">${p.label}</div><div class="mblurb">${p.blurb}</div>`;
    d.addEventListener('click', (e) => { e.stopPropagation(); mode = key; applyTuning(); refreshSel(); audio.sfx.select(); });
    modeRow.appendChild(d);
  }
  const carRow = el('carRow');
  carRow.innerHTML = '';
  CARS.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'carcard';
    d.dataset.i = i;
    d.innerHTML = `<div class="swatch" style="background:linear-gradient(160deg, ${hex(c.color)}, ${darken(c.color)})"></div><div class="cname">${c.name}</div><div class="ctag">${c.tag}</div>`;
    d.addEventListener('click', (e) => { e.stopPropagation(); selectCar(i, true); });
    carRow.appendChild(d);
  });
  // compact car switcher in Settings (change car mid-game, no reload)
  const setRow = el('settingsCarRow');
  if (setRow) {
    setRow.innerHTML = '';
    CARS.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'settingsCar';
      b.dataset.i = i;
      b.innerHTML = `<span class="sw" style="background:${hex(c.color)}"></span>${c.name}`;
      b.addEventListener('click', () => selectCar(i, false));
      setRow.appendChild(b);
    });
  }
  refreshSel();
}

// ---- settings + radio wiring ----------------------------------------------
function bindSlider(id, apply, fmt) {
  const s = el(id), out = el(id + 'Val');
  const sync = () => { apply(Number(s.value)); if (out) out.textContent = fmt ? fmt(Number(s.value)) : s.value; };
  s.addEventListener('input', sync);
}
bindSlider('assist', (v) => (PHYS.kAssist = v), (v) => v.toFixed(1));
bindSlider('gripDrift', (v) => (PHYS.gripDrift = v), (v) => v.toFixed(2));
bindSlider('engine', (v) => (PHYS.engine = v), (v) => v.toFixed(0));
bindSlider('sfx', (v) => audio.setSfxVol(v / 100), (v) => v.toFixed(0));
bindSlider('music', (v) => audio.setMusicVol(v / 100), (v) => v.toFixed(0));
const qualitySel = el('quality');
if (qualitySel) {
  qualitySel.value = qualityKey;
  qualitySel.addEventListener('change', () => { setQuality(qualitySel.value); audio.sfx.ui(); });
}
const weatherSel = el('weatherSel');
if (weatherSel) {
  weatherSel.value = weatherMode;
  weatherSel.addEventListener('change', () => { setWeatherMode(weatherSel.value); audio.sfx.ui(); });
}
const autoCycleEl = el('autoCycle');
if (autoCycleEl) {
  autoCycleEl.checked = autoCycle;
  autoCycleEl.addEventListener('change', () => { setAutoCycle(autoCycleEl.checked); audio.sfx.ui(); });
}
const hapticsEl = el('hapticsToggle');
if (hapticsEl) {
  hapticsEl.checked = haptics.enabled;
  hapticsEl.addEventListener('change', () => { haptics.setEnabled(hapticsEl.checked); if (hapticsEl.checked) haptics.impact('LIGHT'); });
}
if (isNative) document.body.classList.add('native');
el('presetBtn').addEventListener('click', cyclePreset);

const settingsEl = el('settings');
function toggleSettings() { settingsEl.classList.toggle('open'); if (settingsEl.classList.contains('open')) hud.renderAchievements(ach.progress()); }

el('radioPower').addEventListener('click', () => { audio.start(); const on = audio.radioToggle(); hud.setRadio(audio.station(), on); audio.sfx.ui(); });
el('radioNext').addEventListener('click', () => { audio.start(); const name = audio.nextStation(); hud.setRadio(name || audio.station(), audio.isRadioOn()); audio.sfx.ui(); });
el('radioMute').addEventListener('click', () => { const m = audio.toggleMute(); el('radioMute').textContent = m ? '🔇' : '🔊'; });
audio.setOnRadioError((name) => { el('radioName').textContent = '⚠ ' + name + ' unavailable'; el('radioPower').classList.remove('on'); });

// mobile controls: invisible touch zones + boost button + tilt settings + gear
input.bindZones(); // gas/brake/handbrake/boost all read from window-level multitouch
el('gearBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); audio.sfx.ui(); });
el('settingsClose').addEventListener('click', () => { settingsEl.classList.remove('open'); audio.sfx.ui(); });
el('camBtn').addEventListener('click', (e) => { e.stopPropagation(); if (cam) cam.cycle(); audio.sfx.ui(); });
bindSlider('tiltSens', (v) => input.setTiltSensitivity(v), (v) => v.toFixed(1));
el('tiltInvert').addEventListener('change', (e) => input.setTiltInvert(e.target.checked));
el('recenterBtn').addEventListener('click', () => { input.recenterTilt(); audio.sfx.ui(); });

window.addEventListener('keydown', startGame, { once: false });
el('startScreen').addEventListener('click', startGame);
el('btnStart').addEventListener('click', (e) => { e.stopPropagation(); startGame(); });
// Unlock/resume the WebAudio context. iOS often needs the resume to land on a
// gesture with an ALREADY-created context (creating + resuming in one gesture
// leaves it suspended — that's why toggling the radio was what unstuck it). So we
// retry on EVERY gesture (pointer/touch/click/key) until the context is actually
// running, THEN stop. This makes car SFX start on the first tap, no radio needed.
const UNLOCK_EVENTS = ['keydown', 'pointerdown', 'touchend', 'click'];
function unlockAudio() {
  audio.start();
  if (audio.isRunning()) UNLOCK_EVENTS.forEach((ev) => window.removeEventListener(ev, unlockAudio, true));
}
function armUnlock() {
  // re-adding an identical listener is a no-op, so this is safe to call repeatedly
  UNLOCK_EVENTS.forEach((ev) => window.addEventListener(ev, unlockAudio, { capture: true, passive: true }));
}
armUnlock();
// iOS suspends ('interrupted') the context and pauses media on calls/Siri/lock/
// backgrounding and never revives them itself. On return to foreground: try to
// resume directly, and if that needs a user gesture, re-arm the tap unlock.
function reviveAudio() {
  if (document.visibilityState !== 'visible') return;
  audio.start();
  if (!audio.isRunning()) armUnlock();
}
document.addEventListener('visibilitychange', reviveAudio);
window.addEventListener('pageshow', reviveAudio);
// ---- layout / orientation --------------------------------------------------
// On a PORTRAIT mobile browser, rotate the whole game 90° to landscape so it
// fills the roomy portrait viewport (slowroads-style) — no forced landscape, no
// Add-to-Home requirement. On desktop / landscape / the native app: no rotation.
const rotorEl = el('rotor');
function applyLayout() {
  const vv = window.visualViewport;
  const vw = Math.round((vv && vv.width) || window.innerWidth);
  const vh = Math.round((vv && vv.height) || window.innerHeight);
  const rotate = isMobile && vh > vw; // portrait viewport on a phone
  document.body.classList.toggle('rotated', rotate);
  input.setRotated(rotate, vw, vh);
  if (rotate) {
    // a landscape box (vh × vw) rotated 90° CW about the top-left, shifted right
    // by vw so it lands exactly over the portrait viewport
    rotorEl.style.width = vh + 'px';
    rotorEl.style.height = vw + 'px';
    rotorEl.style.left = vw + 'px';
    rotorEl.style.top = '0px';
    rotorEl.style.transform = 'rotate(90deg)';
    renderer.setSize(vh, vw);
    ctx.camera.aspect = vh / vw;
  } else {
    rotorEl.style.width = rotorEl.style.height = rotorEl.style.left = rotorEl.style.top = rotorEl.style.transform = '';
    renderer.setSize(vw, vh);
    ctx.camera.aspect = vw / vh;
  }
  ctx.camera.updateProjectionMatrix();
  layoutReady = true;
}
window.addEventListener('resize', applyLayout);
window.addEventListener('orientationchange', () => setTimeout(applyLayout, 250));
if (window.visualViewport) window.visualViewport.addEventListener('resize', applyLayout);

// ---- achievements drain ----------------------------------------------------
function drainAchievements() {
  let a, any = false;
  while ((a = ach.consume())) {
    hud.toast(a);
    audio.sfx.achievement();
    any = true;
  }
  if (any) hud.renderAchievements(ach.progress());
}

// ---- main loop -------------------------------------------------------------
const MAX_STEPS = 8;
let wasBoosting = false;
let distance = 0;
let topSpeed = 0;
let bestCombo = 0;
let trackDriftSec = 0;
let procDriftSec = 0;
let farthest = 0;
let nearMissTotal = 0;
let ringRunTotal = 0;
let regionsSeen = 0;
let procTownCheckAcc = 0;
let lastFrameTime = 0;

function frame(now) {
  requestAnimationFrame(frame);
  // frame-rate cap: on high-refresh displays this is the single biggest heat saver
  if (now && now - lastFrameTime < targetFrameMs - 1.5) return;
  lastFrameTime = now || 0;
  let dt = clock.getDelta();
  if (dt > 0.1) dt = 0.1;

  const cmd = input.sample();
  if (input.consumePressed('r')) resetCar();
  if (input.consumePressed('c')) { if (cam) cam.cycle(); audio.sfx.ui(); }
  if (input.consumePressed('p')) cyclePreset();
  if (input.consumePressed('escape')) toggleSettings();
  if (input.consumePressed('m')) { const m = audio.toggleMute(); el('radioMute').textContent = m ? '🔇' : '🔊'; }

  updateCycle(dt); // auto day/night lerp (runs even on the start screen) — before trackSun
  applyFogWet(); // wet-weather fog thickening (works with cycle on or off)

  let crashed = false;
  let coneHits = 0;
  let postHits = 0;

  if (running) {
    acc += dt;
    let steps = 0;
    while (acc >= PHYS.STEP && steps < MAX_STEPS) {
      const _tmp = prev; prev = curr; curr = _tmp; // ping-pong the two buffers (no per-step alloc)
      stepPhysics(carState, cmd, PHYS.STEP);
      const col = resolveCollisions(carState, world);
      if (col.crash) { scoring.fail(); crashed = true; }
      coneHits += col.cones;
      postHits += col.posts;
      nearMissTotal += col.nearMisses;
      scoring.step(carState, PHYS.STEP, col); // col carries near-miss shaves this substep
      snapshotInto(curr, carState);
      acc -= PHYS.STEP;
      steps++;
    }
    if (steps >= MAX_STEPS) acc = 0;

    // session stats for achievements
    distance += carState.speed * dt;
    topSpeed = Math.max(topSpeed, carState.forwardSpeed);
    bestCombo = Math.max(bestCombo, scoring.st.multiplier);
    if (Math.hypot(carState.x - world.townCenter.x, carState.z - world.townCenter.z) < 70) ach.event('town');
    // credit drifting done inside the walled drift track (for the Track Rat achievement)
    if (carState.drifting && carState.speed > PHYS.minDriftSpeed && world.onDriftTrack(carState.x, carState.z)) {
      trackDriftSec += dt;
    }
    // procedural-world progress: farthest reach, drifting a wild circuit, finding a wild town
    farthest = Math.max(farthest, world.homeDist(carState.x, carState.z));
    if (carState.drifting && carState.speed > PHYS.minDriftSpeed && world.onProcCircuit(carState.x, carState.z)) {
      procDriftSec += dt;
    }
    // drive through a gate arch → a boost top-up (latches once per visit)
    if (world.onProcGate(carState.x, carState.z)) { // drive through a gate arch → free FULL boost
      carState.boost = 1;
      audio.sfx.best(); haptics.impact('MEDIUM');
      hud.celebrate('BOOST!', 'gate cleared — punch it', '#44ffd6');
    }
    procTownCheckAcc += dt;
    if (procTownCheckAcc >= 0.25) { // scanning every chunk is O(records) — throttle to 4 Hz
      procTownCheckAcc = 0;
      if (world.onProcTown(carState.x, carState.z)) ach.event('proctown');
      // compass: home + nearest landmarks
      const shift = world.streamer.shiftTotal;
      const targets = [];
      const hd = world.homeDist(carState.x, carState.z);
      if (hd > 500) targets.push({ icon: '⌂', dist: fmtDist(hd), rx: -shift.x, rz: -shift.z });
      for (const l of world.nearestLandmarks(carState.x, carState.z, 3)) targets.push({ icon: LM_ICON[l.kind] || '◆', dist: fmtDist(l.d), rx: l.rx, rz: l.rz });
      hud.setCompass(targets);
      // region discovery toast
      const reg = world.regionAt(carState.x, carState.z);
      if (reg.key !== lastRegionKey) {
        lastRegionKey = reg.key;
        if (!regionSeen.has(reg.key)) {
          regionSeen.add(reg.key); regionsSeen = regionSeen.size;
          if (regionsSeen > 1 && reg.name !== 'Home Turf') hud.toast({ icon: '🧭', name: reg.name, desc: 'New region discovered' }, 'NEW REGION', 'region');
        }
      }
    }
    ach.update({ score: scoring.st.score, bestCombo, longestDrift: scoring.st.longestDrift, topSpeed, distance, trackDriftTime: trackDriftSec, procDriftTime: procDriftSec, farthest, nearMisses: nearMissTotal, bestLinks: scoring.st.bestLinks, ringRuns: ringRunTotal, regionsSeen });
  }

  // stream chunks around the car + maybe rebase the origin. Runs AFTER physics and
  // BEFORE interpolation/camera so a rebase shift is atomic within the frame.
  world.update(carState, dt);
  if (running) trials.update(carState, dt); // ring time-trials on wild circuits

  // interpolate render transform
  const alpha = Math.min(acc / PHYS.STEP, 1);
  render.x = prev.x + (curr.x - prev.x) * alpha;
  render.z = prev.z + (curr.z - prev.z) * alpha;
  render.heading = lerpAngle(prev.heading, curr.heading, alpha);
  render.steerAngle = prev.steerAngle + (curr.steerAngle - prev.steerAngle) * alpha;
  render.speed = carState.speed;

  applyCarVisual(car, render, carState, cmd, dt);
  trackSun();
  if (cam) cam.update(carState, dt, isMobile && input.isMotionActive() ? input.deviceRoll() * 0.6 : 0);
  effects.update(render, car.rearOffsets, carState, dt);
  updateCones(world, dt);
  updatePosts(world, dt);
  world.updateAtmosphere(ctx.camera.position, dt);
  weather.update(ctx.camera.position, dt);
  car.tlMat.emissiveIntensity = cmd.brake || cmd.handbrake ? 2.4 : 1.0;

  // audio
  if (running) {
    audio.updateEngine(carState.speed, cmd.throttle, PHYS.maxSpeed);
    audio.updateSkid(carState.drifting ? carState.intensity + 0.15 : 0);
  }

  // capture HUD events before hud consumes them
  const bankedAmt = scoring.st.justBanked;
  const bankedMult = scoring.st.justBankedMult;
  const isNewBest = scoring.st.justBest > 0;
  const nearMissAmt = scoring.st.justNearMiss;
  const linkAmt = scoring.st.justLink;
  hud.update(scoring.st, carState, dt);

  // event-driven audio + haptics + achievements
  if (bankedAmt > 0) {
    audio.sfx.combo(bankedMult);
    ach.event('drift');
    haptics.impact(isNewBest ? 'MEDIUM' : 'LIGHT');
    if (isNewBest) { audio.sfx.best(); haptics.notify('SUCCESS'); }
  }
  if (nearMissAmt > 0) { audio.sfx.ui(); haptics.impact('LIGHT'); } // CLOSE SHAVE tick
  if (linkAmt > 0) haptics.impact('LIGHT');
  if (crashed) { audio.sfx.hit(); ach.event('crash'); haptics.impact('HEAVY'); }
  for (let i = 0; i < coneHits; i++) ach.event('cone');
  if (coneHits || postHits) audio.sfx.ui();
  if (carState.boosting && !wasBoosting) { audio.sfx.boost(); ach.event('boost'); haptics.impact('MEDIUM'); }
  if (carState.boosting !== wasBoosting) document.body.classList.toggle('boosting', carState.boosting); // speed lines
  wasBoosting = carState.boosting;
  drainAchievements();

  // shadow update: normally throttled to every Nth frame, but forced immediately when
  // the streamer signals it changed the scene (chunk activated/unloaded, or a rebase) —
  // otherwise fresh casters render against a stale shadow map for a frame or two.
  if (world.consumeShadowDirty() || ++shadowTick >= shadowEvery) { renderer.shadowMap.needsUpdate = true; shadowTick = 0; }
  renderer.render(ctx.scene, ctx.camera);
  updateHud(dt); // dev perf overlay (read renderer.info AFTER the render)
}

// expose a tiny debug handle
window.__game = { carState, scoring, PHYS, input, world, ach, audio, ctx, renderer, get cam() { return cam; }, start: startGame, reset: resetCar };

buildStartUI();
// these hints are Safari/web-only — never show them inside the native (Capacitor) app
if (!isNative && isMobile && !window.isSecureContext) { const w = el('secureWarn'); if (w) w.style.display = 'block'; }
// (Add-to-Home is no longer required — portrait now renders the game rotated to
// landscape and fills the screen, so we don't nag about fullscreen.)
applyLayout();
applyTuning();
setAccent(ctx.preset.neon); // initial accent from the starting preset
hud.renderAchievements(ach.progress());
el('presetName').textContent = ctx.preset.name;

// floating-origin rebase: when the streamer recenters the world, shift the car,
// interpolation snapshots, camera and effects by the same delta so nothing jumps.
world.setRebase((dx, dz) => {
  carState.x -= dx; carState.z -= dz;
  prev.x -= dx; prev.z -= dz; curr.x -= dx; curr.z -= dz;
  render.x -= dx; render.z -= dz;
  if (cam) cam.shift(-dx, -dz);
  effects.shift(-dx, -dz);
  hud.shiftCompass(-dx, -dz); // cached compass targets are render coords too
});
world.setQuality(qualityKey); // apply the initial streaming radius

// ---- dev perf HUD — draw calls / fps / memory / streaming depth. The instrument
// for on-device thermal & memory soaks. Toggle with the ` (backtick) key, or start
// it enabled with ?hud in the URL. Costs nothing while hidden.
const dbgHud = document.createElement('div');
dbgHud.id = 'perfHud';
dbgHud.style.cssText = 'position:fixed;top:118px;left:16px;z-index:9999;font:11px/1.5 ui-monospace,Menlo,monospace;color:#9ff0d8;background:rgba(8,12,20,.6);padding:8px 11px;border-radius:8px;white-space:pre;pointer-events:none;letter-spacing:.02em';
document.body.appendChild(dbgHud);
let hudOn = /[?&]hud\b/.test(location.search);
dbgHud.style.display = hudOn ? 'block' : 'none';
window.addEventListener('keydown', (e) => {
  if (e.key === '`' || e.code === 'Backquote') { hudOn = !hudOn; dbgHud.style.display = hudOn ? 'block' : 'none'; }
});
let fpsEMA = 60, hudAcc = 0;
function updateHud(dtSec) {
  if (!hudOn) return;
  if (dtSec > 0) fpsEMA += (1 / dtSec - fpsEMA) * 0.1;
  hudAcc += dtSec;
  if (hudAcc < 0.25) return; // refresh 4x/s — readable, cheap
  hudAcc = 0;
  const inf = renderer.info, st = world.streamer;
  dbgHud.textContent =
    `fps   ${fpsEMA.toFixed(0).padStart(3)}    ${(1000 / Math.max(fpsEMA, 1)).toFixed(1)} ms\n` +
    `draws ${String(inf.render.calls).padStart(4)}   tris ${(inf.render.triangles / 1000).toFixed(0)}k\n` +
    `geo   ${String(inf.memory.geometries).padStart(4)}   tex  ${String(inf.memory.textures).padStart(3)}\n` +
    `chunk ${String(st.chunkCount).padStart(4)}   queue ${st.queueDepth}\n` +
    `pos   ${carState.x.toFixed(0)}, ${carState.z.toFixed(0)}   home ${world.homeDist(carState.x, carState.z).toFixed(0)} m`;
}

// Warm up shader compilation up front: the home region, the chunks primed around
// spawn, the effects and the car are all already in the scene, so this compiles the
// shared material/shadow/light variants the streamer reuses — avoiding a first-
// encounter stutter mid-drive. One boot-time compile covers the reused set.
try { renderer.compile(ctx.scene, ctx.camera); } catch (e) {}

frame();
