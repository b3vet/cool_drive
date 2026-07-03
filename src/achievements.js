// ============================================================================
// achievements.js — unlockable achievements persisted in localStorage.
// The game feeds stats/events; newly-unlocked achievements queue up for the HUD
// to animate. Unlocked state survives reloads.
// ============================================================================

const KEY = 'cooldrive.achievements';

export const ACHIEVEMENTS = [
  { id: 'first_drift', icon: '🛞', name: 'First Drift', desc: 'Complete your first drift', test: (s) => s.driftCount >= 1 },
  { id: 'combo_x5', icon: '🔥', name: 'High Roller', desc: 'Reach a ×5 drift combo', test: (s) => s.bestCombo >= 5 },
  { id: 'combo_x10', icon: '👑', name: 'Untouchable', desc: 'Max out a ×10 combo', test: (s) => s.bestCombo >= 9.9 },
  { id: 'long_drift', icon: '⏱️', name: 'Hold It', desc: 'Hold one drift for 8 seconds', test: (s) => s.longestDrift >= 8 },
  { id: 'track_rat', icon: '🏁', name: 'Track Rat', desc: 'Drift the walled proving-ground track', test: (s) => s.trackDriftTime >= 4 },
  { id: 'score_10k', icon: '💯', name: 'Five Figures', desc: 'Score 10,000 total', test: (s) => s.score >= 10000 },
  { id: 'score_100k', icon: '🏆', name: 'Drift King', desc: 'Score 100,000 total', test: (s) => s.score >= 100000 },
  { id: 'redline', icon: '🚀', name: 'Redline', desc: 'Hit 190 km/h', test: (s) => s.topSpeed >= 52.7 },
  { id: 'cone_killer', icon: '🚧', name: 'Cone Killer', desc: 'Knock over 20 cones', test: (s) => s.conesHit >= 20 },
  { id: 'tourist', icon: '🌃', name: 'City Lights', desc: 'Find your way to the town', test: (s) => s.visitedTown },
  { id: 'wanderer', icon: '🗺️', name: 'Wanderer', desc: 'Drive 5 km total', test: (s) => s.distance >= 5000 },
  { id: 'roadtripper', icon: '🛣️', name: 'Road Tripper', desc: 'Drive 20 km total', test: (s) => s.distance >= 20000 },
  { id: 'frontier', icon: '🧭', name: 'Frontier', desc: 'Reach 3 km from home', test: (s) => s.farthest >= 3000 },
  { id: 'wild_circuit', icon: '🌀', name: 'Wild Circuit', desc: 'Drift a circuit out in the wild', test: (s) => s.procDriftTime >= 4 },
  { id: 'ghost_town', icon: '🏚️', name: 'Off the Map', desc: 'Find a town beyond the horizon', test: (s) => s.visitedProcTown },
  { id: 'crash', icon: '💥', name: 'Ouch', desc: 'Crash into something solid', test: (s) => s.crashes >= 1 },
  { id: 'boost_junkie', icon: '⚡', name: 'Boost Junkie', desc: 'Use boost 10 times', test: (s) => s.boosts >= 10 },
  { id: 'night_owl', icon: '🌙', name: 'Night Owl', desc: 'Drift under the neon night', test: (s) => s.nightDriven },
  { id: 'garage', icon: '🚗', name: 'Full Garage', desc: 'Drive all three cars', test: (s) => s.carsDriven.size >= 3 },
];

export function createAchievements() {
  let unlocked;
  try {
    unlocked = new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
  } catch (e) {
    unlocked = new Set();
  }

  const stats = {
    score: 0,
    bestCombo: 0,
    longestDrift: 0,
    topSpeed: 0,
    distance: 0,
    conesHit: 0,
    crashes: 0,
    boosts: 0,
    driftCount: 0,
    trackDriftTime: 0,
    procDriftTime: 0,
    farthest: 0,
    visitedTown: false,
    visitedProcTown: false,
    nightDriven: false,
    carsDriven: new Set(),
  };

  const pending = []; // newly unlocked, awaiting HUD animation

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify([...unlocked]));
    } catch (e) {}
  }

  function check() {
    for (const a of ACHIEVEMENTS) {
      if (!unlocked.has(a.id) && a.test(stats)) {
        unlocked.add(a.id);
        pending.push(a);
      }
    }
    if (pending.length) persist();
  }

  // merge a partial stats object (numbers take the max where it makes sense)
  function update(partial) {
    if (partial) {
      for (const k in partial) {
        const v = partial[k];
        if (typeof v === 'number') stats[k] = Math.max(stats[k], v);
        else if (typeof v === 'boolean') stats[k] = stats[k] || v;
      }
    }
    check();
  }

  // discrete events
  function event(type, value) {
    if (type === 'drift') stats.driftCount += 1;
    else if (type === 'cone') stats.conesHit += 1;
    else if (type === 'crash') stats.crashes += 1;
    else if (type === 'boost') stats.boosts += 1;
    else if (type === 'car') stats.carsDriven.add(value);
    else if (type === 'night') stats.nightDriven = true;
    else if (type === 'town') stats.visitedTown = true;
    else if (type === 'proctown') stats.visitedProcTown = true;
    check();
  }

  function consume() {
    if (!pending.length) return null;
    return pending.shift();
  }

  function progress() {
    return ACHIEVEMENTS.map((a) => ({ ...a, unlocked: unlocked.has(a.id) }));
  }

  return { stats, update, event, consume, progress, isUnlocked: (id) => unlocked.has(id) };
}
