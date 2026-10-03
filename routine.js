// routine.js — default routine shipped with the app: lifts, sets, rep ranges, increments.
// No personal numbers: weights are entered on first launch (setup) and stay on the device.
import { equipmentDefaults } from './logic.js';

const SPEC = [
  { id: 'chest', name: 'Chest', lifts: [
    ['underhand-cable-fly', 'Underhand cable fly', 'cable', 3, 10, { perSide: true }],
    ['overhead-cable-fly', 'Overhead cable fly', 'cable', 2, 10, { perSide: true, ramp: [10] }],
    ['mid-cable-fly', 'Mid cable fly', 'cable', 2, 10, { perSide: true, ramp: [10] }],
    ['cable-tricep-ext', 'Cable tricep extension', 'cable', 1, 10, { ramp: [10, 10, 10] }],
    ['incline-db-curl', 'Incline DB curl', 'dumbbell', 3, 10, {}],
    ['single-arm-cable-tricep-ext', 'Single-arm cable tricep extension', 'cable', 4, 10, {}],
    ['seated-chest-fly', 'Seated chest fly', 'machine', 3, 10, {}],
  ] },
  { id: 'back', name: 'Back', lifts: [
    ['cable-lat-pullover', 'Cable lat pullover', 'cable', 3, 10, {}],
    ['overhead-lat-pulldown', 'Overhead lat pulldown', 'plate', 2, 10, { ramp: [10, 10] }],
    ['seated-row', 'Seated row', 'plate', 3, 10, { ramp: [10] }],
    ['seated-cable-row', 'Seated cable row', 'cable', 3, 10, {}],
    ['back-extension', 'Back extension', 'machine', 3, 10, {}],
  ] },
  { id: 'shoulders', name: 'Shoulders', lifts: [
    ['cable-lateral-raise', 'Cable lateral raise', 'cable', 2, 10, { ramp: [10, 10] }],
    ['one-arm-cable-reverse-delt', 'One-arm cable reverse delt pull', 'cable', 2, 10, { ramp: [10, 10] }],
    ['front-delt-pull', 'Front delt pull', 'cable', 4, 10, {}],
    ['db-lateral-raise', 'DB lateral raise', 'dumbbell', 2, 10, { ramp: [10], drop: 1 }],
    ['seated-rear-delt-fly', 'Seated rear delt fly', 'machine', 4, 10, {}],
    ['ab-crunch', 'Ab crunch', 'machine', 3, 15, { repMin: 15, repMax: 20 }],
  ] },
  { id: 'legs', name: 'Legs', lifts: [
    ['leg-press', 'Leg press', 'plate', 2, 10, { ramp: [10, 10] }],
    ['db-deadlift', 'DB deadlift', 'dumbbell', 4, 10, {}],
    ['db-lunge', 'DB lunge', 'dumbbell', 3, 10, {}],
    ['db-rdl', 'DB RDL', 'dumbbell', 4, 10, {}],
    ['hip-extension', 'Hip extension', 'machine', 4, 10, {}],
    ['leg-extension', 'Leg extension', 'machine', 3, 10, {}],
    ['leg-curl', 'Leg curl', 'machine', 3, 10, {}],
    ['calf-raise', 'Calf raise', 'plate', 3, 10, {
      repMin: 10, repMax: 15, base: 5, showBase: true,
      note: 'Log plates added (0 if none). Base = the machine\'s own resistance; a stand-in is fine.',
    }],
  ] },
];

export function makeLift(id, name, equipment, sets, reps, opts = {}) {
  const d = equipmentDefaults(equipment);
  return {
    id, name, equipment, sets, reps,
    repMin: opts.repMin ?? d.repMin,
    repMax: opts.repMax ?? d.repMax,
    increment: opts.increment ?? d.increment,
    perSide: !!opts.perSide,
    base: opts.base ?? 0,
    showBase: !!opts.showBase,
    bodyweight: equipment === 'bodyweight',
    ramp: (opts.ramp || []).map((r) => ({ w: null, r })),
    drop: opts.drop ? [{ w: null, r: 10 }] : [],
    note: opts.note || '',
    seed: null,
    hold: null,
    archived: false,
  };
}

export function defaultRoutine() {
  const lifts = {};
  const days = SPEC.map((d) => {
    d.lifts.forEach(([id, name, eq, sets, reps, opts]) => { lifts[id] = makeLift(id, name, eq, sets, reps, opts); });
    return { id: d.id, name: d.name, liftIds: d.lifts.map((l) => l[0]) };
  });
  return { days, lifts };
}
