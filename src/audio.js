// ============================================================================
// audio.js — all sound, zero asset files required.
//   • SFX: synthesized with Web Audio (engine, tyre skid, boost, crash, UI, chimes)
//   • Radio: a built-in PROCEDURAL music station (generative, no files) plus any
//     number of URL stations you add to RADIO_STATIONS (your own hosted files or
//     internet-radio streams). Swap/extend freely without touching the engine.
//
// Hosting note: the procedural station needs nothing. URL stations stream via an
// <audio> element, so you can point them at object storage / a CDN / a stream URL
// instead of serving big files off your VPS.
// ============================================================================

// Add your own stations here. { name, url } streams via <audio>; the first entry
// is the built-in generative station (no url).
export const RADIO_STATIONS = [
  { name: 'Night Run', tracks: ['./audio/night_run_1.mp3', './audio/night_run_2.mp3'] },
  { name: 'Sunset', tracks: ['./audio/sunset_1.mp3', './audio/sunset_2.mp3'] },
  { name: 'CoolDrive FM', generative: true }, // built-in synth station — no files
  // A station is either { url: '...' } (one looping song), { tracks: [...] } (a playlist
  // that auto-advances), or { generative: true }. Add `stream: true` for a live stream.
  // URLs can be local (./audio/...), a CDN, or object storage — no CORS setup needed.
];

