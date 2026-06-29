// ============================================================================
// main.js — bootstrap, wiring, fixed-timestep loop with render interpolation.
// Integrates car selection, Pro/Simple modes, audio, achievements, and the
// open world's collisions/atmosphere.
// ============================================================================

import * as THREE from 'three';
import { PHYS, PRESETS, PROFILES, CARS, QUALITY, DEFAULT_QUALITY } from './config.js';
import { createRenderer, createScene, applyPreset, onResize } from './scene.js';
import { buildWorld, resolveCollisions, updateCones, updatePosts, applyWorldPreset } from './world.js';
import { buildCar, applyCarVisual } from './car.js';
import { createCarState, stepPhysics, snapshot } from './physics.js';
import { createInput } from './input.js';
import { createChaseCam } from './camera.js';
import { createEffects } from './effects.js';
import { createScoring } from './scoring.js';
import { createHUD } from './hud.js';
import { createAudio } from './audio.js';
import { createAchievements } from './achievements.js';

const el = (id) => document.getElementById(id);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
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
let qualityKey = localStorage.getItem('cooldrive.quality') || DEFAULT_QUALITY;
function setQuality(key) {
  const q = QUALITY[key] || QUALITY.medium;
  qualityKey = key;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  ctx.sun.shadow.mapSize.set(q.shadow, q.shadow);
  if (ctx.sun.shadow.map) { ctx.sun.shadow.map.dispose(); ctx.sun.shadow.map = null; }
  renderer.shadowMap.needsUpdate = true;
  targetFrameMs = 1000 / q.fps;
  shadowEvery = q.shadowEvery;
  try { localStorage.setItem('cooldrive.quality', key); } catch (e) {}
}
setQuality(qualityKey);

