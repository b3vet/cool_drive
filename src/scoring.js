// ============================================================================
// scoring.js — Drift-Hunters-style combo scoring with a grace window.
// Points = slipAngle(deg) * speedFactor * time, multiplied by a combo that
// grows the longer you stay sliding. Soft failure: you only ever lose the
// PENDING (un-banked) drift + combo — never your banked score. No game-over.
// ============================================================================

import { SCORE, PHYS } from './config.js';

const KEY = 'cooldrive.bestdrift';

export function createScoring() {
  const st = {
    score: 0,
    banked: 0, // pending points for the current drift chain
    multiplier: 1,
    driftTime: 0, // continuous seconds of valid drifting
    grace: 0,
    active: false,
    bestDrift: Number(localStorage.getItem(KEY) || 0), // best SINGLE drift ever (persisted)
    // events for the HUD (consume + clear each frame)
    justBanked: 0,
    justBankedMult: 1,
    justBest: 0, // >0 when the drift just banked set a new single-drift record
    justFailed: false,
    totalTime: 0,
    longestDrift: 0,
    _curDrift: 0,
  };

  function bank() {
    if (st.banked > 0) {
      st.score += st.banked; // cumulative session total
      st.justBanked = st.banked;
      st.justBankedMult = st.multiplier;
      // "best" = the biggest SINGLE drift you've ever banked (not the cumulative total)
      if (st.banked > st.bestDrift) {
        st.bestDrift = st.banked;
        st.justBest = st.banked;
        localStorage.setItem(KEY, String(Math.floor(st.bestDrift)));
      }
    }
    st.banked = 0;
    st.multiplier = 1;
    st.driftTime = 0;
    st.active = false;
    st._curDrift = 0;
  }

  // called once per fixed step
  function step(carState, dt) {
    st.totalTime += dt;
    const slipDeg = Math.abs(carState.slip) * (180 / Math.PI);
    const valid =
      carState.drifting && slipDeg > SCORE.minSlipDeg && carState.speed > PHYS.minDriftSpeed;

    if (valid) {
      st.active = true;
      st.grace = 0;
      st.driftTime += dt;
      st._curDrift += dt;
      if (st._curDrift > st.longestDrift) st.longestDrift = st._curDrift;
      st.multiplier = Math.min(1 + st.driftTime * SCORE.comboPerSecond, SCORE.comboMax);
      const pts = slipDeg * (carState.speed / SCORE.speedRef) * SCORE.pointsRate * dt;
      st.banked += pts * st.multiplier;
    } else if (st.active) {
      st.grace += dt;
      st._curDrift = 0;
      if (st.grace >= SCORE.graceTime) bank();
    }
  }

  // soft failure (wall hit) — drop pending + combo, keep score
  function fail() {
    if (st.banked > 0 || st.multiplier > 1) st.justFailed = true;
    st.banked = 0;
    st.multiplier = 1;
    st.driftTime = 0;
    st.active = false;
    st.grace = 0;
    st._curDrift = 0;
  }

  function resetAll() {
    bank();
    st.score = 0;
    st.banked = 0;
    st.multiplier = 1;
    st.driftTime = 0;
    st.totalTime = 0;
    st.longestDrift = 0;
  }

  return { st, step, bank, fail, resetAll };
}
