// logic.js — CBE progression + measurement logic.
// Pure functions only: no DOM, no storage, no clock. Dates are 'YYYY-MM-DD' strings
// passed in by the caller. Runs unchanged in the browser and in Node (ES module).

export const EPS = 1e-9;

// ---------------------------------------------------------------- constants

export const EQUIPMENT = ['plate', 'machine', 'cable', 'dumbbell', 'bodyweight'];
export const EQUIPMENT_LABEL = {
  plate: 'Plate-loaded', machine: 'Machine', cable: 'Cable',
  dumbbell: 'Dumbbell', bodyweight: 'Bodyweight',
};

export const TAGS = ['sick', 'injured', 'sleep', 'stress', 'energy', 'time'];
export const TAG_LABEL = {
  sick: 'Sick', injured: 'Injured/tweaked', sleep: 'Poor sleep',
  stress: 'High stress', energy: 'Low energy', time: 'Short on time',
};

// User-editable defaults (settings screen) plus fixed rule constants.
export const DEFAULT_SETTINGS = {
  seasonWeeks: 8,        // season length
  numberWindow: 6,       // lift scores averaged into "the number"
  behindAfter: 2,        // sessions in a row below the number
  effortSlipPoints: 20,  // effort points below norm that count as slipping
  effortGate: 2 / 3,     // season effort average needed for an overall CBE
  // fixed rule constants
  behindWarmup: 3,       // Behind counts from a lift's 4th real session
  slipWarmup: 6,         // effort slipping starts after 6 sessions
  slipRecent: 3,         // sessions in the "recent" effort window
  slipNormMax: 12,       // max sessions in the effort norm
  moveUpReps: 6,         // a set that just moved up a weight targets 6+
  missesForStepBack: 3,  // missed targets in a row before a step-back suggestion
  stepBackPct: 10,       // ~10% lighter
  cbePct: 1,             // +1% = Career Best Effort
  reviewDays: 14,        // team review cadence
  backupDays: 14,        // backup reminder age
};

export function family(equipment) {
  return equipment === 'plate' || equipment === 'machine' ? 'together' : 'single';
}

export function equipmentDefaults(equipment) {
  switch (equipment) {
    case 'plate': return { repMin: 10, repMax: 10, increment: 2.5 };
    case 'machine': return { repMin: 10, repMax: 12, increment: 5 };
    case 'dumbbell': return { repMin: 10, repMax: 12, increment: 5 };
    case 'cable': return { repMin: 10, repMax: 15, increment: 5 };
    case 'bodyweight': return { repMin: 10, repMax: 15, increment: 5 };
    default: return { repMin: 10, repMax: 12, increment: 5 };
  }
}

// ---------------------------------------------------------------- small helpers

export const rw = (x) => Math.round(x * 100) / 100; // weight rounding (no float drift)
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const epley = (load, reps) => load * (1 + reps / 30);
export const isDone = (s) => !!s && s.done !== false && Number(s.r) > 0 && s.w !== null && s.w !== undefined && s.w !== '';
const clone = (sets) => sets.map((s) => ({ w: Number(s.w), r: Number(s.r) }));

/** Sort sets heaviest first (then most reps). */
export function heavyFirst(sets) {
  return clone(sets).sort((a, b) => (b.w - a.w) || (b.r - a.r));
}

/** Load used for scoring: logged weight + base (machine base or bodyweight). */
export function offsetFor(lift, bw) {
  if (lift.bodyweight) return Number(bw) || 0;
  return Number(lift.base) || 0;
}

// ---------------------------------------------------------------- dates

