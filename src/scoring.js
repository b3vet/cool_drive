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
    heat: 0, // style heat (0..1) from near-miss shaves — boosts the point rate, decays
    links: 0, // direction transitions in the current chain
    bestLinks: 0, // most links in a single chain this session
    // events for the HUD (consume + clear each frame)
    justBanked: 0,
    justBankedMult: 1,
    justBest: 0, // >0 when the drift just banked set a new single-drift record
    justFailed: false,
    justNearMiss: 0, // near-misses recorded this frame
    justLink: 0, // >0 when a transition link just fired (value = link count)
    justAward: 0, // >0 when a direct (non-bankable) award landed (e.g. ring trial)
    totalTime: 0,
    longestDrift: 0,
    _curDrift: 0,
    _slipSide: 0, // -1/0/1 current slide side, for link detection
    _sideTime: 0, // dwell on the current side
  };

  function endChain() { // shared reset for bank() and fail()
    st.banked = 0;
    st.multiplier = 1;
    st.driftTime = 0;
    st.active = false;
    st._curDrift = 0;
    st.heat = 0;
    st.links = 0;
    st._slipSide = 0;
    st._sideTime = 0;
  }

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
    st.grace = 0;
    endChain();
  }

  // called once per fixed step. `col` is the pooled collision result (may carry
  // col.nearMisses — near-miss shaves counted this substep).
  function step(carState, dt, col) {
    st.totalTime += dt;
    const slipDeg = Math.abs(carState.slip) * (180 / Math.PI);
    const valid =
      carState.drifting && slipDeg > SCORE.minSlipDeg && carState.speed > PHYS.minDriftSpeed;

    if (st.heat > 0) st.heat = Math.max(0, st.heat - dt / SCORE.heatDecay); // style heat decays

    if (valid) {
      st.active = true;
      st.grace = 0;
      st.driftTime += dt;
      st._curDrift += dt;
      if (st._curDrift > st.longestDrift) st.longestDrift = st._curDrift;
      st.multiplier = Math.min(1 + st.driftTime * SCORE.comboPerSecond, SCORE.comboMax);

      // transition links: flicking the slide side to side, with a min dwell each side
      // so a twitchy wobble never counts as a link
      if (slipDeg > SCORE.linkMinSlipDeg) {
        const side = carState.slip > 0 ? 1 : -1;
        if (side === st._slipSide) {
          st._sideTime += dt;
        } else {
          if (st._slipSide !== 0 && st._sideTime >= SCORE.linkDwell) {
            st.links += 1;
            st.justLink = st.links;
            if (st.links > st.bestLinks) st.bestLinks = st.links;
            st.multiplier = Math.min(st.multiplier + SCORE.linkBonus, SCORE.comboMax);
          }
          st._slipSide = side;
          st._sideTime = 0;
        }
      }

      // near-miss: shaving close to a solid mid-drift banks a bonus + tops up heat
      if (col && col.nearMisses > 0) {
        st.banked += SCORE.nearMissPoints * st.multiplier * col.nearMisses;
        st.justNearMiss += col.nearMisses;
        st.heat = 1;
      }

      const pts = slipDeg * (carState.speed / SCORE.speedRef) * SCORE.pointsRate * dt;
      st.banked += pts * st.multiplier * (1 + st.heat * SCORE.heatBonus);
    } else if (st.active) {
      st.grace += dt;
      st._curDrift = 0;
      if (st.grace >= SCORE.graceTime) bank();
    }
  }

  // a direct, non-bankable award straight to the session score (ring trials, etc.) —
  // not part of a drift chain, so it can't be wiped by a later crash
  function award(pts) {
    if (pts <= 0) return;
    st.score += pts;
    st.justAward = pts;
  }

  // soft failure (wall hit) — drop pending + combo, keep score
  function fail() {
    if (st.banked > 0 || st.multiplier > 1) st.justFailed = true;
    st.grace = 0;
    endChain();
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

  return { st, step, bank, fail, award, resetAll };
}
