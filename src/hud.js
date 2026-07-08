// ============================================================================
// hud.js — DOM overlay: score/combo/speed/boost, plus juicy animations
// (combo-complete + new-best celebration), achievement toasts, radio label,
// and the achievements list in settings.
// ============================================================================

const fmt = (n) => Math.floor(n).toLocaleString('en-US');

export function createHUD() {
  const el = (id) => document.getElementById(id);
  const score = el('score');
  const best = el('best');
  const combo = el('combo');
  const comboVal = el('comboVal');
  const banked = el('banked');
  const speed = el('speed');
  const boostFill = el('boostFill');
  const driftFloat = el('driftFloat');
  const flash = el('bankFlash');
  const nearFlash = el('nearFlash');
  const linkTag = el('linkTag');
  const awardFlash = el('awardFlash');
  const celebrateEl = el('celebrate');
  const celebrateBig = celebrateEl.querySelector('.big');
  const celebrateSub = celebrateEl.querySelector('.sub');
  const toasts = el('toasts');
  const radioName = el('radioName');
  const radioPower = el('radioPower');
  const compassEl = el('compass');

  let comboPulse = 0;
  let compassItems = []; // { arr: <el>, rx, rz } — render-coord targets
  // last-written cache: WebKit dirties style/layout/paint on EVERY textContent/style write —
  // even an identical one — and every HUD element carries a text-shadow glow that re-rasters
  // at 3x DPR. Comparing before writing keeps the DOM pipeline idle on unchanged frames.
  const last = {};

  // rebuild the compass chip row (called at a few Hz); arrows are rotated per-frame
  function setCompass(targets) {
    if (!compassEl) return;
    compassEl.innerHTML = targets.map((t) => `<div class="cmp"><span class="arr">↑</span><span>${t.icon}</span><span class="d">${t.dist}</span></div>`).join('');
    const arrs = compassEl.querySelectorAll('.arr');
    compassItems = targets.map((t, i) => ({ arr: arrs[i], rx: t.rx, rz: t.rz }));
  }
  // keep cached targets valid across a floating-origin rebase (they're render coords)
  function shiftCompass(dx, dz) { for (const it of compassItems) { it.rx += dx; it.rz += dz; } }

  function celebrate(big, sub, color) {
    celebrateBig.textContent = big;
    celebrateSub.textContent = sub;
    celebrateEl.style.color = color || '#fff';
    celebrateEl.classList.remove('play');
    void celebrateEl.offsetWidth;
    celebrateEl.classList.add('play');
  }

  function update(st, carState, dt) {
    const scoreTxt = fmt(st.score);
    if (last.score !== scoreTxt) { last.score = scoreTxt; score.textContent = scoreTxt; }
    const bestTxt = 'BEST ' + fmt(st.bestDrift);
    if (last.best !== bestTxt) { last.best = bestTxt; best.textContent = bestTxt; }

    // live combo chip
    if (st.active && st.banked > 0.5) {
      combo.classList.add('show');
      const m = st.multiplier;
      const cvTxt = '×' + m.toFixed(1);
      if (last.comboVal !== cvTxt) { last.comboVal = cvTxt; comboVal.textContent = cvTxt; }
      const bkTxt = '+' + fmt(st.banked);
      if (last.banked !== bkTxt) { last.banked = bkTxt; banked.textContent = bkTxt; }
      const hue = Math.round(140 - Math.min(m / 10, 1) * 110); // quantize → skip most --c rewrites
      if (last.hue !== hue) { last.hue = hue; combo.style.setProperty('--c', `hsl(${hue} 90% 55%)`); }
      const scale = 1 + Math.min(m / 10, 1) * 0.35 + comboPulse; // trimmed so the group stays compact
      const tf = `translateX(-50%) scale(${scale.toFixed(3)})`; // compositor-only (layer promoted)
      if (last.comboTf !== tf) { last.comboTf = tf; combo.style.transform = tf; }
      comboPulse = Math.max(0, comboPulse - dt * 4);
      combo.classList.toggle('hot', st.heat > 0.05); // style heat from near-miss shaves
    } else {
      combo.classList.remove('show');
      combo.classList.remove('hot');
    }

    // banked event
    if (st.justBanked > 0) {
      flash.textContent = '+' + fmt(st.justBanked);
      flash.classList.remove('play');
      void flash.offsetWidth;
      flash.classList.add('play');
      // celebrate ONLY when a single drift breaks your record
      if (st.justBest > 0) {
        best.classList.remove('flash'); void best.offsetWidth; best.classList.add('flash');
        celebrate('NEW BEST DRIFT!', fmt(st.justBest), '#ffd24a');
        st.justBest = 0;
      } else if (st.justBankedMult >= 3 || st.justBanked >= 4000) {
        celebrate('DRIFT!', `+${fmt(st.justBanked)}  ×${(st.justBankedMult || 1).toFixed(1)}`, '#33e0a1');
      }
      st.justBanked = 0;
    }

    if (st.justFailed) {
      combo.classList.add('fail');
      setTimeout(() => combo.classList.remove('fail'), 400);
      st.justFailed = false;
    }

    // link counter (direction transitions within the current chain) — a line below the banked
    // amount; the combo is top-anchored so this extra line just grows downward, never into DRIFT
    if (linkTag) {
      const linked = st.active && st.links > 0;
      if (linked) { linkTag.classList.add('show'); linkTag.textContent = 'LINK ×' + st.links; }
      else linkTag.classList.remove('show');
      if (st.justLink > 0) { linkTag.classList.remove('pop'); void linkTag.offsetWidth; linkTag.classList.add('pop'); comboPulse = 0.25; st.justLink = 0; }
    }
    // near-miss shave pop — show the points it banked so "close = gain" is visible
    if (st.justNearMiss > 0) {
      if (nearFlash) { nearFlash.textContent = 'CLOSE! +' + fmt(st.justNearMissPts); nearFlash.classList.remove('play'); void nearFlash.offsetWidth; nearFlash.classList.add('play'); }
      st.justNearMiss = 0; st.justNearMissPts = 0;
    }
    // direct award (ring trial etc.)
    if (st.justAward > 0) {
      if (awardFlash) { awardFlash.textContent = '+' + fmt(st.justAward); awardFlash.classList.remove('play'); void awardFlash.offsetWidth; awardFlash.classList.add('play'); }
      st.justAward = 0;
    }

    // compass arrows point from the car toward each target (screen up = forward)
    if (compassItems.length) {
      const h = carState.heading, ch = Math.cos(h), sh = Math.sin(h);
      for (const it of compassItems) {
        const dx = it.rx - carState.x, dz = it.rz - carState.z;
        const lx = dx * ch - dz * sh, lz = dx * sh + dz * ch;
        const rotS = Math.atan2(lx, -lz).toFixed(2); // ~0.01 rad steps → skip identical writes
        if (it._rot !== rotS) { it._rot = rotS; it.arr.style.transform = `rotate(${rotS}rad)`; }
      }
    }

    const spd = String(Math.round(Math.abs(carState.forwardSpeed) * 3.6));
    if (last.speed !== spd) { last.speed = spd; speed.textContent = spd; }
    const bfill = 'scaleX(' + carState.boost.toFixed(3) + ')'; // scaleX = compositor-only (vs width = layout)
    if (last.boost !== bfill) { last.boost = bfill; boostFill.style.transform = bfill; }
    boostFill.classList.toggle('ready', carState.boost > 0.99);
    boostFill.classList.toggle('active', carState.boosting);
    driftFloat.classList.toggle('show', carState.drifting);
  }

  function pulseCombo() { comboPulse = 0.25; }

  // toast — achievements by default; region discovery reuses it with a different
  // kicker + variant class (see index.html .toast.region)
  function toast(a, kicker = 'ACHIEVEMENT', variant = '') {
    const div = document.createElement('div');
    div.className = 'toast' + (variant ? ' ' + variant : '');
    div.innerHTML = `<div class="ic">${a.icon}</div><div><div class="t1">${kicker}</div><div class="t2">${a.name}</div><div class="t3">${a.desc || ''}</div></div>`;
    toasts.appendChild(div);
    setTimeout(() => div.remove(), 5000);
  }

  function setRadio(name, on) {
    radioName.innerHTML = on ? `<span class="eq">♫</span> ${name}` : 'Radio off';
    radioPower.classList.toggle('on', on);
  }

  function renderAchievements(progress) {
    const list = el('achList');
    const got = progress.filter((p) => p.unlocked).length;
    el('achCount').textContent = `${got}/${progress.length}`;
    const prog = el('achProgress');
    if (prog) prog.textContent = `${got}/${progress.length}`;
    list.innerHTML = progress
      .map((p) => `<div class="ach ${p.unlocked ? 'got' : ''}"><div class="ai">${p.icon}</div><div><div class="an">${p.name}</div><div class="ad">${p.desc}</div></div></div>`)
      .join('');
  }

  return { update, pulseCombo, celebrate, toast, setRadio, setCompass, shiftCompass, renderAchievements };
}
