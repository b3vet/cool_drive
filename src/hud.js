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
  const celebrateEl = el('celebrate');
  const celebrateBig = celebrateEl.querySelector('.big');
  const celebrateSub = celebrateEl.querySelector('.sub');
  const toasts = el('toasts');
  const radioName = el('radioName');
  const radioPower = el('radioPower');

  let comboPulse = 0;
  let lastBest = null;

  function celebrate(big, sub, color) {
    celebrateBig.textContent = big;
    celebrateSub.textContent = sub;
    celebrateEl.style.color = color || '#fff';
    celebrateEl.classList.remove('play');
    void celebrateEl.offsetWidth;
    celebrateEl.classList.add('play');
  }

  function update(st, carState, dt) {
    score.textContent = fmt(st.score);
    best.textContent = 'BEST ' + fmt(st.best);

    // live combo chip
    if (st.active && st.banked > 0.5) {
      combo.classList.add('show');
      const m = st.multiplier;
      comboVal.textContent = '×' + m.toFixed(1);
      banked.textContent = '+' + fmt(st.banked);
      const hue = 140 - Math.min(m / 10, 1) * 110;
      combo.style.setProperty('--c', `hsl(${hue} 90% 55%)`);
      const scale = 1 + Math.min(m / 10, 1) * 0.5 + comboPulse;
      combo.style.transform = `translateX(-50%) scale(${scale.toFixed(3)})`;
      comboPulse = Math.max(0, comboPulse - dt * 4);
    } else {
      combo.classList.remove('show');
    }

    // banked event
    if (st.justBanked > 0) {
      flash.textContent = '+' + fmt(st.justBanked);
      flash.classList.remove('play');
      void flash.offsetWidth;
      flash.classList.add('play');
      const newBest = lastBest !== null && st.best > lastBest;
      if (newBest) {
        best.classList.remove('flash'); void best.offsetWidth; best.classList.add('flash');
        celebrate('NEW BEST!', fmt(st.best), '#ffd24a');
      } else if (st.justBankedMult >= 3 || st.justBanked >= 4000) {
        celebrate('DRIFT!', `+${fmt(st.justBanked)}  ×${(st.justBankedMult || 1).toFixed(1)}`, '#33e0a1');
      }
      st.justBanked = 0;
    }
    lastBest = st.best;

    if (st.justFailed) {
      combo.classList.add('fail');
      setTimeout(() => combo.classList.remove('fail'), 400);
      st.justFailed = false;
    }

    speed.textContent = Math.round(Math.abs(carState.forwardSpeed) * 3.6);
    boostFill.style.width = (carState.boost * 100).toFixed(0) + '%';
    boostFill.classList.toggle('ready', carState.boost > 0.99);
    boostFill.classList.toggle('active', carState.boosting);
    driftFloat.classList.toggle('show', carState.drifting);
  }

  function pulseCombo() { comboPulse = 0.25; }

  // achievement toast
  function toast(a) {
    const div = document.createElement('div');
    div.className = 'toast';
    div.innerHTML = `<div class="ic">${a.icon}</div><div><div class="t1">ACHIEVEMENT</div><div class="t2">${a.name}</div><div class="t3">${a.desc}</div></div>`;
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

  return { update, pulseCombo, celebrate, toast, setRadio, renderAchievements };
}