export function createAudio() {
  let ctx = null;
  let master, sfxBus, musicBus;
  let started = false;
  let muted = false;
  let masterVol = 0.8;
  let musicVol = 0.5;
  let sfxVol = 0.85; // car / sound-effects bus level

  // engine + skid persistent nodes
  let eng = null;
  let skid = null;

  // radio
  let stationIndex = 0;
  let radioOn = false;
  let plainEl = null; // direct-output <audio> — cross-origin URLs work with NO CORS setup
  let routedEl = null; // <audio> routed through musicBus — music slider works on iOS
  let activeEl = null; // whichever of the two the current track plays on
  let gen = null; // generative scheduler state
  let onRadioError = null; // (stationName) => void — surfaced to the UI
  let playlist = []; // current station's track URLs
  let trackIndex = 0;

  // ---- iOS ring/silent-switch bypass ---------------------------------------
  // On iOS the mute switch silences Web Audio (engine/skid/SFX) but NOT <audio>
  // media playback — and while ANY media element is playing, the whole session
  // becomes "playback" and Web Audio is audible again. That's why sound only
  // worked with the radio on. Keeping a looping SILENT <audio> playing pins the
  // session to playback mode so the game is audible regardless of the switch.
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1); // iPadOS reports as Mac
  // In the NATIVE app the AVAudioSession is pinned to .playback in AppDelegate, so
  // the keep-alive is unnecessary — and playing it would make WebKit grab a
  // non-mixable session that pauses the user's own Spotify/Music.
  const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const SILENCE = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
  let keepAlive = null;
  function ensureKeepAlive() {
    if (!IOS || NATIVE) return;
    if (!keepAlive) {
      keepAlive = new Audio(SILENCE);
      keepAlive.loop = true;
      keepAlive.setAttribute('playsinline', '');
      keepAlive.preload = 'auto';
      // iOS pauses it on interruptions (calls, Siri, lock, backgrounding) and never
      // resumes it itself — without this the mute-switch bug would return mid-session.
      keepAlive.addEventListener('pause', () => {
        if (document.visibilityState === 'visible') keepAlive.play().catch(() => {});
      });
    }
    if (keepAlive.paused) keepAlive.play().catch(() => {});
  }

  function ensure() {
    if (ctx) return true;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : masterVol;
      master.connect(ctx.destination);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = sfxVol;
      sfxBus.connect(master);
      musicBus = ctx.createGain();
      musicBus.gain.value = musicVol;
      musicBus.connect(master);
      return true;
    } catch (e) {
      return false;
    }
  }

  function noiseBuffer(seconds = 2) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // ---- persistent engine + skid -------------------------------------------
  function buildContinuous() {
    // engine: detuned saw + sub through a lowpass
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
    const o2 = ctx.createOscillator(); o2.type = 'square'; o2.detune.value = -12;
    const sub = ctx.createOscillator(); sub.type = 'sine';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.value = 0.0;
    o1.connect(lp); o2.connect(lp); sub.connect(g); lp.connect(g); g.connect(sfxBus);
    o1.start(); o2.start(); sub.start();
    eng = { o1, o2, sub, lp, g };

    // skid: looping noise through a bandpass
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(2); src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1600; bp.Q.value = 1.2;
    const g2 = ctx.createGain(); g2.gain.value = 0;
    src.connect(bp); bp.connect(g2); g2.connect(sfxBus);
    src.start();
    skid = { g: g2, bp };
  }

  function updateEngine(speed, throttle, maxSpeed) {
    if (!eng) return;
    const t = ctx.currentTime;
    const frac = Math.min(Math.abs(speed) / maxSpeed, 1.2);
    const freq = 46 + frac * 150;
    eng.o1.frequency.setTargetAtTime(freq, t, 0.05);
    eng.o2.frequency.setTargetAtTime(freq * 1.5, t, 0.05);
    eng.sub.frequency.setTargetAtTime(freq * 0.5, t, 0.05);
    eng.lp.frequency.setTargetAtTime(500 + frac * 1400, t, 0.08);
    const target = 0.05 + (throttle ? 0.1 : 0.0) + frac * 0.12;
    eng.g.gain.setTargetAtTime(target, t, 0.1);
  }

  function updateSkid(intensity) {
    if (!skid) return;
    const t = ctx.currentTime;
    skid.g.gain.setTargetAtTime(Math.min(intensity, 1) * 0.32, t, 0.05);
    skid.bp.frequency.setTargetAtTime(1300 + intensity * 1200, t, 0.05);
  }

  // ---- one-shot SFX --------------------------------------------------------
  function blip(freq, dur, type = 'sine', vol = 0.3, slideTo = null, delay = 0) {
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = type;
    const g = ctx.createGain();
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(sfxBus);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function noiseBurst(dur, freq, vol = 0.4) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(dur + 0.1);
    const bp = ctx.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(g); g.connect(sfxBus);
    src.start(t); src.stop(t + dur + 0.05);
  }

  const sfx = {
    boost() { if (ctx) { blip(220, 0.5, 'sawtooth', 0.25, 1100); noiseBurst(0.5, 3000, 0.2); } },
    hit() { if (ctx) { blip(120, 0.25, 'square', 0.3, 50); noiseBurst(0.25, 800, 0.4); } },
    ui() { blip(660, 0.08, 'triangle', 0.2); },
    select() { blip(520, 0.08, 'triangle', 0.22); blip(780, 0.1, 'triangle', 0.18, null, 0.06); },
    combo(mult) { // rising arpeggio scaled by multiplier
      const base = 440;
      const steps = Math.min(3 + Math.floor(mult), 7);
      for (let i = 0; i < steps; i++) blip(base * Math.pow(1.1487, i + 4), 0.12, 'triangle', 0.18, null, i * 0.05);
    },
    best() { [523, 659, 784, 1047].forEach((f, i) => blip(f, 0.3, 'triangle', 0.25, null, i * 0.09)); },
    achievement() { [659, 988, 1319].forEach((f, i) => blip(f, 0.35, 'sine', 0.28, null, i * 0.1)); },
  };

  // ---- generative music station -------------------------------------------
  // Chill synthwave-ish loop: pad chords + arp + soft kick/hat. Pure Web Audio.
  function startGenerative() {
    if (gen) return;
    const bpm = 82;
    const beat = 60 / bpm;
    // i - VI - III - VII (A minor vibe), midi roots
    const prog = [
      [57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62],
    ];
    const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
    let bar = 0;
    let nextNote = ctx.currentTime + 0.1;
    let step = 0;

    function pad(freqs, when, dur) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.12, when + 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200;
      g.connect(lp); lp.connect(musicBus);
      freqs.forEach((f) => {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.value = f; o.detune.value = (Math.random() - 0.5) * 10;
        o.connect(g); o.start(when); o.stop(when + dur + 0.1);
      });
    }
    function pluck(f, when) {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.10, when + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.35);
      o.connect(g); g.connect(musicBus); o.start(when); o.stop(when + 0.4);
    }
    function kick(when) {
      const o = ctx.createOscillator(); o.type = 'sine';
      const g = ctx.createGain();
      o.frequency.setValueAtTime(120, when); o.frequency.exponentialRampToValueAtTime(45, when + 0.12);
      g.gain.setValueAtTime(0.3, when); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
      o.connect(g); g.connect(musicBus); o.start(when); o.stop(when + 0.2);
    }
    function hat(when) {
      const src = ctx.createBufferSource(); src.buffer = noiseBuffer(0.05);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.07, when); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
      src.connect(hp); hp.connect(g); g.connect(musicBus); src.start(when); src.stop(when + 0.06);
    }

    gen = { timer: 0 };
    gen.timer = setInterval(() => {
      if (!ctx) return;
      while (nextNote < ctx.currentTime + 0.2) {
        const chord = prog[bar % prog.length];
        const freqs = chord.map((m) => mtof(m - 12));
        if (step === 0) pad(freqs, nextNote, beat * 4);
        // arp over the chord
        const arpNote = chord[step % chord.length];
        pluck(mtof(arpNote + 12), nextNote);
        // drums
        if (step % 2 === 0) kick(nextNote);
        hat(nextNote + beat / 2);
        step = (step + 1) % 8;
        if (step === 0) bar++;
        nextNote += beat / 2;
      }
    }, 60);
  }
  function stopGenerative() {
    if (gen) { clearInterval(gen.timer); gen = null; }
  }

  // ---- radio control -------------------------------------------------------
  // Two players, picked per-track by origin:
  //  • routedEl — through musicBus (Web Audio). Same-origin files only. The music
  //    slider works on iOS this way (element .volume is READ-ONLY there).
  //  • plainEl  — direct output, NOT routed: works for cross-origin URLs / streams
  //    with no CORS headers (a routed cross-origin element would play silence).
  function makeRadioEl(routed) {
    const el = new Audio();
    el.setAttribute('playsinline', '');
    el.addEventListener('error', () => {
      if (activeEl !== el) return;
      radioOn = false;
      if (onRadioError) onRadioError(RADIO_STATIONS[stationIndex].name);
    });
    // playlist stations: advance to the next track when one finishes (wrap around)
    el.addEventListener('ended', () => {
      if (activeEl !== el || !radioOn || playlist.length <= 1) return;
      trackIndex = (trackIndex + 1) % playlist.length;
      playCurrentTrack();
    });
    if (routed) {
      try { ctx.createMediaElementSource(el).connect(musicBus); } catch (e) {}
    }
    return el;
  }
  function playCurrentTrack() {
    const st = RADIO_STATIONS[stationIndex];
    const url = playlist[trackIndex];
    let sameOrigin = true;
    try { sameOrigin = new URL(url, location.href).origin === location.origin; } catch (e) {}
    const el = sameOrigin
      ? (routedEl || (routedEl = makeRadioEl(true)))
      : (plainEl || (plainEl = makeRadioEl(false)));
    if (activeEl && activeEl !== el) activeEl.pause();
    activeEl = el;
    el.src = url;
    el.loop = playlist.length === 1 && !st.stream; // single song loops; playlists advance
    el.muted = muted; // .muted is the iOS-reliable mute (volume is read-only there)
    // routed: loudness comes from musicBus gain; plain: element volume (desktop only)
    el.volume = sameOrigin ? 1 : muted ? 0 : musicVol;
    el.play().catch((err) => {
      // an interrupted play() (paused / src swapped by a station change) is a
      // supersede, not a broken station — only real failures kill the radio
      if (activeEl !== el || (err && err.name === 'AbortError')) return;
      radioOn = false;
      if (onRadioError) onRadioError(st.name);
    });
  }
  function playStation(i) {
    if (!ensure()) return;
    const n = RADIO_STATIONS.length;
    stationIndex = ((i % n) + n) % n;
    const st = RADIO_STATIONS[stationIndex];
    stopGenerative();
    if (activeEl) { activeEl.pause(); activeEl = null; } // deliberate stop — stale play()/error events must not kill the radio
    if (st.generative) {
      startGenerative();
    } else {
      // a station can be { url } (one song) or { tracks: [...] } (a playlist)
      playlist = st.tracks ? st.tracks.slice() : st.url ? [st.url] : [];
      trackIndex = 0;
      if (playlist.length) playCurrentTrack();
    }
    radioOn = true;
    return st.name;
  }
  function radioToggle() {
    if (!ensure()) return false;
    if (radioOn) {
      stopGenerative();
      if (activeEl) { activeEl.pause(); activeEl = null; }
      radioOn = false;
    } else {
      playStation(stationIndex);
    }
    return radioOn;
  }
  function nextStation() { return playStation(stationIndex + 1); }
  function station() { return RADIO_STATIONS[stationIndex].name; }
  function isRadioOn() { return radioOn; }

  // ---- lifecycle -----------------------------------------------------------
  function start() {
    if (!ensure()) return;
    // iOS/Safari: creating the AudioContext AND resuming it in the SAME gesture
    // often leaves it suspended — the resume only "takes" on a LATER gesture with
    // an already-existing context (which is why toggling the radio unstuck it).
    // So resume on EVERY gesture until it's actually running (main.js fires this on
    // pointerdown/touchend/click), playing a 1-frame silent buffer as the classic
    // iOS output-unlock nudge each time it's still suspended.
    // NOT 'running' covers both 'suspended' AND iOS's non-standard 'interrupted'
    // state (after calls/Siri) — an interrupted context needs an explicit resume too.
    if (ctx.state !== 'running') {
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => {}); // outside-gesture resume may be denied — the armed tap unlock retries
      try {
        const b = ctx.createBufferSource();
        b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        b.connect(ctx.destination);
        b.start(0);
      } catch (e) {}
    }
    ensureKeepAlive(); // iOS web: pin the session to "playback" so the mute switch can't silence us
    // an interruption pauses the radio element without flipping radioOn — resync
    if (radioOn && activeEl && activeEl.paused) activeEl.play().catch(() => {});
    if (!started) { buildContinuous(); started = true; }
  }
  const isRunning = () => !!ctx && ctx.state === 'running';
  function setMuted(m) {
    muted = m;
    if (master) master.gain.setTargetAtTime(m ? 0 : masterVol, ctx.currentTime, 0.05);
    // On iOS `.volume` is read-only (hardware-controlled), so `.muted` is what
    // actually silences the media elements — set both for cross-platform coverage.
    if (routedEl) routedEl.muted = m;
    if (plainEl) { plainEl.muted = m; plainEl.volume = m ? 0 : musicVol; }
  }
  function setMusicVol(v) {
    musicVol = v;
    if (musicBus) musicBus.gain.setTargetAtTime(v, ctx.currentTime, 0.05); // routedEl + generative
    if (plainEl) plainEl.volume = muted ? 0 : v; // cross-origin element (desktop only; iOS read-only)
  }
  function setSfxVol(v) {
    sfxVol = v;
    if (sfxBus) sfxBus.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
  }
  function toggleMute() { setMuted(!muted); return muted; }

  return {
    start, isRunning, sfx, updateEngine, updateSkid,
    radioToggle, nextStation, station, isRadioOn,
    setMuted, toggleMute, setMusicVol, setSfxVol,
    setOnRadioError(fn) { onRadioError = fn; },
    get muted() { return muted; },
    // debug snapshot for on-device diagnosis (window.__game.audio.state)
    get state() {
      return {
        ctx: ctx ? ctx.state : 'none',
        keepAlive: !!keepAlive && !keepAlive.paused,
        radio: radioOn ? (gen ? 'generative' : activeEl === routedEl ? 'routed' : 'plain') : 'off',
        muted,
      };
    },
  };
}