const audio = createAudio();
const ach = createAchievements();
const hud = createHUD();
const input = createInput();
const isMobile = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
if (isMobile) document.body.classList.add('mobile');
const scoring = createScoring();
const effects = createEffects(ctx.scene);

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
function applyTuning() {
  const p = PROFILES[mode];
  const c = CARS[selectedCarIndex];
  PHYS.gripNormal = p.gripNormal * c.gripMul;
  PHYS.gripDrift = p.gripDrift * c.gripMul;
  PHYS.handbrakeGrip = p.handbrakeGrip * c.gripMul;
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

function resetCarState() {
  carState.x = SPAWN.x; carState.z = SPAWN.z; carState.heading = SPAWN.heading;
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
  if (isMobile && !input.isMotionActive()) input.enableMotion(); // gesture-gated on iOS
  running = true;
  document.body.classList.add('playing'); // triggers the one-time zone-hint fade
  el('startScreen').classList.add('hidden');
  applyTuning();
  ach.event('car', CARS[selectedCarIndex].id);
  audio.start();
  clock.start();
  clock.getDelta();
}

function resetCar() {
  scoring.bank();
  resetCarState();
  car.prevFwd = 0;
  car.chassis.rotation.set(0, 0, 0);
  prev = snapshot(carState); curr = snapshot(carState);
  effects.reset();
  cam.reset();
}

function cyclePreset() {
  presetIdx = (presetIdx + 1) % presetOrder.length;
  const key = presetOrder[presetIdx];
  const p = applyPreset(ctx, renderer, key);
  applyWorldPreset(world, p);
  el('presetName').textContent = p.name;
  if (key === 'night') ach.event('night');
  audio.sfx.ui();
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
el('presetBtn').addEventListener('click', cyclePreset);

const settingsEl = el('settings');
function toggleSettings() { settingsEl.classList.toggle('open'); if (settingsEl.classList.contains('open')) hud.renderAchievements(ach.progress()); }

el('radioPower').addEventListener('click', () => { audio.start(); const on = audio.radioToggle(); hud.setRadio(audio.station(), on); audio.sfx.ui(); });
el('radioNext').addEventListener('click', () => { audio.start(); const name = audio.nextStation(); hud.setRadio(name || audio.station(), audio.isRadioOn()); audio.sfx.ui(); });
el('radioMute').addEventListener('click', () => { const m = audio.toggleMute(); el('radioMute').textContent = m ? '🔇' : '🔊'; });
audio.setOnRadioError((name) => { el('radioName').textContent = '⚠ ' + name + ' unavailable'; el('radioPower').classList.remove('on'); });

// mobile controls: invisible touch zones + boost button + tilt settings + gear
input.bindZones(el('touchLayer'));
input.bindHold(el('btnBoostM'), 'boost');
el('gearBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); audio.sfx.ui(); });
el('settingsClose').addEventListener('click', () => { settingsEl.classList.remove('open'); audio.sfx.ui(); });
el('camBtn').addEventListener('click', (e) => { e.stopPropagation(); if (cam) cam.cycle(); audio.sfx.ui(); });
bindSlider('tiltSens', (v) => input.setTiltSensitivity(v), (v) => v.toFixed(1));
el('tiltInvert').addEventListener('change', (e) => input.setTiltInvert(e.target.checked));
el('recenterBtn').addEventListener('click', () => { input.recenterTilt(); audio.sfx.ui(); });

window.addEventListener('keydown', startGame, { once: false });
el('startScreen').addEventListener('click', startGame);
el('btnStart').addEventListener('click', (e) => { e.stopPropagation(); startGame(); });
window.addEventListener('resize', () => onResize(ctx, renderer));
window.addEventListener('orientationchange', () => setTimeout(() => onResize(ctx, renderer), 250));
if (window.visualViewport) window.visualViewport.addEventListener('resize', () => onResize(ctx, renderer));

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

  let crashed = false;
  let coneHits = 0;
  let postHits = 0;

  if (running) {
    acc += dt;
    let steps = 0;
    while (acc >= PHYS.STEP && steps < MAX_STEPS) {
      prev = curr;
      stepPhysics(carState, cmd, PHYS.STEP);
      const col = resolveCollisions(carState, world);
      if (col.crash) { scoring.fail(); crashed = true; }
      coneHits += col.cones;
      postHits += col.posts;
      scoring.step(carState, PHYS.STEP);
      curr = snapshot(carState);
      acc -= PHYS.STEP;
      steps++;
    }
    if (steps >= MAX_STEPS) acc = 0;

    // session stats for achievements
    distance += carState.speed * dt;
    topSpeed = Math.max(topSpeed, carState.forwardSpeed);
    bestCombo = Math.max(bestCombo, scoring.st.multiplier);
    if (Math.hypot(carState.x - world.townCenter.x, carState.z - world.townCenter.z) < 70) ach.event('town');
    ach.update({ score: scoring.st.score, bestCombo, longestDrift: scoring.st.longestDrift, topSpeed, distance });
  }

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
  hud.update(scoring.st, carState, dt);

  // event-driven audio + achievements
  if (bankedAmt > 0) {
    audio.sfx.combo(bankedMult);
    ach.event('drift');
    if (isNewBest) audio.sfx.best();
  }
  if (crashed) { audio.sfx.hit(); ach.event('crash'); }
  for (let i = 0; i < coneHits; i++) ach.event('cone');
  if (coneHits || postHits) audio.sfx.ui();
  if (carState.boosting && !wasBoosting) { audio.sfx.boost(); ach.event('boost'); }
  wasBoosting = carState.boosting;
  drainAchievements();

  // throttled shadow update (re-render the shadow map only every Nth frame)
  if (++shadowTick >= shadowEvery) { renderer.shadowMap.needsUpdate = true; shadowTick = 0; }
  renderer.render(ctx.scene, ctx.camera);
}

// expose a tiny debug handle
window.__game = { carState, scoring, PHYS, input, world, ach, audio, start: startGame, reset: resetCar };

buildStartUI();
// these hints are Safari/web-only — never show them inside the native (Capacitor) app
const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
if (!isNative && isMobile && !window.isSecureContext) { const w = el('secureWarn'); if (w) w.style.display = 'block'; }
// iOS Safari can't fully hide its chrome in a tab — prompt Add to Home Screen for fullscreen (web only)
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = isNative || window.navigator.standalone === true ||
  (window.matchMedia && (window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches));
if (!isNative && isMobile && isIOS && !standalone) { const w = el('a2hsHint'); if (w) w.style.display = 'block'; }
applyTuning();
hud.renderAchievements(ach.progress());
el('presetName').textContent = ctx.preset.name;
frame();
