// tests.js — progression + CBE tests. Zero dependencies.
// Node:    node tests.js
// Browser: open tests.html (also linked from Settings in the app)
import * as L from './logic.js';

const results = [];
let current = '';
function test(name, fn) {
  current = name;
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e && e.message ? e.message : String(e) }); }
}
function ok(cond, msg = 'expected true') { if (!cond) throw new Error(msg); }
function eq(a, b, msg = '') {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} expected ${sb} got ${sa}`);
}
function near(a, b, eps = 0.01, msg = '') {
  if (a === null || a === undefined || Math.abs(a - b) > eps) throw new Error(`${msg} expected ≈${b} got ${a}`);
}

// ---------------------------------------------------------------- builders
const S = L.DEFAULT_SETTINGS;
const sets = (w, reps) => reps.map((r, i) => ({ w: Array.isArray(w) ? w[i] : w, r }));
const done = (w, reps) => sets(w, reps).map((s) => ({ ...s, done: true }));
function mkLift(id, equipment, n, seedW, seedReps, over = {}) {
  return {
    id, name: id, equipment, sets: n, base: 0, bodyweight: false,
    ...L.equipmentDefaults(equipment),
    seed: { sets: sets(seedW, seedReps), bw: null },
    ...over,
  };
}
const day = (i) => L.addDays('2026-10-05', i * 3);

/** Runs sessions the way the app does: target = replay of history so far. */
function simulate(lift, logs) {
  const items = [];
  const targets = [];
  logs.forEach((lg, i) => {
    const R = L.replayLift(lift, items, S);
    if (lg.event) { items.push({ kind: 'event', type: lg.event, ts: i * 10 + 1, date: day(i), sets: lg.event === 'stepback' ? R.suggestion.sets : lg.sets }); targets.push(null); return; }
    const target = lg.target || R.target.sets;
    targets.push(target);
    const w = lg.w !== undefined ? lg.w : target.map((t) => t.w);
    const work = lg.skip ? [] : done(w, lg.reps);
    items.push({
      kind: 'session', sessionId: `s${i}`, date: lg.date || day(i), ts: i * 10, bw: lg.bw ?? null, tags: lg.tags || [],
      entry: { liftId: lift.id, status: lg.skip ? 'skipped' : 'done', held: !!lg.held, target, prescribed: lift.sets,
        work, ramp: lg.ramp || [], drop: lg.drop || [] },
    });
  });
  return { R: L.replayLift(lift, items, S), targets, items };
}

// ================================================================= PROGRESSION

test('first session ever: listed sets count as the best (plate → +2.5 on all)', () => {
  const row = mkLift('row', 'plate', 3, 55, [10, 10, 10]);
  eq(L.computeTarget(row.seed.sets, row).sets, sets(57.5, [10, 10, 10]));
  const fly = mkLift('fly', 'machine', 3, 100, [10, 10, 10]);
  eq(L.computeTarget(fly.seed.sets, fly).sets, sets(100, [11, 10, 10]));
  const ohf = mkLift('ohf', 'cable', 2, 12.5, [10, 10]);
  eq(L.computeTarget(ohf.seed.sets, ohf).sets, sets(12.5, [11, 10]));
});

test('target hit: log becomes baseline and the next step is +1 rep', () => {
  const fly = mkLift('fly', 'machine', 3, 100, [10, 10, 10]);
  const { R, targets } = simulate(fly, [{ reps: [11, 10, 10] }, { reps: [11, 11, 10] }]);
  eq(targets[1], sets(100, [11, 11, 10]));
  eq(R.target.sets, sets(100, [11, 11, 11]));
  eq(R.timeline.map((t) => t.hit), [true, true]);
});

test('beating a target: the actual log becomes the baseline', () => {
  const curl = mkLift('curl', 'dumbbell', 3, 15, [10, 10, 10]);
  const { R } = simulate(curl, [{ reps: [12, 11, 10] }]);
  eq(R.baseline, sets(15, [12, 11, 10]));
  eq(R.target.sets, sets(15, [12, 11, 11]));
});

test('target missed below best: best holds, same target repeats', () => {
  const row = mkLift('row', 'plate', 3, 57.5, [10, 10, 10]);
  const { R, targets } = simulate(row, [{ reps: [8, 7, 7] }]);
  eq(targets[0], sets(60, [10, 10, 10]));
  eq(R.timeline[0].hit, false);
  eq(R.baseline, sets(57.5, [10, 10, 10]), 'baseline');
  eq(R.target.sets, sets(60, [10, 10, 10]), 'target repeats');
  near(R.timeline[0].score, 74.67);
  eq(R.missStreak, 1);
});

test('target missed but above best: log becomes baseline (worked example, seated row)', () => {
  const row = mkLift('row', 'plate', 3, 55, [10, 10, 10]);
  const { R, targets } = simulate(row, [{ reps: [10, 10, 8] }, { reps: [10, 10, 9] }, { reps: [10, 10, 10] }]);
  eq(targets, [sets(57.5, [10, 10, 10]), sets(57.5, [10, 10, 9]), sets(57.5, [10, 10, 10])]);
  near(R.timeline[0].score, 75.39);
  eq(R.timeline.map((t) => t.hit), [false, true, true]);
  eq(R.target.sets, sets(60, [10, 10, 10]));
});

test('machine top of range: all sets to next stack weight, back to bottom of range', () => {
  const fly = mkLift('fly', 'machine', 3, 100, [12, 12, 12]);
  const t = L.computeTarget(fly.seed.sets, fly);
  eq(t.sets, sets(105, [10, 10, 10]));
  eq(t.kind, 'moveup');
  near(L.liftScore(t.sets, 3), L.liftScore(fly.seed.sets, 3), 0.01, 'score holds level');
});

test('cable/DB top of range: one set moves up a weight and targets 6+', () => {
  const curl = mkLift('curl', 'dumbbell', 3, 15, [12, 12, 12]);
  const t = L.computeTarget(curl.seed.sets, curl);
  eq(t.sets, [{ w: 20, r: 6 }, { w: 15, r: 12 }, { w: 15, r: 12 }]);
  eq(t.kind, 'moveup');
  const ohf = mkLift('ohf', 'cable', 2, 12.5, [15, 15]);
  eq(L.computeTarget(ohf.seed.sets, ohf).sets, [{ w: 17.5, r: 6 }, { w: 12.5, r: 15 }]);
});

test('one set moved up: it climbs; at the top the next set moves', () => {
  const curl = mkLift('curl', 'dumbbell', 3, 15, [12, 12, 12]);
  eq(L.computeTarget([{ w: 20, r: 6 }, { w: 15, r: 12 }, { w: 15, r: 12 }], curl).sets, [{ w: 20, r: 7 }, { w: 15, r: 12 }, { w: 15, r: 12 }]);
  eq(L.computeTarget([{ w: 20, r: 12 }, { w: 15, r: 12 }, { w: 15, r: 12 }], curl).sets, [{ w: 20, r: 12 }, { w: 20, r: 6 }, { w: 15, r: 12 }]);
  eq(L.computeTarget(sets(20, [12, 12, 12]), curl).sets, [{ w: 25, r: 6 }, { w: 20, r: 12 }, { w: 20, r: 12 }]);
});

test('full DB example: incline curl climbs 10s → 12s → moves a set to 20', () => {
  const curl = mkLift('curl', 'dumbbell', 3, 15, [10, 10, 10]);
  const reps = [[11, 10, 10], [11, 11, 10], [11, 11, 11], [12, 11, 11], [12, 12, 11], [12, 12, 12]];
  const { R, targets } = simulate(curl, reps.map((r) => ({ reps: r })));
  eq(targets.map((t) => t.map((s) => s.r)), reps);
  eq(R.target.sets, [{ w: 20, r: 6 }, { w: 15, r: 12 }, { w: 15, r: 12 }]);
});

test('full cable example: overhead fly 10/10 → 15/15, then one set moves to 17.5', () => {
  const ohf = mkLift('ohf', 'cable', 2, 12.5, [10, 10]);
  const logs = [];
  for (let a = 10, b = 10; !(a === 15 && b === 15);) { if (a <= b) a += 1; else b += 1; logs.push({ reps: [a, b] }); }
  const { R, targets } = simulate(ohf, logs);
  eq(targets.length, 10);
  eq(targets[0], sets(12.5, [11, 10]));
  eq(R.target.sets, [{ w: 17.5, r: 6 }, { w: 12.5, r: 15 }]);
  near(L.liftScore(R.target.sets, 2), 19.875, 0.001, 'score still rises on the move-up');
  near(L.liftScore(sets(12.5, [15, 15]), 2), 18.75, 0.001);
  const { R: R2 } = simulate(ohf, [...logs, { reps: [6, 15] }]);
  eq(R2.timeline[R2.timeline.length - 1].moveUp, true, 'move-up session flagged (skipped by Behind)');
  eq(R2.target.sets, [{ w: 17.5, r: 7 }, { w: 12.5, r: 15 }]);
});

test('first session at a new weight: baseline resets to that weight', () => {
  const fly = mkLift('fly', 'machine', 3, 100, [12, 12, 12]);
  const { R } = simulate(fly, [{ reps: [10, 10, 10] }]);
  eq(R.baseline, sets(105, [10, 10, 10]));
  eq(R.target.sets, sets(105, [11, 10, 10]));
  eq(R.timeline[0].moveUp, true);
});

test('moved-up set logged under 6 reps: target never drops below 6', () => {
  const curl = mkLift('curl', 'dumbbell', 3, 15, [12, 12, 12]);
  const { R } = simulate(curl, [{ w: [20, 15, 15], reps: [4, 12, 12] }]);
  eq(R.timeline[0].hit, false);
  eq(R.target.sets, [{ w: 20, r: 6 }, { w: 15, r: 12 }, { w: 15, r: 12 }]);
});

test('calf raise (plate, 10–15): reps climb to 15, then all sets +2.5 and back to 10', () => {
  const calf = mkLift('calf', 'plate', 3, 0, [12, 11, 11], { repMin: 10, repMax: 15, base: 5 });
  eq(L.computeTarget(calf.seed.sets, calf).sets, sets(0, [12, 12, 11]));
  eq(L.computeTarget(sets(0, [15, 15, 15]), calf).sets, sets(2.5, [10, 10, 10]));
  near(L.liftScore(calf.seed.sets, 3, L.offsetFor(calf, null)), 5 * (1 + 34 / 90), 0.001, 'scored on the 5-lb base');
});

test('hit check: sets matched heaviest-first in any order; heavier set counts if Epley ≥', () => {
  const target = [{ w: 20, r: 6 }, { w: 15, r: 12 }, { w: 15, r: 12 }];
  ok(L.evaluateTarget(target, done([15, 15, 20], [12, 12, 6])).hit, 'heavy set done last');
  ok(L.evaluateTarget(sets(57.5, [10, 10, 10]), done(60, [9, 9, 9])).hit, '60×9 beats 57.5×10');
  ok(!L.evaluateTarget(sets(57.5, [10, 10, 10]), done(55, [12, 12, 12])).hit, 'lighter weight never counts');
  ok(L.evaluateTarget(sets(100, [12, 12, 12]), done([100, 100, 100, 105], [12, 12, 12, 5])).hit, 'extra heavy attempt is ignored');
  ok(!L.evaluateTarget(sets(100, [12, 12, 12]), done(100, [12, 12])).hit, 'missing set = miss');
});

test('3 misses in a row → step-back suggestion (~10% lighter) with those sessions\' tags', () => {
  const row = mkLift('row', 'plate', 3, 57.5, [10, 10, 10]);
  const { R } = simulate(row, [
    { reps: [8, 7, 7], tags: ['sleep'] }, { reps: [8, 8, 8] }, { reps: [9, 8, 7], tags: ['stress'] },
  ]);
  ok(R.suggestion, 'suggestion exists');
  eq(R.suggestion.kind, 'lighter');
  eq(R.suggestion.sets, sets(52.5, [10, 10, 10]));
  eq(R.suggestion.misses.map((m) => m.tags), [['sleep'], [], ['stress']]);
  const two = simulate(row, [{ reps: [8, 7, 7] }, { reps: [8, 7, 7] }]).R;
  eq(two.suggestion, null, 'not after 2');
});

test('a log that ties your best at a heavier weight becomes the baseline (still a miss)', () => {
  const row = mkLift('row', 'plate', 3, 57.5, [10, 10, 10]);
  const { R } = simulate(row, [{ reps: [9, 8, 8] }]);   // 60 × 9/8/8 = 76.67 = 57.5 × 10 × 3
  eq(R.timeline[0].hit, false);
  eq(R.baseline, sets(60, [9, 8, 8]));
  eq(R.target.sets, sets(60, [9, 9, 8]));
});

test('accepting a step back resets the baseline (next target 55 × 10/10/10) and the streak', () => {
  const row = mkLift('row', 'plate', 3, 57.5, [10, 10, 10]);
  const { R } = simulate(row, [{ reps: [8, 7, 7] }, { reps: [8, 7, 7] }, { reps: [8, 7, 7] }, { event: 'stepback' }]);
  eq(R.suggestion, null);
  eq(R.missStreak, 0);
  eq(R.target.sets, sets(55, [10, 10, 10]));
  eq(R.target.kind, 'stepback', 'labelled as a step back until the next session');
});

test('dismissing a step back clears the streak; it needs 3 new misses', () => {
  const row = mkLift('row', 'plate', 3, 57.5, [10, 10, 10]);
  const logs = [{ reps: [8, 7, 7] }, { reps: [8, 7, 7] }, { reps: [8, 7, 7] }, { event: 'dismiss' }, { reps: [8, 7, 7] }];
  const { R } = simulate(row, logs);
  eq(R.suggestion, null);
  eq(R.missStreak, 1);
  eq(R.target.sets, sets(60, [10, 10, 10]), 'baseline untouched by dismiss');
});

test('step back for cable/DB: heaviest set drops one weight, same reps', () => {
  const curl = mkLift('curl', 'dumbbell', 3, 15, [10, 10, 10]);
  eq(L.stepBack([{ w: 20, r: 8 }, { w: 15, r: 12 }, { w: 15, r: 12 }], curl).sets, [{ w: 15, r: 12 }, { w: 15, r: 12 }, { w: 15, r: 8 }]);
  eq(L.stepBack(sets(15, [12, 11, 11]), curl).sets, [{ w: 15, r: 12 }, { w: 15, r: 11 }, { w: 10, r: 11 }]);
  const calf = mkLift('calf', 'plate', 3, 0, [15, 15, 14], { repMin: 10, repMax: 15, base: 5 });
  eq(L.stepBack(calf.seed.sets, calf).kind, 'fewer-reps', 'nothing lighter than +0');
});

test('hold: target repeats with no progression and no miss counted', () => {
  const fly = mkLift('fly', 'machine', 3, 100, [10, 10, 10], { hold: { sets: sets(100, [11, 10, 10]) } });
  const { R, targets } = simulate(fly, [
    { reps: [10, 10, 10], held: true }, { reps: [10, 10, 9], held: true }, { reps: [9, 9, 9], held: true }, { reps: [12, 12, 12], held: true },
  ]);
  eq(targets.every((t) => JSON.stringify(t) === JSON.stringify(sets(100, [11, 10, 10]))), true, 'same target every time');
  eq(R.suggestion, null);
  eq(R.missStreak, 0);
  eq(R.target.sets, sets(100, [11, 10, 10]), 'still frozen while held');
  eq(R.baseline, sets(100, [12, 12, 12]), 'a beat still updates your best');
  const { R: un } = simulate({ ...fly, hold: null }, [{ reps: [12, 12, 12], held: true }]);
  eq(un.target.sets, sets(105, [10, 10, 10]), 'progression resumes from best when unheld');
});

test('skip: no score, no miss, streak and number untouched', () => {
  const row = mkLift('row', 'plate', 3, 57.5, [10, 10, 10]);
  const { R } = simulate(row, [{ reps: [8, 7, 7] }, { skip: true, reps: [] }, { reps: [8, 7, 7] }, { skip: true, reps: [] }]);
  eq(R.timeline.length, 2, 'only logged sessions score');
  eq(R.missStreak, 2);
  eq(R.scores.length, 3, 'seed + 2');
});

test('ramp and drop sets are ignored by targets, scores, and career highs', () => {
  const lat = mkLift('lat', 'dumbbell', 2, 30, [10, 10]);
  const plain = simulate(lat, [{ reps: [11, 10] }]).R;
  const noisy = simulate(lat, [{ reps: [11, 10], ramp: done(200, [10]), drop: done(300, [12]) }]).R;
  eq(noisy.timeline[0].score, plain.timeline[0].score);
  eq(noisy.target, plain.target);
  eq(noisy.timeline[0].ch, plain.timeline[0].ch);
  eq(noisy.ch.heaviest, 30);
});

test('career highs: heavier set (6+ reps) or more total reps at a used weight', () => {
  const st = L.chInit(sets(15, [10, 10, 10]));
  const a = L.chSession(st, done(15, [11, 10, 10]));
  eq(a.events.map((e) => e.type), ['reps']);
  eq(a.flags, [null, null, 'reps']);
  const b = L.chSession(st, done([20, 15, 15], [6, 12, 12]));
  eq(b.events[0], { type: 'heaviest', w: 20, r: 6, set: 0 });
  const c = L.chSession(st, done([20, 15, 15], [5, 10, 10]));
  eq(c.events.filter((e) => e.type === 'heaviest').length, 0, '5 reps is not a heavier-set CH');
  const d = L.chSession(L.chInit(sets(57.5, [10, 10, 10])), done(52.5, [10, 10, 10]));
  eq(d.events.length, 0, 'a new lighter weight is not a career high');
});

// ================================================================= LIFT SCORE

test('lift score: a prescribed set not done counts as 0', () => {
  const ws = [{ w: 100, r: 10, done: true }, { w: 100, r: 10, done: true }, { w: 100, r: 10, done: false }];
  near(L.liftScore(ws, 3), (2 * 100 * (1 + 10 / 30)) / 3);
  near(L.liftScore([], 3), 0);
});

test('lift score: extra sets beyond prescribed average in', () => {
  near(L.liftScore(done(100, [12, 12, 12, 8]), 3), (3 * 140 + 100 * (1 + 8 / 30)) / 4);
});

test('lift score: bodyweight load = bodyweight + added weight (snapshot per session)', () => {
  const dip = mkLift('dip', 'bodyweight', 2, 0, [12, 12], { bodyweight: true });
  dip.seed.bw = 190;
  near(L.liftScore(done([0, 5], [15, 14]), 2, L.offsetFor(dip, 195)), (L.epley(195, 15) + L.epley(200, 14)) / 2);
  const { R } = simulate(dip, [{ reps: [12, 12], w: [0, 0], bw: 200 }]);
  near(R.seedScore, L.epley(190, 12), 0.001, 'seed uses its own bodyweight');
  near(R.timeline[0].score, L.epley(200, 12), 0.001, 'session uses its bodyweight');
});

// ================================================================= NUMBER + RATING (worked example)

test('number: starts at the seed, 6-session window, seed ages out (chest fly)', () => {
  const fly = mkLift('fly', 'machine', 3, 100, [10, 10, 10]);
  const logs = [[11, 11, 10], [11, 11, 11], [12, 11, 11], [11, 11, 11], [12, 12, 11], [12, 12, 12]];
  const { R } = simulate(fly, logs.map((r) => ({ reps: r })));
  near(R.seedScore, 133.33);
  eq(R.timeline.map((t) => +t.score.toFixed(2)), [135.56, 136.67, 137.78, 136.67, 138.89, 140]);
  eq(R.timeline.map((t) => +t.number.toFixed(2)), [133.33, 134.44, 135.19, 135.83, 136, 136.48]);
  near(R.number, 137.59, 0.01, 'after 6 real sessions the seed is gone');
  eq(R.timeline[3].hit, false, 'session 4 missed 12/12/11');
  eq(R.timeline.map((t) => t.target.map((s) => s.r).join('/')), ['11/10/10', '11/11/11', '12/11/11', '12/12/11', '12/12/11', '12/12/12']);
  eq(R.target.sets, sets(105, [10, 10, 10]));
});

test('session rating = 1000 × mean(lift score ÷ number before)', () => {
  const r = L.sessionRating([
    { score: 135.5556, number: 133.3333 }, { score: 20.1667, number: 20 }, { score: 16.4583, number: 16.6667 },
  ]);
  near(r, 1004.2, 0.1);
  eq(L.sessionRating([]), null);
});

test('session rating through analyze (skipped lifts excluded)', () => {
  const st = mkState();
  st.sessions = [mkSession('a', day(0), [
    entry('fly', [11, 11, 10], 100, sets(100, [11, 10, 10])),
    entry('curl', [11, 10, 10], 15, sets(15, [11, 10, 10])),
    entry('mid', [10, 9], 12.5, sets(12.5, [11, 10])),
    { liftId: 'row', status: 'skipped', work: [], target: [], prescribed: 3 },
  ])];
  const A = L.analyze(st, day(1));
  near(A.sessionStats[0].rating, 1004.2, 0.1);
  eq(A.sessionStats[0].skipped, 1);
  eq([A.sessionStats[0].hits, A.sessionStats[0].targets], [2, 3]);
});

// ================================================================= FLAGS

test('Behind: 2 sessions in a row below the number, counted from the 4th session', () => {
  const e = (score, number, moveUp = false) => ({ score, number, moveUp });
  const s = L.behindSeries([e(90, 100), e(90, 100), e(90, 100), e(90, 100), e(90, 100)]);
  eq(s.map((x) => x.behind), [false, false, false, false, true]);
});

test('Behind clears at the next session at or above the number', () => {
  const e = (score, number) => ({ score, number, moveUp: false });
  const s = L.behindSeries([e(100, 100), e(100, 100), e(100, 100), e(90, 100), e(90, 100), e(95, 100), e(100, 100), e(90, 100)]);
  eq(s.map((x) => x.behind), [false, false, false, false, true, true, false, false]);
});

test('Behind ignores weight-move sessions (they can clear it, never trigger it)', () => {
  const e = (score, number, moveUp = false) => ({ score, number, moveUp });
  const s1 = L.behindSeries([e(100, 100), e(100, 100), e(100, 100), e(90, 100), e(85, 100, true), e(95, 100)]);
  eq(s1.map((x) => x.behind), [false, false, false, false, false, true], 'move-up below skipped, streak continues');
  const s2 = L.behindSeries([e(100, 100), e(100, 100), e(100, 100), e(90, 100), e(90, 100), e(101, 100, true)]);
  eq(s2.map((x) => x.behind), [false, false, false, false, true, false], 'move-up at/above clears');
  const s3 = L.behindSeries([e(100, 100), e(100, 100), e(100, 100), e(90, 100, true), e(90, 100, true), e(90, 100, true)]);
  ok(s3.every((x) => !x.behind), 'move-ups alone never trigger');
});

test('stuck at a new weight: only the first session there is exempt from Behind', () => {
  const row = mkLift('row', 'plate', 3, 70, [10, 10, 10]);
  const logs = Array.from({ length: 6 }, () => ({ reps: [8, 8, 8] }));   // 72.5 × 8/8/8 every time
  const { R } = simulate(row, logs);
  eq(R.timeline.map((t) => t.moveUp), [true, false, false, false, false, false]);
  const s = L.behindSeries([{ score: 95, number: 90, moveUp: false }, { score: 95, number: 90, moveUp: false }, { score: 95, number: 90, moveUp: false },
    { score: 89, number: 90, moveUp: true }, { score: 89, number: 90, moveUp: false }, { score: 89, number: 90, moveUp: false }]);
  eq(s.map((x) => x.behind), [false, false, false, false, false, true], 'later sessions at that weight count');
  ok(R.suggestion, '3+ misses → step-back suggestion');
});

test('Behind through replay: a bad stretch flags the lift, a good day clears it', () => {
  const fly = mkLift('fly', 'machine', 3, 100, [10, 10, 10]);
  const { R } = simulate(fly, [
    { reps: [11, 10, 10] }, { reps: [11, 11, 10] }, { reps: [11, 11, 11] },
    { reps: [9, 9, 9], target: sets(100, [12, 11, 11]) }, { reps: [9, 9, 9], target: sets(100, [12, 11, 11]) },
  ]);
  eq(R.timeline.map((t) => t.behind), [false, false, false, false, true]);
  eq(R.behind, true);
  const { R: R2 } = simulate(fly, [
    { reps: [11, 10, 10] }, { reps: [11, 11, 10] }, { reps: [11, 11, 11] },
    { reps: [9, 9, 9], target: sets(100, [12, 11, 11]) }, { reps: [9, 9, 9], target: sets(100, [12, 11, 11]) }, { reps: [12, 11, 11] },
  ]);
  eq(R2.behind, false);
});

test('effort slipping: last 3 average 20+ points under the norm, from session 7', () => {
  const full = [1, 1, 1, 1, 1, 1];
  eq(L.effortSlip([...full]).active, false, 'not active at 6 sessions');
  const s = L.effortSlip([...full, 2 / 3, 2 / 3, 2 / 3]);
  ok(s.active && s.slipping, 'norm 100 vs recent 67');
  near(s.drop, 33.33);
  ok(!L.effortSlip([...full, 1, 2 / 3, 1]).slipping, '11-point drop is fine');
  ok(L.effortSlip([...full, 1, 1, 1, 0.8, 0.8, 0.8].map((x) => x)).slipping, 'exactly 20 counts');
  const long = [...Array(20).fill(0), ...Array(12).fill(1), 0.67, 0.67, 0.67];
  near(L.effortSlip(long).norm, 100, 0.01, 'norm uses at most 12 sessions');
});

// ================================================================= CONTEXT TAGS

test('context tags change nothing: targets, misses, scores, numbers, flags, ratings, CBEs', () => {
  const st = mkSeasonState();
  const tagged = JSON.parse(JSON.stringify(st));
  tagged.sessions.forEach((s, i) => { s.tags = i % 2 ? ['sick', 'sleep'] : ['stress']; s.note = 'rough day'; });
  const today = L.addDays(st.sessions[st.sessions.length - 1].date, 60);
  const a = L.analyze(st, today), b = L.analyze(tagged, today);
  const strip = (A) => JSON.stringify({
    lifts: Object.values(A.perLift).map((x) => ({ t: x.target, b: x.baseline, n: x.number, beh: x.behind, s: x.suggestion && x.suggestion.sets, m: x.missStreak,
      tl: x.timeline.map((t) => [t.score, t.number, t.hit, t.behind, t.moveUp, t.ch]) })),
    sessions: A.sessionStats.map((s) => [s.rating, s.effort, s.hits, s.slipping]),
    seasons: A.seasons.map((_, i) => L.seasonResults({ lifts: Object.values(A.perLift), seasons: A.seasons, index: i, sessions: A.sessionStats, settings: A.settings })),
  });
  eq(strip(b), strip(a));
  ok(L.contextSummary(b.sessionStats).length >= 1, 'tags still show up in the context summary');
});

// ================================================================= SEASONS

test('season boundaries: 8 weeks back to back from the first session', () => {
  const s = L.extendSeasons([], '2026-10-05', '2027-02-01', 8);
  eq(s.map((x) => x.start), ['2026-10-05', '2026-11-30', '2027-01-25']);
  eq(L.seasonEnd(s[0]), '2026-11-30');
  eq(L.seasonIndexFor(s, '2026-11-29'), 0);
  eq(L.seasonIndexFor(s, '2026-11-30'), 1);
  const changed = L.extendSeasons(s, '2026-10-05', '2027-04-01', 6);
  eq(changed.map((x) => [x.start, x.weeks]), [['2026-10-05', 8], ['2026-11-30', 8], ['2027-01-25', 8], ['2027-03-22', 6]], 'length change applies to new seasons');
});

test('per-lift CBE, season 1: average vs 1.01 × seed (worked example)', () => {
  const fly = mkLift('fly', 'machine', 3, 100, [10, 10, 10]);
  const logs = [[11, 11, 10], [11, 11, 11], [12, 11, 11], [11, 11, 11], [12, 12, 11], [12, 12, 12]];
  const { R } = simulate(fly, logs.map((r) => ({ reps: r })));
  const seasons = L.extendSeasons([], day(0), day(10), 8);
  const sess = logs.map((_, i) => ({ date: day(i), effort: 1 }));
  const r = L.seasonResults({ lifts: [R], seasons, index: 0, sessions: sess });
  const p = r.perLift[0];
  near(p.avg, 137.59); near(p.bar, 134.67); near(p.pct, 3.19); eq(p.cbe, true);
  const weak = simulate(fly, [{ reps: [10, 10, 10] }, { reps: [10, 10, 11] }]).R;
  const r2 = L.seasonResults({ lifts: [weak], seasons, index: 0, sessions: sess });
  eq(r2.perLift[0].cbe, false, '+0.8% misses the 1% bar');
});

test('later seasons: bar = 1.01 × best previous season (never drops; seed is season 0)', () => {
  const mk = (avgs) => ({ liftId: 'x', seedScore: 100, timeline: avgs.flatMap((a, si) => [
    { date: L.addDays('2026-01-01', si * 56 + 1), score: a }, { date: L.addDays('2026-01-01', si * 56 + 2), score: a }]) });
  const seasons = L.extendSeasons([], '2026-01-01', '2026-12-31', 8);
  const run = (avgs, idx) => L.seasonResults({ lifts: [mk(avgs)], seasons, index: idx, sessions: [] }).perLift[0];
  near(run([110, 105, 112], 1).bar, 111.1, 0.01, 'season 2 bar from season 1');
  eq(run([110, 105, 112], 1).cbe, false);
  near(run([110, 105, 112], 2).bar, 111.1, 0.01, 'season 3 bar uses best previous (110), not last (105)');
  eq(run([110, 105, 112], 2).cbe, true);
  near(run([97, 102], 1).bar, 101, 0.01, 'weak season 1 → seed still sets the bar');
});

test('lifts with fewer than 2 sessions in a season are left out (and do not set later bars)', () => {
  const lift = { liftId: 'x', seedScore: 100, timeline: [{ date: '2026-01-02', score: 150 }, { date: '2026-03-01', score: 101 }, { date: '2026-03-03', score: 101.5 }] };
  const seasons = L.extendSeasons([], '2026-01-01', '2026-04-01', 8);
  const s1 = L.seasonResults({ lifts: [lift], seasons, index: 0, sessions: [] });
  eq(s1.perLift[0].included, false);
  eq(s1.perLift[0].cbe, null);
  const s2 = L.seasonResults({ lifts: [lift], seasons, index: 1, sessions: [] });
  near(s2.perLift[0].bar, 101, 0.001, 'one-session season 1 ignored');
  eq(s2.perLift[0].cbe, true);
});

test('overall CBE: mean per-lift change ≥ +1% AND effort average ≥ 2/3', () => {
  const lift = (id, a, b) => ({ liftId: id, seedScore: 100, timeline: [{ date: '2026-01-02', score: a }, { date: '2026-01-05', score: b }] });
  const seasons = L.extendSeasons([], '2026-01-01', '2026-01-10', 8);
  const lifts = [lift('a', 103, 103), lift('b', 100, 100), lift('c', 99.5, 99.5)]; // +3, 0, −0.5 → +0.83%
  const eff = (vals) => vals.map((e, i) => ({ date: L.addDays('2026-01-02', i), effort: e }));
  const fail = L.seasonResults({ lifts, seasons, index: 0, sessions: eff([1, 1]) });
  near(fail.overallPct, 0.833, 0.001); eq(fail.overall, false);
  const lifts2 = [lift('a', 104, 104), lift('b', 100, 100), lift('c', 99.5, 99.5)]; // +1.17%
  eq(L.seasonResults({ lifts: lifts2, seasons, index: 0, sessions: eff([1, 2 / 3, 1 / 3]) }).overall, true, 'effort exactly 2/3 passes');
  const lowEff = L.seasonResults({ lifts: lifts2, seasons, index: 0, sessions: eff([2 / 3, 1 / 3, 2 / 3]) });
  eq([lowEff.pctOk, lowEff.effortOk, lowEff.overall], [true, false, false], 'effort gate blocks it');
  eq(L.seasonResults({ lifts: [], seasons, index: 0, sessions: [] }).overall, null, 'no data, no verdict');
});

test('season pace and focus lifts through analyze', () => {
  const st = mkSeasonState();
  st.meta.focus = { 0: ['fly'] };
  const last = st.sessions[st.sessions.length - 1].date;
  const A = L.analyze(st, last);
  const pace = L.seasonPace(A, last, L.focusFor(st.meta, A.currentSeason));
  ok(pace.daysLeft > 0);
  eq(pace.focus.map((f) => f.liftId), ['fly']);
  ok(pace.focus[0].avg > pace.focus[0].bar, 'fly on pace');
  eq(L.focusFor({ focus: { 0: ['a'], 2: ['b'] } }, 1), ['a'], 'carry over');
});

// ================================================================= MISC

test('review appears 14+ days after the last review (or first session)', () => {
  eq(L.reviewDue({}, '2026-10-01', '2026-10-14'), false);
  eq(L.reviewDue({}, '2026-10-01', '2026-10-15'), true);
  eq(L.reviewDue({ lastReviewAt: '2026-10-15' }, '2026-10-01', '2026-10-20'), false);
  eq(L.reviewDue({}, null, '2026-10-20'), false);
});

test('two-week review data: ahead/behind, effort trend, consistency, backup reminder', () => {
  const st = mkSeasonState();
  const last = st.sessions[st.sessions.length - 1].date;
  const A = L.analyze(st, last);
  const R = L.buildReview(A, st.meta, last, null, st.routine);
  ok(R.lifts.length === 3);
  ok(R.lifts.every((x) => typeof x.ahead === 'boolean'));
  ok(R.backupDue, 'never exported → reminder');
  eq(L.buildReview(A, st.meta, last, last, st.routine).backupDue, false);
  ok(R.consistency.twoWeeks.count >= 1);
});

test('month trends: this month vs last month', () => {
  const st = mkSeasonState();
  const A = L.analyze(st, '2026-12-31');
  const m = L.monthCompare(A, '2026-11', '2026-10');
  ok(m.countA > 0 && m.countB > 0);
  ok(m.overallPct > 0, 'progress shows as a positive change');
  eq(L.addMonths('2026-01', -1), '2025-12');
});

test('rotation advances from the day actually done', () => {
  const rot = ['chest', 'back', 'shoulders', 'legs'];
  eq(L.nextDayId(rot, null), 'chest');
  eq(L.nextDayId(rot, 'legs'), 'chest');
  eq(L.nextDayId(rot, 'back'), 'shoulders');
});

test('formatting: grouped sets', () => {
  eq(L.fmtSets([{ w: 20, r: 6 }, { w: 15, r: 12 }, { w: 15, r: 12 }]), '20 × 6 · 15 × 12/12');
  eq(L.fmtSets(sets(57.5, [10, 10, 9])), '57.5 × 10/10/9');
});

// ---------------------------------------------------------------- state builders for analyze tests
function mkState() {
  const lifts = {
    fly: mkLift('fly', 'machine', 3, 100, [10, 10, 10]),
    curl: mkLift('curl', 'dumbbell', 3, 15, [10, 10, 10]),
    mid: mkLift('mid', 'cable', 2, 12.5, [10, 10]),
    row: mkLift('row', 'plate', 3, 55, [10, 10, 10]),
  };
  return { settings: {}, routine: { days: [], lifts }, sessions: [], events: [], meta: {} };
}
function entry(liftId, reps, w, target, extra = {}) {
  return { liftId, status: 'done', held: false, target, prescribed: target.length, work: done(w, reps), ramp: [], drop: [], ...extra };
}
function mkSession(id, date, lifts, extra = {}) {
  return { id, date, finishedAt: Date.parse(date + 'T12:00:00Z'), dayId: 'chest', tags: [], note: '', bw: null,
    effort: { clean: true, nearFailure: true, attempted: true }, lifts, ...extra };
}
/** ~4 months of plausible sessions for fly, curl, mid with targets taken from replay. */
function mkSeasonState() {
  const st = mkState();
  delete st.routine.lifts.row;
  const ids = ['fly', 'curl', 'mid'];
  for (let i = 0; i < 14; i++) {
    const date = L.addDays('2026-10-05', i * 9);
    const A = L.analyze(st, date);
    const lifts = ids.map((id) => {
      const tgt = A.perLift[id].target.sets;
      const miss = i % 5 === 3;
      const reps = tgt.map((t, k) => (miss && k === 0 ? t.r - 2 : t.r));
      return { liftId: id, status: 'done', held: false, target: tgt, prescribed: tgt.length,
        work: tgt.map((t, k) => ({ w: t.w, r: reps[k], done: true })), ramp: [], drop: [] };
    });
    st.sessions.push(mkSession(`m${i}`, date, lifts, {
      effort: { clean: true, nearFailure: i % 4 !== 0, attempted: true },
    }));
  }
  return st;
}

// ---------------------------------------------------------------- run + report
export function report() {
  return { total: results.length, passed: results.filter((r) => r.ok).length, results };
}

const isNode = typeof process !== 'undefined' && process.versions && process.versions.node && typeof window === 'undefined';
if (isNode) {
  const r = report();
  for (const t of r.results) console.log(`${t.ok ? '✓' : '✗'} ${t.name}${t.ok ? '' : `\n    ${t.err}`}`);
  console.log(`\n${r.passed}/${r.total} passed`);
  if (r.passed !== r.total) process.exitCode = 1;
}
