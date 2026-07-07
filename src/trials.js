// ============================================================================
// trials.js — ring time-trials on procedural circuits. When the car is on a wild
// circuit, a chain of flat neon rings appears along the track; pass them in order
// within par time for a score award. Rings are a fixed pool (created before
// renderer.compile — no shader recompiles), positioned each frame from ABSOLUTE gate
// coords minus the streamer's shift, so origin rebases need no extra handling.
// ============================================================================

import * as THREE from 'three';
import { circuitPath } from './worldgen.js';

const RING_COUNT = 7;
const PASS_R = 6; // metres to count as "through" a ring
const PAR_SPEED = 18; // m/s target pace → par time

export function createTrials({ scene, streamer, scoring, hud, onComplete }) {
  const ringGeo = new THREE.TorusGeometry(5, 0.35, 6, 22);
  const idleMat = new THREE.MeshBasicMaterial({ color: 0x44ffd6, transparent: true, opacity: 0.25, depthWrite: false });
  const nextMat = new THREE.MeshBasicMaterial({ color: 0xffe7a8, transparent: true, opacity: 0.9, depthWrite: false });
  const rings = [];
  for (let i = 0; i < RING_COUNT; i++) {
    const m = new THREE.Mesh(ringGeo, idleMat);
    m.rotation.x = -Math.PI / 2; // lie flat on the ground — drive over to pass
    m.visible = false;
    scene.add(m);
    rings.push(m);
  }
  // a tall glowing beacon column over the NEXT ring so the correct direction to go is
  // always obvious (which way around the loop is not intuitive otherwise)
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 44, 8),
    new THREE.MeshBasicMaterial({ color: 0xffe7a8, transparent: true, opacity: 0.4, depthWrite: false }));
  beacon.visible = false;
  scene.add(beacon);
  const trialHud = document.getElementById('trialHud');

  let state = 'IDLE'; // IDLE | ARMED | RUNNING
  let active = null;   // { cx, cz, gates:[{x,z}], next, time, par }
  let cooldownKey = null; // circuit key just finished — don't re-arm until you leave

  function place(cx, cz, carX, carZ) {
    const cp = circuitPath(cx, cz); // absolute
    const pts = cp.points;
    const gates = [];
    for (let i = 0; i < RING_COUNT; i++) {
      const p = pts[Math.floor((i / RING_COUNT) * pts.length) % pts.length];
      gates.push({ x: p.x, z: p.z });
    }
    // start from the gate nearest the car so you don't have to double back
    let nearest = 0, nd = Infinity;
    for (let i = 0; i < gates.length; i++) {
      const d = (gates[i].x - streamer.shiftTotal.x - carX) ** 2 + (gates[i].z - streamer.shiftTotal.z - carZ) ** 2;
      if (d < nd) { nd = d; nearest = i; }
    }
    const ordered = gates.slice(nearest).concat(gates.slice(0, nearest));
    let len = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; len += Math.hypot(b.x - a.x, b.z - a.z); }
    active = { cx, cz, gates: ordered, next: 0, time: 0, par: len / PAR_SPEED };
    state = 'ARMED';
    if (hud) hud.celebrate('RING RUN', 'pass the rings in order', '#44ffd6');
  }

  function positionRings() {
    if (!active) { for (const r of rings) r.visible = false; beacon.visible = false; return; }
    for (let i = 0; i < RING_COUNT; i++) {
      const r = rings[i];
      if (i < active.next) { r.visible = false; continue; } // already passed
      const g = active.gates[i];
      r.position.set(g.x - streamer.shiftTotal.x, 0.5, g.z - streamer.shiftTotal.z);
      const isNext = i === active.next;
      r.material = isNext ? nextMat : idleMat;
      r.scale.setScalar(isNext ? 1.35 : 1); // the next ring is bigger so it stands out
      r.visible = true;
    }
    // beacon column marks exactly the ring to head for next
    const ng = active.gates[active.next];
    if (ng) { beacon.visible = true; beacon.position.set(ng.x - streamer.shiftTotal.x, 22, ng.z - streamer.shiftTotal.z); }
    else beacon.visible = false;
  }

  let _hudCache = ''; // last innerHTML written — skip the re-parse when unchanged
  function updateHud() {
    if (!trialHud) return;
    if (state === 'ARMED' || state === 'RUNNING') {
      trialHud.classList.add('show');
      const t = state === 'RUNNING' ? active.time : 0;
      // t.toFixed(1) changes ~10x/s (not 60), so this re-parses the HTML ~10x/s instead of every frame
      const html = `<div class="tl">RING RUN ${active.next}/${RING_COUNT}</div><div class="tv">${t.toFixed(1)}s</div>`;
      if (html !== _hudCache) { _hudCache = html; trialHud.innerHTML = html; }
    } else {
      _hudCache = '';
      trialHud.classList.remove('show');
    }
  }

  function finish() {
    const award = Math.round(3000 + Math.max(0, active.par - active.time) * 400);
    scoring.award(award);
    if (hud) hud.celebrate('RING RUN!', '+' + award.toLocaleString('en-US'), '#44ffd6');
    cooldownKey = active.cx + ',' + active.cz;
    active = null; state = 'IDLE';
    for (const r of rings) r.visible = false;
    beacon.visible = false;
    updateHud();
    onComplete && onComplete();
  }

  function abort() {
    active = null; state = 'IDLE';
    for (const r of rings) r.visible = false;
    beacon.visible = false;
    updateHud();
  }

  function update(carState, dt) {
    const cn = streamer.circuitNear(carState.x, carState.z);
    if (state === 'IDLE') {
      if (cn) { const key = cn.cx + ',' + cn.cz; if (key !== cooldownKey) place(cn.cx, cn.cz, carState.x, carState.z); }
      else cooldownKey = null; // left the circuit — allow a fresh run next time
      positionRings(); updateHud();
      return;
    }
    // ARMED / RUNNING — must stay on the same circuit
    if (!cn || cn.cx + ',' + cn.cz !== active.cx + ',' + active.cz) { abort(); return; }
    const g = active.gates[active.next];
    const gx = g.x - streamer.shiftTotal.x, gz = g.z - streamer.shiftTotal.z;
    if (Math.hypot(gx - carState.x, gz - carState.z) < PASS_R) {
      if (state === 'ARMED') { state = 'RUNNING'; active.time = 0; }
      active.next++;
      if (active.next >= RING_COUNT) { finish(); return; }
    }
    if (state === 'RUNNING') active.time += dt;
    positionRings(); updateHud();
  }

  return { update, running: () => state !== 'IDLE' };
}