function toUTC(d) { const [y, m, day] = d.split('-').map(Number); return Date.UTC(y, m - 1, day); }
function fromUTC(ms) { return new Date(ms).toISOString().slice(0, 10); }
export function addDays(d, n) { return fromUTC(toUTC(d) + n * 86400000); }
export function daysBetween(a, b) { return Math.round((toUTC(b) - toUTC(a)) / 86400000); }
export function monthKey(d) { return d.slice(0, 7); }
export function addMonths(key, n) {
  let [y, m] = key.split('-').map(Number);
  m += n;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- lift score

/**
 * Lift score = average Epley estimate over max(prescribed, sets done).
 * A prescribed set that wasn't done counts as 0. Working sets only.
 */
export function liftScore(workSets, prescribed, offset = 0) {
  const done = (workSets || []).filter(isDone);
  const denom = Math.max(prescribed || 0, done.length);
  if (!denom) return 0;
  const sum = done.reduce((a, s) => a + epley(Number(s.w) + offset, Number(s.r)), 0);
  return sum / denom;
}

/** Heaviest working weight and best Epley (est. 1RM) among done sets. */
export function heaviestSet(workSets) {
  const d = (workSets || []).filter(isDone);
  return d.length ? Math.max(...d.map((s) => Number(s.w))) : null;
}
export function bestE1rm(workSets, offset = 0) {
  const d = (workSets || []).filter(isDone);
  return d.length ? Math.max(...d.map((s) => epley(Number(s.w) + offset, Number(s.r)))) : null;
}

// ---------------------------------------------------------------- progression

function furthestBelow(sets, repMax) {
  let idx = 0, gap = -Infinity;
  sets.forEach((s, i) => { const g = repMax - s.r; if (g > gap + EPS) { gap = g; idx = i; } });
  return idx;
}

/** Make a baseline exactly `n` sets, heaviest first. */
export function normalizeSets(sets, n) {
  let s = heavyFirst(sets);
  if (s.length > n) s = s.slice(0, n);
  while (s.length < n && s.length) s.push({ ...s[s.length - 1] });
  return s;
}

/**
 * Today's target = one step above the baseline (best at current weight).
 * lift: { equipment, sets, repMin, repMax, increment }
 * Returns { sets: [{w,r}] (heaviest first), kind: 'rep'|'moveup'|'catchup' }.
 */
export function computeTarget(baseline, lift, settings = DEFAULT_SETTINGS) {
  const n = lift.sets;
  const { repMin, repMax } = lift;
  const inc = Number(lift.increment);
  let sets = normalizeSets(baseline, n);
  if (!sets.length) return { sets: [], kind: 'none' };
  let kind = 'rep';
  if (family(lift.equipment) === 'together') {
    // Plate-loaded and machines: all sets move together.
    const W = Math.max(...sets.map((s) => s.w));
    if (sets.some((s) => s.w < W - EPS)) {
      sets = sets.map((s) => (s.w < W - EPS ? { w: W, r: repMin } : s));
      kind = 'catchup';
    } else if (sets.every((s) => s.r >= repMax)) {
      sets = sets.map(() => ({ w: rw(W + inc), r: repMin }));
      kind = 'moveup';
    } else {
      const i = furthestBelow(sets, repMax);
      sets = sets.map((s, j) => (j === i ? { w: s.w, r: s.r + 1 } : s));
    }
  } else if (sets.every((s) => s.r >= repMax)) {
    // Cables, dumbbells, bodyweight: one set moves up a weight at a time.
    const minW = Math.min(...sets.map((s) => s.w));
    const i = sets.findIndex((s) => s.w <= minW + EPS);
    sets = sets.map((s, j) => (j === i ? { w: rw(s.w + inc), r: settings.moveUpReps } : s));
    kind = 'moveup';
  } else {
    const i = furthestBelow(sets, repMax);
    sets = sets.map((s, j) => (j === i ? { w: s.w, r: s.r + 1 } : s));
  }
  const floor = Math.min(settings.moveUpReps, repMin);
  sets = sets.map((s) => ({ w: s.w, r: Math.max(s.r, floor) }));
  return { sets: heavyFirst(sets), kind };
}

/** True if every target set is matched by a distinct done set (heavier counts if its Epley is at least as high). */
export function evaluateTarget(targetSets, workSets, offset = 0) {
  const t = heavyFirst(targetSets || []);
  const d = heavyFirst((workSets || []).filter(isDone));
  if (d.length < t.length) return { hit: false };
  const ok = (ls, ts) => ls.w >= ts.w - EPS && epley(ls.w + offset, ls.r) >= epley(ts.w + offset, ts.r) - EPS;
  const used = new Array(d.length).fill(false);
  const match = (i) => {
    if (i === t.length) return true;
    for (let j = 0; j < d.length; j++) {
      if (!used[j] && ok(d[j], t[i])) {
        used[j] = true;
        if (match(i + 1)) return true;
        used[j] = false;
      }
    }
    return false;
  };
  return { hit: match(0) };
}

/**
 * Best holds: the log becomes the new baseline only if it matches or beats the
 * baseline's lift score (including a heavier weight you chose). Otherwise keep it.
 */
export function updateBaseline(baseline, workSets, prescribed, offset = 0) {
  const done = (workSets || []).filter(isDone);
  if (done.length < prescribed) return { baseline, updated: false };
  const best = clone(done)
    .sort((a, b) => epley(b.w + offset, b.r) - epley(a.w + offset, a.r))
    .slice(0, prescribed);
  const cand = heavyFirst(best);
  if (liftScore(cand, prescribed, offset) >= liftScore(baseline, prescribed, offset) - EPS) {
    return { baseline: cand, updated: true };
  }
  return { baseline, updated: false };
}

/**
 * A set "just moved up to a new weight" if any done working set is heavier than the set in the
 * same rank last time (previous logged session of this lift, or the seed). Only that first
 * session at the new weight is exempt from Behind; staying stuck there counts.
 */
export function isMoveUp(previous, workSets) {
  const b = heavyFirst((previous || []).filter(isDone));
  const d = heavyFirst((workSets || []).filter(isDone));
  for (let i = 0; i < Math.min(b.length, d.length); i++) if (d[i].w > b[i].w + EPS) return true;
  return false;
}

/**
 * Step back after 3 misses.
 *  - plate/machine: every set ~10% lighter (whole increments, at least one), same reps.
 *  - cable/DB/bodyweight: the heaviest set drops one weight, same reps.
 *  - nothing lighter possible: ~10% fewer reps on every set.
 */
export function stepBack(baseline, lift, settings = DEFAULT_SETTINGS) {
  const sets = heavyFirst(baseline);
  const inc = Number(lift.increment);
  const fewerReps = () => ({
    sets: sets.map((s) => ({ w: s.w, r: Math.max(1, Math.floor(s.r * (1 - settings.stepBackPct / 100))) })),
    kind: 'fewer-reps',
  });
  if (family(lift.equipment) === 'together') {
    const W = Math.max(...sets.map((s) => s.w));
    const k = Math.max(1, Math.round((settings.stepBackPct / 100) * W / inc));
    const out = sets.map((s) => ({ w: rw(s.w - k * inc), r: s.r }));
    if (W <= 0 || out.some((s) => s.w < -EPS)) return fewerReps();
    return { sets: heavyFirst(out), kind: 'lighter' };
  }
  const maxW = Math.max(...sets.map((s) => s.w));
  let idx = -1;
  sets.forEach((s, i) => { if (Math.abs(s.w - maxW) < EPS) idx = i; }); // last of the heaviest group
  const nw = rw(sets[idx].w - inc);
  if (nw < -EPS) return fewerReps();
  const out = sets.map((s, i) => (i === idx ? { w: nw, r: s.r } : s));
  return { sets: heavyFirst(out), kind: 'set-down' };
}

// ---------------------------------------------------------------- career highs

/** Career-high state: heaviest working set with 6+ reps, and best total reps at each weight. */
export function chInit(seedSets) {
  const st = { heaviest: -Infinity, repsAt: {} };
  return chSession(st, seedSets || []).next;
}

const wKey = (w) => String(rw(Number(w)));

/**
 * Walk a session's done working sets in logged order. Returns per-set flags and events.
 * - heaviest: a heavier working set than ever, with 6+ reps
 * - reps: more total working reps at a weight than ever (only at weights used before)
 */
export function chSession(state, workSets, settings = DEFAULT_SETTINGS) {
  let heaviest = state.heaviest;
  const totals = {};
  const flags = [];
  const events = [];
  const repsFlagged = {};
  (workSets || []).forEach((s, i) => {
    if (!isDone(s)) { flags.push(null); return; }
    const w = Number(s.w), r = Number(s.r);
    let flag = null;
    if (r >= settings.moveUpReps && w > heaviest + EPS) {
      heaviest = w;
      flag = 'heaviest';
      events.push({ type: 'heaviest', w, r, set: i });
    }
    const k = wKey(w);
    totals[k] = (totals[k] || 0) + r;
    const prior = state.repsAt[k] || 0;
    if (prior > 0 && totals[k] > prior && !repsFlagged[k]) {
      repsFlagged[k] = true;
      flag = flag || 'reps';
      events.push({ type: 'reps', w, total: totals[k], prior, set: i });
    }
    flags.push(flag);
  });
  // final totals may exceed the flagged total; report the session's final count
  events.forEach((e) => { if (e.type === 'reps') e.total = totals[wKey(e.w)]; });
  const repsAt = { ...state.repsAt };
  Object.entries(totals).forEach(([k, v]) => { if (v > (repsAt[k] || 0)) repsAt[k] = v; });
  return { flags, events, next: { heaviest, repsAt } };
}

// ---------------------------------------------------------------- number, rating, effort, flags

export function numberOf(scores, window) {
  return mean(scores.slice(-window));
}

/** 1000 × mean(lift score ÷ number before this session). */
export function sessionRating(pairs) {
  const v = (pairs || []).filter((p) => p.number > 0 && p.score !== null && p.score !== undefined);
  if (!v.length) return null;
  return 1000 * mean(v.map((p) => p.score / p.number));
}

/** Effort = yeses ÷ 3 (0..1). */
export function effortValue(e) {
  if (!e) return null;
  return [e.clean, e.nearFailure, e.attempted].filter(Boolean).length / 3;
}

/**
 * Behind: score below the number on `behindAfter` sessions of the lift in a row.
 * Clears at the next session at or above the number. Move-up sessions never count
 * toward it (they can still clear it). Starts after `behindWarmup` real sessions.
 * entries: [{score, number, moveUp}] chronological.
 */
export function behindSeries(entries, settings = DEFAULT_SETTINGS) {
  let streak = 0, behind = false;
  return entries.map((e, idx) => {
    if (idx < settings.behindWarmup) return { behind: false, counted: false, streak: 0 };
    const below = e.score < e.number - EPS;
    if (e.moveUp) {
      if (!below) { streak = 0; behind = false; }
      return { behind, counted: false, streak };
    }
    if (below) { streak += 1; if (streak >= settings.behindAfter) behind = true; }
    else { streak = 0; behind = false; }
    return { behind, counted: true, streak };
  });
}

/**
 * Effort slipping: last 3 sessions average >= 20 points below the norm
 * (mean of up to 12 sessions before those 3). Starts after 6 sessions.
 */
export function effortSlip(efforts, settings = DEFAULT_SETTINGS) {
  const vals = efforts.filter((x) => x !== null && x !== undefined);
  const n = vals.length;
  if (n <= settings.slipWarmup) return { active: false, slipping: false, recent: null, norm: null, drop: null };
  const recent = vals.slice(-settings.slipRecent);
  const before = vals.slice(0, n - settings.slipRecent).slice(-settings.slipNormMax);
  const r = mean(recent) * 100, nm = mean(before) * 100;
  const drop = nm - r;
  return { active: true, slipping: drop >= settings.effortSlipPoints - EPS, recent: r, norm: nm, drop };
}

// ---------------------------------------------------------------- replay one lift

/**
 * Replays a lift's history to derive everything about it.
 * lift: { id, equipment, sets, repMin, repMax, increment, base, bodyweight, hold, seed: {sets, bw} }
 * items: chronological mix of
 *   { kind: 'session', sessionId, date, ts, entry, bw, tags }
 *   { kind: 'event', type: 'stepback'|'dismiss'|'rebase', ts, sets? }
 */
export function replayLift(lift, items, settings = DEFAULT_SETTINGS) {
  const seedSets = heavyFirst(lift.seed.sets);
  const seedScore = liftScore(seedSets, seedSets.length, offsetFor(lift, lift.seed.bw));
  const scores = [seedScore];
  let baseline = seedSets;
  let prevWork = seedSets;
  let ch = chInit(seedSets);
  let streak = [];
  let steppedBack = false;
  const timeline = [];
  for (const it of items) {
    if (it.kind === 'event') {
      if (it.type === 'stepback' || it.type === 'rebase') { baseline = heavyFirst(it.sets); streak = []; steppedBack = it.type === 'stepback'; }
      else if (it.type === 'dismiss') streak = [];
      continue;
    }
    const e = it.entry;
    if (!e || e.status !== 'done') continue; // skipped lifts: no score, no miss
    steppedBack = false;
    const offset = offsetFor(lift, it.bw);
    const prescribed = e.prescribed || lift.sets;
    const score = liftScore(e.work, prescribed, offset);
    const number = numberOf(scores, settings.numberWindow);
    const baselineBefore = baseline;
    const moveUp = isMoveUp(prevWork, e.work);
    prevWork = (e.work || []).filter(isDone);
    const { hit } = evaluateTarget(e.target || [], e.work, offset);
    if (hit) streak = [];
    else if (!e.held) streak.push({ sessionId: it.sessionId, date: it.date, tags: it.tags || [] });
    baseline = updateBaseline(baseline, e.work, prescribed, offset).baseline;
    const chr = chSession(ch, e.work, settings);
    ch = chr.next;
    scores.push(score);
    timeline.push({
      sessionId: it.sessionId, date: it.date, ts: it.ts, tags: it.tags || [],
      score, number, ratio: number > 0 ? score / number : null,
      moveUp, hit, held: !!e.held, target: e.target || [], work: e.work,
      baselineBefore, baselineAfter: baseline, ch: chr.events, chFlags: chr.flags,
      missStreak: streak.length,
      heaviest: heaviestSet(e.work), e1rm: bestE1rm(e.work, offset),
    });
  }
  const bs = behindSeries(timeline, settings);
  timeline.forEach((t, i) => { t.behind = bs[i].behind; });
  const target = lift.hold && lift.hold.sets
    ? { sets: heavyFirst(lift.hold.sets), kind: 'hold' }
    : computeTarget(baseline, lift, settings);
  if (steppedBack && target.kind !== 'hold') target.kind = 'stepback';
  const suggestion = streak.length >= settings.missesForStepBack
    ? { ...stepBack(baseline, lift, settings), misses: streak.slice(-settings.missesForStepBack) }
    : null;
  return {
    liftId: lift.id, seedScore, scores, baseline, target, suggestion, ch, timeline,
    number: numberOf(scores, settings.numberWindow),
    behind: timeline.length ? timeline[timeline.length - 1].behind : false,
    missStreak: streak.length,
  };
}

/** Number as of a date: seed + scores of sessions on or before that date. */
export function numberAsOf(L, date, window) {
  const sc = [L.seedScore, ...L.timeline.filter((t) => t.date <= date).map((t) => t.score)];
  return numberOf(sc, window);
}

// ---------------------------------------------------------------- seasons

export function seasonEnd(season) { return addDays(season.start, season.weeks * 7); }

/** Seasons are back to back from the first logged session; a length change applies to new seasons. */
export function extendSeasons(existing, firstDate, today, weeks) {
  let out = (existing || []).map((s) => ({ ...s }));
  if (!firstDate) return out;
  if (!out.length || firstDate < out[0].start) out = [{ start: firstDate, weeks }];
  for (;;) {
    const last = out[out.length - 1];
    const end = seasonEnd(last);
    if (today < end) break;
    out.push({ start: end, weeks });
  }
  return out;
}

export function seasonIndexFor(seasons, date) {
  return seasons.findIndex((s) => date >= s.start && date < seasonEnd(s));
}

function seasonStats(L, season, upTo) {
  const end = upTo && upTo < seasonEnd(season) ? upTo : seasonEnd(season);
  const xs = L.timeline.filter((t) => t.date >= season.start && t.date < end).map((t) => t.score);
  return { count: xs.length, avg: mean(xs) };
}

/**
 * Season CBE check.
 * lifts: replayLift results. sessions: [{date, effort}] (effort 0..1).
 * Bar = 1.01 × best of (seed, every earlier season average with 2+ sessions) — never drops.
 * Overall CBE: mean per-lift % change >= +1% AND season effort average >= gate.
 * Lifts with fewer than `minSessions` sessions in the season are left out.
 * upTo (exclusive date) turns this into a season-to-date pace check.
 */
export function seasonResults({ lifts, seasons, index, sessions, settings = DEFAULT_SETTINGS, minSessions = 2, upTo = null }) {
  const season = seasons[index];
  const end = upTo && upTo < seasonEnd(season) ? upTo : seasonEnd(season);
  const per = [];
  for (const L of lifts) {
    const st = seasonStats(L, season, end);
    let base = L.seedScore;
    for (let j = 0; j < index; j++) {
      const p = seasonStats(L, seasons[j]);
      if (p.count >= 2 && p.avg > base) base = p.avg;
    }
    const bar = base * (1 + settings.cbePct / 100);
    const included = st.count >= minSessions;
    const pct = included && base > 0 ? (st.avg / base - 1) * 100 : null;
    per.push({
      liftId: L.liftId, count: st.count, avg: st.avg, baseline: base, bar, pct, included,
      cbe: included ? st.avg >= bar - EPS : null,
    });
  }
  const inc = per.filter((p) => p.included);
  const overallPct = inc.length ? mean(inc.map((p) => p.pct)) : null;
  const effs = sessions.filter((s) => s.date >= season.start && s.date < end && s.effort !== null && s.effort !== undefined).map((s) => s.effort);
  const effortAvg = mean(effs);
  const effortOk = effortAvg !== null && effortAvg >= settings.effortGate - EPS;
  const pctOk = overallPct !== null && overallPct >= settings.cbePct - EPS;
  return {
    index, start: season.start, end: seasonEnd(season), perLift: per, overallPct, effortAvg,
    effortOk, pctOk, overall: inc.length > 0 && effortAvg !== null ? pctOk && effortOk : null,
    sessionCount: sessions.filter((s) => s.date >= season.start && s.date < end).length,
  };
}

// ---------------------------------------------------------------- whole-history analysis

/** Chronological order: date first, then timestamp (events carry the date they happened). */
export function byTime(a, b) {
  const da = a.date || '', db = b.date || '';
  if (da !== db) return da < db ? -1 : 1;
  return (a.ts || 0) - (b.ts || 0);
}

/**
 * state: { settings, routine: {days, lifts}, sessions, events, meta }
 * today: 'YYYY-MM-DD'
 */
export function analyze(state, today) {
  const S = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  const sessions = (state.sessions || []).slice().sort((a, b) => byTime({ date: a.date, ts: a.finishedAt }, { date: b.date, ts: b.finishedAt }));
  const events = state.events || [];
  const lifts = Object.values(state.routine.lifts).filter((l) => l.seed && l.seed.sets && l.seed.sets.length);
  const perLift = {};
  for (const lift of lifts) {
    const items = [];
    for (const s of sessions) {
      const e = s.lifts.find((x) => x.liftId === lift.id);
      if (e) items.push({ kind: 'session', sessionId: s.id, date: s.date, ts: s.finishedAt || 0, entry: e, bw: s.bw, tags: s.tags || [] });
    }
    for (const ev of events) if (ev.liftId === lift.id) items.push({ kind: 'event', ...ev });
    items.sort(byTime);
    perLift[lift.id] = replayLift(lift, items, S);
  }
  // per-session stats
  const tlIndex = {};
  Object.values(perLift).forEach((L) => L.timeline.forEach((t) => { tlIndex[`${L.liftId}|${t.sessionId}`] = t; }));
  const efforts = [];
  const sessionStats = sessions.map((s) => {
    const pairs = [];
    let targets = 0, hits = 0, held = 0, skipped = 0, logged = 0;
    const ch = [], behind = [], lifts2 = [];
    for (const e of s.lifts) {
      const t = tlIndex[`${e.liftId}|${s.id}`];
      if (!t) { if (e.status === 'skipped') skipped += 1; continue; }
      logged += 1;
      pairs.push({ score: t.score, number: t.number });
      if (e.held) held += 1; else { targets += 1; if (t.hit) hits += 1; }
      t.ch.forEach((c) => ch.push({ ...c, liftId: e.liftId }));
      if (t.behind) behind.push(e.liftId);
      lifts2.push({ liftId: e.liftId, score: t.score, number: t.number, ratio: t.ratio, hit: t.hit, held: t.held, moveUp: t.moveUp });
    }
    const effort = effortValue(s.effort);
    efforts.push(effort);
    const slip = effortSlip(efforts, S);
    return {
      id: s.id, date: s.date, dayId: s.dayId, dayName: s.dayName, tags: s.tags || [], note: s.note || '',
      rating: sessionRating(pairs), effort, targets, hits, held, skipped, logged, ch, behind,
      slipping: slip.slipping, slip, lifts: lifts2,
    };
  });
  const firstDate = sessions.length ? sessions[0].date : null;
  const seasons = extendSeasons((state.meta && state.meta.seasons) || [], firstDate, today, S.seasonWeeks);
  const currentSeason = seasons.length ? seasonIndexFor(seasons, today) : -1;
  return {
    settings: S, perLift, sessionStats, seasons, currentSeason, firstDate,
    slip: effortSlip(sessionStats.map((x) => x.effort), S),
  };
}

/** Focus lifts for a season: explicit pick, else carried over from the latest earlier pick. */
export function focusFor(meta, index) {
  const f = (meta && meta.focus) || {};
  for (let i = index; i >= 0; i--) if (f[i]) return f[i];
  return [];
}

/** Season-to-date pace as of `date` (report card): same math, 1+ session counts, focus lifts pulled out. */
export function seasonPace(A, date, focus = []) {
  const index = seasonIndexFor(A.seasons, date);
  if (index < 0) return null;
  const lifts = Object.values(A.perLift);
  const r = seasonResults({
    lifts, seasons: A.seasons, index, sessions: A.sessionStats,
    settings: A.settings, minSessions: 1, upTo: addDays(date, 1),
  });
  return {
    ...r,
    daysLeft: daysBetween(date, seasonEnd(A.seasons[index])),
    focus: focus.map((id) => r.perLift.find((p) => p.liftId === id)).filter(Boolean),
  };
}

// ---------------------------------------------------------------- reviews, context, trends

export function reviewDue(meta, firstDate, today, days = 14) {
  const anchor = (meta && meta.lastReviewAt) || firstDate;
  if (!anchor) return false;
  return daysBetween(anchor, today) >= days;
}

/** For each tag with 3+ sessions: average rating and effort when tagged vs untagged. */
export function contextSummary(sessionStats, minCount = 3) {
  const avg = (xs, k) => mean(xs.map((x) => x[k]).filter((v) => v !== null && v !== undefined));
  return TAGS.map((tag) => {
    const t = sessionStats.filter((s) => s.tags.includes(tag));
    if (t.length < minCount) return null;
    const u = sessionStats.filter((s) => !s.tags.includes(tag));
    return {
      tag, n: t.length,
      ratingTagged: avg(t, 'rating'), ratingUntagged: avg(u, 'rating'),
      effortTagged: avg(t, 'effort'), effortUntagged: avg(u, 'effort'),
    };
  }).filter(Boolean);
}

/** % of sessions rated 1000+ and sessions per week over [from, to). */
export function consistency(sessionStats, from, to) {
  const xs = sessionStats.filter((s) => s.date >= from && s.date < to);
  const rated = xs.filter((s) => s.rating !== null);
  const weeks = Math.max(1, daysBetween(from, to)) / 7;
  return {
    count: xs.length,
    pct1000: rated.length ? (rated.filter((s) => s.rating >= 1000 - EPS).length / rated.length) * 100 : null,
    perWeek: xs.length / weeks,
  };
}

/** Two-week team review. */
export function buildReview(A, meta, today, lastExportAt, routine) {
  const S = A.settings;
  const from = addDays(today, -S.reviewDays);
  const prevFrom = addDays(from, -S.reviewDays);
  const lifts = Object.values(A.perLift)
    .filter((L) => L.timeline.length)
    .map((L) => {
      const last = L.timeline[L.timeline.length - 1];
      const then = numberAsOf(L, addDays(from, -1), S.numberWindow);
      return {
        liftId: L.liftId, latest: last.score, numberBefore: last.number, number: L.number,
        ahead: last.score >= last.number - EPS, vsNumberPct: (last.score / last.number - 1) * 100,
        change2w: then ? (L.number / then - 1) * 100 : null, behind: L.behind,
      };
    });
  const eff = (a, b) => mean(A.sessionStats.filter((s) => s.date >= a && s.date < b && s.effort !== null).map((s) => s.effort));
  const end = addDays(today, 1);
  const backupAge = lastExportAt ? daysBetween(lastExportAt, today) : null;
  return {
    from, to: today, lifts,
    effort: { recent: eff(from, end), previous: eff(prevFrom, from), slip: A.slip,
      series: A.sessionStats.slice(-12).map((s) => ({ date: s.date, effort: s.effort })) },
    consistency: { twoWeeks: consistency(A.sessionStats, from, end),
      season: A.currentSeason >= 0 ? consistency(A.sessionStats, A.seasons[A.currentSeason].start, end) : null },
    context: contextSummary(A.sessionStats),
    suggestions: Object.values(A.perLift).filter((L) => L.suggestion).map((L) => ({ liftId: L.liftId, ...L.suggestion })),
    backupDue: backupAge === null || backupAge >= S.backupDays, backupAge,
  };
}

/** Month vs month: per-lift average lift score, mean of per-lift % changes, effort, session count. */
export function monthCompare(A, monthA, monthB) {
  const per = Object.values(A.perLift).map((L) => {
    const a = mean(L.timeline.filter((t) => monthKey(t.date) === monthA).map((t) => t.score));
    const b = mean(L.timeline.filter((t) => monthKey(t.date) === monthB).map((t) => t.score));
    return { liftId: L.liftId, a, b, pct: a !== null && b !== null && b > 0 ? (a / b - 1) * 100 : null };
  });
  const both = per.filter((p) => p.pct !== null);
  const sm = (m) => A.sessionStats.filter((s) => monthKey(s.date) === m);
  const effortAvg = (m) => mean(sm(m).map((s) => s.effort).filter((v) => v !== null));
  return {
    monthA, monthB, perLift: per,
    overallPct: both.length ? mean(both.map((p) => p.pct)) : null,
    effortA: effortAvg(monthA), effortB: effortAvg(monthB),
    countA: sm(monthA).length, countB: sm(monthB).length,
    hasB: sm(monthB).length > 0,
  };
}

// ---------------------------------------------------------------- rotation

export function nextDayId(rotation, lastDayId) {
  if (!rotation.length) return null;
  const i = rotation.indexOf(lastDayId);
  return i < 0 ? rotation[0] : rotation[(i + 1) % rotation.length];
}

// ---------------------------------------------------------------- formatting helpers (pure)

export function fmtW(w) {
  if (w === null || w === undefined || w === '') return '–';
  const n = Number(w);
  return Number.isInteger(n) ? String(n) : String(rw(n));
}

/** "57.5 × 10/10/9" or "20 × 6 · 15 × 12/12" */
export function fmtSets(sets) {
  const hs = sets || [];
  if (!hs.length) return '–';
  const groups = [];
  for (const s of hs) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.w - s.w) < EPS) g.r.push(s.r);
    else groups.push({ w: s.w, r: [s.r] });
  }
  return groups.map((g) => `${fmtW(g.w)} × ${g.r.join('/')}`).join(' · ');
}
