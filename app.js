// app.js — UI for the CBE tracker. Plain JS, no framework, no network.
// All data lives in IndexedDB on this device (see store.js). Rules live in logic.js.
import * as L from './logic.js';
import { defaultRoutine, makeLift } from './routine.js';
import * as store from './store.js';

// ================================================================ utils
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const uid = () => (self.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
const ok = (x) => x !== null && x !== undefined && Number.isFinite(x);
const f1 = (x) => (ok(x) ? x.toFixed(1) : '–');
const f0 = (x) => (ok(x) ? String(Math.round(x)) : '–');
const pct = (x, d = 1) => (ok(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}%` : '–');
const eff = (e) => (ok(e) ? String(Math.round(e * 100)) : '–');
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const deep = (o) => JSON.parse(JSON.stringify(o));
const fw = L.fmtW;
const fs = L.fmtSets;
const wKey = (w) => String(L.rw(Number(w)));
const maxW = (sets) => (sets && sets.length ? Math.max(...sets.map((s) => Number(s.w))) : 0);
function dLabel(d, long = false) {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, long ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
}
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isStandalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ================================================================ state
const db = { settings: null, routine: null, sessions: [], events: [], meta: null, draft: null };
let A = null; // analysis of everything saved (logic.analyze)
const ui = {
  tab: 'today',
  hist: { mode: 'lifts', liftId: null },
  trendsMonth: null,
  set: { page: null },
  form: null,
  setup: null,
  fin: null,
  sheet: null,
  nextFocus: null,
};

const lift = (id) => db.routine.lifts[id];
const dayById = (id) => db.routine.days.find((d) => d.id === id);
const rotation = () => db.routine.days.map((d) => d.id);
const bwNow = () => (ok(num(db.settings.bodyweight)) ? num(db.settings.bodyweight) : null);
const seasonIdx = () => (A && A.currentSeason >= 0 ? A.currentSeason : 0);
const focusNow = () => L.focusFor(db.meta, seasonIdx());
const sortSessions = () => db.sessions.sort((a, b) => L.byTime({ date: a.date, ts: a.finishedAt }, { date: b.date, ts: b.finishedAt }));
const lastSession = () => (db.sessions.length ? db.sessions[db.sessions.length - 1] : null);
function lastEntry(liftId) {
  for (let i = db.sessions.length - 1; i >= 0; i--) {
    const e = db.sessions[i].lifts.find((x) => x.liftId === liftId && x.status === 'done');
    if (e) return e;
  }
  return null;
}
function activeLiftIds() {
  const seen = new Set();
  db.routine.days.forEach((d) => d.liftIds.forEach((id) => { if (lift(id) && !lift(id).archived) seen.add(id); }));
  return [...seen];
}
function orderedLiftIds(ids) {
  const focus = focusNow();
  const order = activeLiftIds();
  const rank = (id) => (focus.includes(id) ? focus.indexOf(id) : 100 + (order.indexOf(id) >= 0 ? order.indexOf(id) : 999));
  return ids.slice().sort((a, b) => rank(a) - rank(b));
}
const liftName = (id) => (lift(id) ? lift(id).name : id);
const starName = (id) => `${focusNow().includes(id) ? '<span class="star" aria-label="Focus lift">★</span>' : ''}${esc(liftName(id))}`;

// ================================================================ persistence
async function saveKV(key) {
  try { await store.kvSet(key, db[key] === undefined ? null : db[key]); }
  catch (err) { toast(`Couldn't save: ${err.message || err}`); }
}
let draftTimer = null;
function saveDraftSoon() { clearTimeout(draftTimer); draftTimer = setTimeout(() => saveKV('draft'), 300); }
function saveDraftNow() { clearTimeout(draftTimer); return saveKV('draft'); }
let setupTimer = null;
function saveSetupSoon() { clearTimeout(setupTimer); setupTimer = setTimeout(() => { db.meta.setupDraft = ui.setup; saveKV('meta'); }, 400); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && db.draft) saveDraftNow(); });

function recompute() {
  A = L.analyze({ settings: db.settings, routine: db.routine, sessions: db.sessions, events: db.events, meta: db.meta }, todayStr());
  if (JSON.stringify(A.seasons) !== JSON.stringify(db.meta.seasons || [])) { db.meta.seasons = A.seasons; saveKV('meta'); }
}

// ================================================================ toast + sheet + confirm
let toastTimer = null;
function toast(msg, opts = {}) {
  const el = $('#toast');
  el.className = `toast${opts.gold ? ' gold' : ''}`;
  el.innerHTML = `<span class="grow">${esc(msg)}</span>${opts.action ? `<button class="btn sm" id="toast-act">${esc(opts.action)}</button>` : ''}`;
  el.hidden = false;
  if (opts.action) $('#toast-act').onclick = () => { el.hidden = true; opts.fn(); };
  clearTimeout(toastTimer);
  if (!opts.sticky) toastTimer = setTimeout(() => { el.hidden = true; }, opts.ms || 2600);
}
function openSheet(html, name = 'sheet') {
  const el = $('#sheet');
  ui.sheet = name;
  el.innerHTML = `<div class="sheet-inner">${html}</div>`;
  el.hidden = false;
  el.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  bindCharts(el);
}
function closeSheet() {
  const el = $('#sheet');
  el.hidden = true;
  el.innerHTML = '';
  ui.sheet = null;
  document.body.style.overflow = '';
}
let confirmResolve = null;
function confirmSheet(title, body, yes = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    const el = $('#confirm');
    el.innerHTML = `<div class="sheet-inner"><h2>${esc(title)}</h2><p class="hint">${esc(body)}</p>
      <div class="btn-row"><button class="btn" data-act="confirm-no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-act="confirm-yes">${esc(yes)}</button></div></div>`;
    el.hidden = false;
  });
}
function settleConfirm(v) { $('#confirm').hidden = true; if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(v); } }

// ================================================================ render root
function render() {
  const main = $('#main');
  if (!db.meta.setupDone) {
    main.className = 'wrap no-tabs';
    $('#nav').hidden = true;
    main.innerHTML = setupView();
    return;
  }
  main.className = 'wrap';
  $('#nav').hidden = false;
  renderNav();
  let html = '';
  if (ui.tab === 'today') html = todayView();
  else if (ui.tab === 'history') html = historyView();
  else if (ui.tab === 'trends') html = trendsView();
  else if (ui.tab === 'review') html = reviewView();
  else html = settingsView();
  main.innerHTML = html;
  bindCharts(main);
}
const ICONS = {
  today: '<path d="M6.5 7v10M3.5 9.5v5M17.5 7v10M20.5 9.5v5M6.5 12h11"/>',
  history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  trends: '<path d="M4 19.5h16"/><path d="M5 15.5l4-4.5 4 3 6-7"/>',
  review: '<rect x="5.5" y="4.5" width="13" height="16" rx="2"/><path d="M9 4.5h6v3H9z"/><path d="M9 13.5l2 2 4-4.5"/>',
  settings: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
};
function renderNav() {
  const due = L.reviewDue(db.meta, A.firstDate, todayStr(), A.settings.reviewDays);
  const tabs = [['today', 'Today'], ['history', 'History'], ['trends', 'Trends'], ['review', 'Review'], ['settings', 'Settings']];
  $('#nav').innerHTML = `<div class="tabs">${tabs.map(([k, label]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}" aria-current="${ui.tab === k ? 'page' : 'false'}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>${label}${k === 'review' && due ? '<span class="dot" aria-label="due"></span>' : ''}</button>`).join('')}</div>`;
}

// ================================================================ SETUP (first run)
function initSetup() {
  if (ui.setup) return;
  if (db.meta.setupDraft) { ui.setup = db.meta.setupDraft; return; }
  const v = {};
  Object.values(db.routine.lifts).forEach((lf) => {
    v[lf.id] = { sets: lf.sets, reps: lf.reps, w: '', ramp: lf.ramp.map(() => ''), drop: '', base: lf.base || 0 };
  });
  ui.setup = { step: 0, v, bw: '', focus: [] };
}
function setupView() {
  initSetup();
  const s = ui.setup;
  if (s.step === 0) {
    const iosWarn = isIOS() && !isStandalone()
      ? `<div class="banner warn"><span class="ico">⚠</span><div class="grow"><b>Install first.</b> Tap Share → <b>Add to Home Screen</b>, then open CBE from your home screen and set up there. Safari and the home-screen app keep separate data.</div></div>` : '';
    return `<h1>Career Best Effort</h1>
      <p class="hint">Pat Riley's CBE program, for lifting. One small step past your best every session. An average at least 1% higher every 8-week season. A clear flag whenever you fall behind your own number.</p>
      ${iosWarn}
      <div class="card"><ol class="steps-list">
        <li>Enter the working weights you use now. Those sets become your starting number.</li>
        <li>Pick up to 5 focus lifts for the season.</li>
        <li>Train. Each lift shows today's target, your number, and your career high.</li>
      </ol></div>
      <p class="hint small">Everything stays on this phone. Nothing is uploaded anywhere.</p>
      <button class="btn primary big" data-act="setup-step" data-step="1">Set up</button>
      <div class="btn-row"><button class="btn ghost" data-act="import">Restore from a backup</button></div>`;
  }
  if (s.step === 1) {
    const days = db.routine.days.map((d) => `<h2>${esc(d.name)}</h2>${d.liftIds.map((id) => setupLift(id)).join('')}`).join('');
    return `<div class="title-row"><h1>Your numbers</h1><button class="link" data-act="setup-step" data-step="0">Back</button></div>
      <p class="hint">Enter the working weight you use now for each lift, in lb. Ramp and drop weights are optional; they'll fill in from last time after your first session.</p>
      ${days}
      <div class="btn-row"><button class="btn primary big" data-act="setup-step" data-step="2">Next</button></div>`;
  }
  const chips = db.routine.days.map((d) => `<h3>${esc(d.name)}</h3><div class="chips">${d.liftIds.map((id) => `<button class="chip ${s.focus.includes(id) ? 'on' : ''}" data-act="setup-focus" data-id="${id}">${s.focus.includes(id) ? '★ ' : ''}${esc(liftName(id))}</button>`).join('')}</div>`).join('');
  return `<div class="title-row"><h1>Almost there</h1><button class="link" data-act="setup-step" data-step="1">Back</button></div>
    <div class="card"><div class="field"><label for="su-bw">Bodyweight (lb) <span class="muted">optional</span></label>
      <input id="su-bw" class="input" inputmode="decimal" data-su-bw value="${esc(s.bw)}" placeholder="e.g. 195"></div>
      <p class="hint small">Only used to score bodyweight lifts (none in the default routine). Stays on this device; editable in Settings.</p></div>
    <h2>Focus lifts <span class="muted">${s.focus.length}/5</span></h2>
    <p class="hint">Riley's pitch was 1% in five areas. Focus lifts show first in reports, with their own season pace and CBE badges. You can skip this.</p>
    ${chips}
    <div class="btn-row" style="margin-top:22px"><button class="btn primary big" data-act="setup-finish">Start Season 1</button></div>`;
}
function setupLift(id) {
  const lf = lift(id);
  const v = ui.setup.v[id];
  const unit = lf.perSide ? 'lb/side' : 'lb';
  const ramp = lf.ramp.map((r, i) => `<div class="su-row"><span class="su-k">Ramp ${i + 1}</span>
      <input class="input small w" inputmode="decimal" data-su="${id}" data-f="ramp" data-i="${i}" value="${esc(v.ramp[i] ?? '')}" placeholder="lb" aria-label="Ramp ${i + 1} weight"> × ${r.r} <span class="muted small">optional</span></div>`).join('');
  const drop = lf.drop.length ? `<div class="su-row"><span class="su-k">Drop set</span>
      <input class="input small w" inputmode="decimal" data-su="${id}" data-f="drop" value="${esc(v.drop)}" placeholder="lb" aria-label="Drop set weight"> <span class="muted small">optional</span></div>` : '';
  const base = lf.showBase ? `<div class="su-row"><span class="su-k">Base</span>
      <input class="input small w" inputmode="decimal" data-su="${id}" data-f="base" value="${esc(v.base)}" aria-label="Base load"> lb <span class="muted small">machine's own resistance</span></div>` : '';
  return `<div class="card setup-lift" id="su-${id}">
    <div class="lift-title">${esc(lf.name)} <span class="muted small">${L.EQUIPMENT_LABEL[lf.equipment]}</span></div>
    <div class="su-row"><span class="su-k">Working</span>
      <input class="input small" inputmode="numeric" data-su="${id}" data-f="sets" value="${esc(v.sets)}" aria-label="Working sets"> ×
      <input class="input small" inputmode="numeric" data-su="${id}" data-f="reps" value="${esc(v.reps)}" aria-label="Reps"> @
      <input class="input small w" inputmode="decimal" data-su="${id}" data-f="w" value="${esc(v.w)}" placeholder="${lf.showBase ? '0' : 'lb'}" aria-label="Working weight"> ${unit}</div>
    ${ramp}${drop}${base}
    ${lf.note ? `<p class="hint small">${esc(lf.note)}</p>` : ''}
    <div class="err-msg" hidden></div></div>`;
}
function validateSetup() {
  const errs = [];
  for (const d of db.routine.days) {
    for (const id of d.liftIds) {
      const lf = lift(id), v = ui.setup.v[id];
      const w = num(v.w), sets = num(v.sets), reps = num(v.reps), base = num(v.base) || 0;
      let msg = '';
      if (!(sets >= 1 && Number.isInteger(sets))) msg = 'Sets must be a whole number of 1 or more.';
      else if (!(reps >= 1 && Number.isInteger(reps))) msg = 'Reps must be a whole number of 1 or more.';
      else if (w === null || w < 0) msg = lf.showBase ? 'Enter plates added (0 if none).' : 'Enter your working weight.';
      else if (!lf.bodyweight && w + base <= 0) msg = 'Weight plus base must be more than 0. Enter a base (a stand-in is fine).';
      errs.push({ id, msg });
    }
  }
  return errs.filter((e) => e.msg);
}
function showSetupErrors(errs) {
  document.querySelectorAll('.setup-lift .err-msg').forEach((el) => { el.hidden = true; });
  errs.forEach((e) => { const el = $(`#su-${CSS.escape(e.id)} .err-msg`); if (el) { el.textContent = e.msg; el.hidden = false; } });
  if (errs.length) { const first = $(`#su-${CSS.escape(errs[0].id)}`); if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' }); toast(`${plural(errs.length, 'lift')} still need${errs.length === 1 ? 's' : ''} a number`); }
}
async function finishSetup() {
  const s = ui.setup;
  const bw = num(s.bw);
  const today = todayStr();
  for (const lf of Object.values(db.routine.lifts)) {
    const v = s.v[lf.id];
    const sets = num(v.sets), reps = num(v.reps), w = num(v.w);
    lf.sets = sets;
    lf.reps = reps;
    lf.base = lf.showBase ? (num(v.base) || 0) : lf.base;
    lf.ramp = lf.ramp.map((r, i) => ({ w: num(v.ramp[i]), r: r.r }));
    lf.drop = lf.drop.map((d) => ({ w: num(v.drop), r: d.r ?? 10 }));
    lf.seed = { sets: Array.from({ length: sets }, () => ({ w, r: reps })), bw, date: today };
  }
  db.settings.bodyweight = bw;
  db.meta.focus = { 0: s.focus.slice(0, 5) };
  db.meta.setupDone = true;
  db.meta.setupDraft = null;
  db.meta.setupAt = today;
  await Promise.all([saveKV('routine'), saveKV('settings'), saveKV('meta')]);
  db.meta.persist = await store.requestPersist();
  saveKV('meta');
  ui.setup = null;
  recompute();
  ui.tab = 'today';
  render();
  window.scrollTo(0, 0);
  toast('Setup saved. Your first targets are ready.');
}

// ================================================================ TODAY
function newDraft(dayId) {
  const d = { id: uid(), dayId, date: todayStr(), startedAt: Date.now(), lifts: {} };
  const day = dayById(dayId);
  (day ? day.liftIds : []).forEach((id) => { const dl = draftLift(id); if (dl) d.lifts[id] = dl; });
  return d;
}
function draftLift(id) {
  const lf = lift(id);
  const P = A.perLift[id];
  if (!lf || lf.archived || !lf.seed || !P) return null;
  const prev = lastEntry(id);
  const pick = (defaults, prevSets) => defaults.map((s, i) => {
    const p = prevSets && prevSets[i];
    return { w: p && p.w !== null && p.w !== undefined && p.w !== '' ? p.w : s.w, r: p && p.r ? p.r : s.r, done: false };
  });
  return {
    target: deep(P.target.sets), kind: P.target.kind, held: !!lf.hold, skipped: false,
    prescribed: lf.sets,
    ramp: pick(lf.ramp, prev && prev.ramp),
    work: P.target.sets.map((s) => ({ w: s.w, r: s.r, done: false })),
    drop: pick(lf.drop, prev && prev.drop),
  };
}
const workDone = (dl) => dl.work.some((s) => s.done);
const draftHasDone = () => !!db.draft && Object.values(db.draft.lifts).some((dl) => dl.work.some((s) => s.done) || dl.ramp.some((s) => s.done));
function ensureDraft() {
  if (db.draft && db.draft.date !== todayStr() && !draftHasDone()) db.draft = null;
  if (!db.draft || !dayById(db.draft.dayId)) {
    const last = lastSession();
    db.draft = newDraft(L.nextDayId(rotation(), last ? last.dayId : null));
    saveDraftNow();
  }
  syncDraft();
  return db.draft;
}
/** Keep the draft in step with the routine and with targets that changed (hold, step back, edits). */
function syncDraft() {
  const d = db.draft;
  const day = dayById(d.dayId);
  let changed = false;
  day.liftIds.forEach((id) => {
    const lf = lift(id);
    if (!lf || lf.archived) return;
    if (!d.lifts[id]) { const dl = draftLift(id); if (dl) { d.lifts[id] = dl; changed = true; } return; }
    const dl = d.lifts[id];
    const P = A.perLift[id];
    if (P && !workDone(dl) && JSON.stringify(P.target.sets) !== JSON.stringify(dl.target)) {
      dl.target = deep(P.target.sets); dl.kind = P.target.kind; dl.prescribed = lf.sets;
      dl.work = dl.target.map((s) => ({ w: s.w, r: s.r, done: false }));
      changed = true;
    }
    if (dl.held !== !!lf.hold && !workDone(dl)) { dl.held = !!lf.hold; changed = true; }
  });
  if (changed) saveDraftSoon();
}
function seasonChip() {
  if (A.currentSeason < 0) return '<span class="season-chip">Season 1 starts with your first session</span>';
  const s = A.seasons[A.currentSeason];
  return `<span class="season-chip">Season ${A.currentSeason + 1} · ${plural(L.daysBetween(todayStr(), L.seasonEnd(s)), 'day')} left</span>`;
}
function todayView() {
  const d = ensureDraft();
  const day = dayById(d.dayId);
  const chips = db.routine.days.map((x) => `<button class="chip ${x.id === d.dayId ? 'on' : ''}" data-act="switch-day" data-id="${x.id}">${esc(x.name)}</button>`).join('');
  const banners = [];
  const unseen = unseenSeasonEnd();
  if (unseen >= 0) banners.push(`<div class="banner accent"><span class="ico">🏁</span><div class="grow">Season ${unseen + 1} is over. See your CBE results.</div><button class="btn sm" data-act="open-season-end" data-i="${unseen}">Open</button></div>`);
  if (L.reviewDue(db.meta, A.firstDate, todayStr(), A.settings.reviewDays)) banners.push(`<div class="banner accent"><span class="ico">📋</span><div class="grow">Your two-week review is ready.</div><button class="btn sm" data-act="tab" data-tab="review">Open</button></div>`);
  if (A.slip.slipping) banners.push(`<div class="banner warn"><span class="ico">⚠</span><div class="grow"><b>Effort slipping.</b> Last 3 sessions average ${f0(A.slip.recent)}, against your norm of ${f0(A.slip.norm)}.</div></div>`);
  if (d.date !== todayStr()) banners.push(`<div class="banner"><span class="ico">🕓</span><div class="grow">This session started ${dLabel(d.date)}. It will be saved on that date.</div><button class="btn sm" data-act="discard-draft">Discard</button></div>`);
  const ids = day.liftIds.filter((id) => d.lifts[id]);
  const cards = ids.map((id) => liftCard(id)).join('') || `<div class="card"><p class="hint">No lifts on this day yet. Add some in Settings → Days &amp; lifts.</p></div>`;
  return `<header class="top">
      <div class="top-row"><div class="eyebrow">Next up</div>${seasonChip()}</div>
      <div class="day-chips" role="tablist" aria-label="Training day">${chips}</div>
    </header>
    ${banners.join('')}
    <div class="cards">${cards}</div>
    <div class="finish-bar"><div><button class="btn primary big" data-act="finish">Finish ${esc(day.name)}</button></div></div>`;
}
function hitSet(s, t, off) {
  if (!t || !s.done) return null;
  const w = num(s.w), r = num(s.r);
  if (w === null || !(r > 0)) return false;
  return w >= t.w - 1e-9 && L.epley(w + off, r) >= L.epley(t.w + off, t.r) - 1e-9;
}
function setRow(id, kind, i, s, t, flag, label, off) {
  let cls = `set ${kind}`;
  if (s.done) cls += ' done';
  const h = kind === 'work' ? hitSet(s, t, off) : null;
  if (h === true) cls += ' hit';
  if (h === false) cls += ' short';
  if (flag) cls += ' ch';
  const name = kind === 'work' ? `Set ${i + 1}` : kind === 'ramp' ? `Ramp ${i + 1}` : 'Drop set';
  return `<div class="${cls}" data-lift="${id}" data-kind="${kind}" data-i="${i}">
    <div class="stp"><button class="sb" data-act="step" data-f="w" data-d="-1" aria-label="${name}: less weight">−</button><input class="num" inputmode="decimal" autocomplete="off" data-f="w" value="${esc(s.w ?? '')}" aria-label="${name} weight"><button class="sb" data-act="step" data-f="w" data-d="1" aria-label="${name}: more weight">+</button></div>
    <span class="x">×</span>
    <div class="stp"><button class="sb" data-act="step" data-f="r" data-d="-1" aria-label="${name}: fewer reps">−</button><input class="num" inputmode="numeric" autocomplete="off" data-f="r" value="${esc(s.r ?? '')}" aria-label="${name} reps"><button class="sb" data-act="step" data-f="r" data-d="1" aria-label="${name}: more reps">+</button></div>
    <button class="done-btn" data-act="toggle-done" aria-pressed="${!!s.done}" aria-label="${name} ${s.done ? 'done' : 'not done'}">${s.done ? (flag ? '🏆' : '✓') : esc(label)}</button>
  </div>`;
}
function liftCard(id) {
  const lf = lift(id), dl = db.draft.lifts[id], P = A.perLift[id];
  if (!lf || !dl || !P) return '';
  const star = focusNow().includes(id) ? '<span class="star" aria-label="Focus lift">★</span>' : '';
  if (dl.skipped) {
    return `<section class="card skipped" id="card-${id}"><div class="lift-h"><div><div class="lift-title">${star}${esc(lf.name)}</div>
      <div class="lift-meta">Skipped today: no score, no miss.</div></div><button class="btn sm" data-act="skip" data-id="${id}">Undo</button></div></section>`;
  }
  const off = L.offsetFor(lf, bwNow());
  const badges = [];
  if (P.behind) badges.push('<span class="badge bad">▼ Behind</span>');
  if (dl.held) badges.push('<span class="badge accent">⏸ Held</span>');
  if (P.suggestion) badges.push('<span class="badge warn">⚠ Step back?</span>');
  const W = maxW(P.baseline);
  const reps = P.ch.repsAt[wKey(W)];
  const chText = Number.isFinite(P.ch.heaviest) ? `${fw(P.ch.heaviest)} lb` : '–';
  const chSub = reps ? `${reps} reps @ ${fw(W)}` : '';
  const kindTag = dl.held ? ' <span class="badge accent">held</span>'
    : dl.kind === 'stepback' ? ' <span class="badge warn">↓ stepped back</span>'
    : dl.kind === 'moveup' || dl.kind === 'catchup' ? ' <span class="badge accent">↑ weight</span>' : '';
  const meta = [L.EQUIPMENT_LABEL[lf.equipment], lf.repMin === lf.repMax ? `${lf.repMin} reps` : `${lf.repMin}–${lf.repMax} reps`,
    `+${fw(lf.increment)} lb`, lf.perSide ? 'per side' : '', lf.bodyweight ? 'bodyweight + added' : '',
    !lf.bodyweight && lf.base ? `base ${fw(lf.base)} lb` : ''].filter(Boolean).join(' · ');
  const flags = L.chSession(P.ch, dl.work.map((s) => ({ ...s, w: num(s.w), r: num(s.r) }))).flags;
  const rows = [];
  if (dl.ramp.length) rows.push('<div class="set-group-label">Ramp</div>', ...dl.ramp.map((s, i) => setRow(id, 'ramp', i, s, null, null, `R${i + 1}`, off)));
  if (dl.ramp.length || dl.drop.length) rows.push('<div class="set-group-label">Working</div>');
  rows.push(...dl.work.map((s, i) => setRow(id, 'work', i, s, dl.target[i], flags[i], String(i + 1), off)));
  if (dl.drop.length) rows.push('<div class="set-group-label">Drop · logged, not scored</div>', ...dl.drop.map((s, i) => setRow(id, 'drop', i, s, null, null, 'D', off)));
  const extra = dl.work.length > dl.prescribed ? `<button class="btn" data-act="remove-set" data-id="${id}">− Set</button>` : '';
  return `<section class="card lift" id="card-${id}">
    <div class="lift-h"><div><div class="lift-title">${star}${esc(lf.name)}</div><div class="lift-meta">${esc(meta)}</div></div><div class="badges">${badges.join('')}</div></div>
    <div class="lift-stats">
      <div class="kv"><span class="k">Number</span><span class="v">${f1(P.number)}</span></div>
      <div class="kv"><span class="k">Career high</span><span class="v">${esc(chText)}</span>${chSub ? `<span class="k">${esc(chSub)}</span>` : ''}</div>
      <div class="kv wide"><span class="k">Today's target</span><span class="v target">${esc(fs(dl.target))}${kindTag}</span></div>
    </div>
    ${suggestHTML(id)}
    <div class="sets">${rows.join('')}</div>
    <div class="lift-foot">
      <button class="btn" data-act="add-set" data-id="${id}">+ Set</button>${extra}
      <button class="btn ${dl.held ? 'on' : ''}" data-act="hold" data-id="${id}" aria-pressed="${dl.held}">Hold</button>
      <button class="btn" data-act="skip" data-id="${id}">Skip</button>
      <span class="live" id="live-${id}">${liveHTML(id)}</span>
    </div></section>`;
}
function liveHTML(id) {
  const lf = lift(id), dl = db.draft.lifts[id], P = A.perLift[id];
  const off = L.offsetFor(lf, bwNow());
  const work = dl.work.map((s) => ({ w: num(s.w), r: num(s.r), done: !!s.done }));
  const n = work.filter(L.isDone).length;
  if (!n) return `${plural(dl.prescribed, 'working set')}`;
  if (n < dl.prescribed) return `${n}/${dl.prescribed} sets done`;
  const sc = L.liftScore(work, dl.prescribed, off);
  const hit = L.evaluateTarget(dl.target, work, off).hit;
  const vs = P.number > 0 ? (sc / P.number - 1) * 100 : null;
  return `${hit ? '<span class="up">✓ target</span>' : '<span class="down">✗ target</span>'} · Score <b>${f1(sc)}</b> (${pct(vs)})`;
}
function suggestHTML(id) {
  const P = A.perLift[id];
  const s = P.suggestion;
  if (!s) return '';
  const next = L.computeTarget(s.sets, lift(id), A.settings).sets;
  const how = s.kind === 'lighter' ? 'about 10% lighter' : s.kind === 'set-down' ? 'heaviest set down one weight' : 'about 10% fewer reps';
  const ctx = s.misses.map((m) => `${dLabel(m.date)}: ${m.tags.length ? m.tags.map((t) => L.TAG_LABEL[t]).join(', ') : 'no tags'}`);
  return `<div class="suggest"><b>3 missed targets in a row.</b> Step back (${how})? Next target would be <b>${esc(fs(next))}</b>.
    <div class="chips">${ctx.map((t) => `<span class="chip static">${esc(t)}</span>`).join('')}</div>
    <div class="btn-row"><button class="btn sm primary" data-act="sb-accept" data-id="${id}">Step back</button><button class="btn sm" data-act="sb-dismiss" data-id="${id}">Dismiss</button></div></div>`;
}
function rerenderCard(id) {
  const el = document.getElementById(`card-${id}`);
  if (el) el.outerHTML = liftCard(id);
}
function patchCard(id) {
  const card = document.getElementById(`card-${id}`);
  if (!card || !db.draft.lifts[id] || db.draft.lifts[id].skipped) return;
  const lf = lift(id), dl = db.draft.lifts[id];
  const off = L.offsetFor(lf, bwNow());
  card.querySelectorAll('.set.work').forEach((row) => {
    const i = +row.dataset.i;
    const h = hitSet(dl.work[i], dl.target[i], off);
    row.classList.toggle('hit', h === true);
    row.classList.toggle('short', h === false);
  });
  const live = document.getElementById(`live-${id}`);
  if (live) live.innerHTML = liveHTML(id);
}
function rowCtx(el) {
  const row = el.closest('.set');
  const { lift: id, kind } = row.dataset;
  const i = +row.dataset.i;
  return { row, id, kind, i, dl: db.draft.lifts[id], s: db.draft.lifts[id][kind][i] };
}
function syncRow(row, s) {
  row.querySelectorAll('input.num').forEach((inp) => {
    const v = num(inp.value);
    if (inp.dataset.f === 'w') s.w = v; else s.r = v === null ? null : Math.round(v);
  });
}

// ================================================================ FINISH + SAVE
function everyTargetHit() {
  const d = db.draft;
  const ids = dayById(d.dayId).liftIds.filter((id) => d.lifts[id]);
  return ids.length > 0 && ids.every((id) => {
    const dl = d.lifts[id];
    if (dl.skipped) return false;
    const off = L.offsetFor(lift(id), bwNow());
    return L.evaluateTarget(dl.target, dl.work.map((s) => ({ w: num(s.w), r: num(s.r), done: !!s.done })), off).hit;
  });
}
function finishHTML() {
  const f = ui.fin;
  const d = db.draft;
  const ids = dayById(d.dayId).liftIds.filter((id) => d.lifts[id]);
  const willSkip = ids.filter((id) => d.lifts[id].skipped || !workDone(d.lifts[id]));
  const partial = ids.filter((id) => !d.lifts[id].skipped && workDone(d.lifts[id]) && d.lifts[id].work.filter((s) => s.done).length < d.lifts[id].prescribed);
  const check = (k, text, sub = '') => `<button class="check ${f[k] ? 'on' : ''}" data-act="fin-check" data-k="${k}" aria-pressed="${!!f[k]}">
      <span class="box">✓</span><span>${text}${sub ? `<span class="hint small" style="display:block">${sub}</span>` : ''}</span><span class="yn">${f[k] ? 'Yes' : 'No'}</span></button>`;
  return `<div class="sheet-h"><h2>Finish session</h2><button class="btn sm ghost" data-act="close-sheet">Cancel</button></div>
    ${willSkip.length ? `<div class="banner"><span class="ico">ℹ</span><div class="grow">No sets logged for ${willSkip.map((id) => esc(liftName(id))).join(', ')}. They'll be saved as skipped: no score, no miss.</div></div>` : ''}
    ${partial.length ? `<div class="banner warn"><span class="ico">⚠</span><div class="grow">Missing sets on ${partial.map((id) => esc(liftName(id))).join(', ')} count as 0 in the lift score.</div></div>` : ''}
    <h3>Effort: the part the box score can't see</h3>
    ${check('clean', 'Clean reps, full range of motion on every working set')}
    ${check('nearFailure', 'Last working set of each lift within 2 reps of failure')}
    ${check('attempted', 'Attempted every target, including the ones I missed', f.prefilled ? 'Pre-checked: you hit every target.' : '')}
    <h3>Context <span class="muted">optional · never changes a number</span></h3>
    <div class="chips">${L.TAGS.map((t) => `<button class="chip ${f.tags.includes(t) ? 'on' : ''}" data-act="fin-tag" data-t="${t}" aria-pressed="${f.tags.includes(t)}">${esc(L.TAG_LABEL[t])}</button>`).join('')}</div>
    <div class="field"><textarea class="input" data-fin-note placeholder="Note (optional)" aria-label="Note">${esc(f.note)}</textarea></div>
    <button class="btn primary big" data-act="save-session">Save session</button>`;
}
async function saveSession() {
  const d = db.draft;
  const f = ui.fin;
  const day = dayById(d.dayId);
  const clean = (arr) => arr.map((s) => ({ w: num(s.w), r: num(s.r), done: !!s.done && num(s.r) > 0 && num(s.w) !== null }));
  const lifts = [];
  for (const [id, dl] of Object.entries(d.lifts)) {
    if (!day.liftIds.includes(id) && !workDone(dl)) continue;
    const work = clean(dl.work);
    const status = dl.skipped || !work.some((s) => s.done) ? 'skipped' : 'done';
    lifts.push({
      liftId: id, name: liftName(id), status, held: !!dl.held, target: deep(dl.target), prescribed: dl.prescribed,
      work: status === 'done' ? work : [], ramp: clean(dl.ramp), drop: clean(dl.drop),
    });
  }
  const session = {
    id: d.id, date: d.date, startedAt: d.startedAt, finishedAt: Date.now(), dayId: d.dayId, dayName: day.name,
    bw: bwNow(), tags: f.tags.slice(), note: f.note.trim(),
    effort: { clean: !!f.clean, nearFailure: !!f.nearFailure, attempted: !!f.attempted }, lifts,
  };
  try { await store.putSession(session); } catch (err) { toast(`Couldn't save the session: ${err.message || err}`, { sticky: true }); return; }
  db.sessions.push(session);
  sortSessions();
  db.draft = null;
  await saveKV('draft');
  recompute();
  ui.fin = null;
  ui.tab = 'today';
  render();
  openSheet(reportHTML(session.id, true), 'report');
}

// ================================================================ REPORT CARD
function reportHTML(sid, fresh = false) {
  const st = A.sessionStats.find((x) => x.id === sid);
  const s = db.sessions.find((x) => x.id === sid);
  if (!st || !s) return `<div class="sheet-h"><h2>Not found</h2><button class="btn sm" data-act="close-sheet">Close</button></div>`;
  const sIndex = L.seasonIndexFor(A.seasons, s.date);
  const focus = L.focusFor(db.meta, Math.max(0, sIndex));
  const pace = L.seasonPace(A, s.date, focus);
  const rating = st.rating;
  const chList = st.ch.map((c) => `<li><span>🏆 ${starName(c.liftId)}</span><span class="muted">${c.type === 'heaviest' ? `${fw(c.w)} × ${c.r} · heaviest ever` : `${c.total} reps @ ${fw(c.w)} · most ever`}</span></li>`).join('');
  const flags = [];
  st.behind.forEach((id) => flags.push(`<span class="badge bad">▼ Behind · ${esc(liftName(id))}</span>`));
  if (st.slipping) flags.push(`<span class="badge warn">⚠ Effort slipping (${f0(st.slip.recent)} vs norm ${f0(st.slip.norm)})</span>`);
  const order = orderedLiftIds(st.lifts.map((x) => x.liftId));
  const rows = order.map((id) => {
    const x = st.lifts.find((y) => y.liftId === id);
    const status = x.held ? '<span class="muted">⏸ held</span>' : x.hit ? '<span class="up">✓ hit</span>' : '<span class="down">✗ miss</span>';
    return `<tr><td class="name">${starName(id)}${x.moveUp ? ' <span class="muted">↑</span>' : ''}</td><td>${f1(x.score)}</td><td>${pct((x.ratio - 1) * 100)}</td><td>${status}</td></tr>`;
  }).join('');
  const skipped = s.lifts.filter((e) => e.status === 'skipped').map((e) => esc(liftName(e.liftId)));
  const actions = fresh ? `<button class="btn primary big" data-act="close-sheet">Done</button>`
    : `<div class="btn-row"><button class="btn" data-act="edit-session" data-id="${sid}">Edit</button><button class="btn danger" data-act="delete-session" data-id="${sid}">Delete</button></div>`;
  return `<div class="sheet-h"><div><div class="eyebrow">Report card</div><h2>${esc(s.dayName || '')} · ${dLabel(s.date)}</h2></div><button class="btn sm" data-act="close-sheet">${fresh ? 'Done' : 'Close'}</button></div>
    <div class="hero-row">
      <div class="stat hero"><div class="k">Session rating</div><div class="v ${ok(rating) && rating >= 1000 ? 'up' : ''}">${f0(rating)}</div><div class="sub">1000 = your normal day</div></div>
      <div class="stat"><div class="k">Effort</div><div class="v">${eff(st.effort)}</div><div class="sub">${Math.round((st.effort || 0) * 3)} of 3 checks</div></div>
    </div>
    <div class="tiles">
      <div class="stat"><div class="k">Targets hit</div><div class="v">${st.hits}/${st.targets}</div></div>
      <div class="stat"><div class="k">Career highs</div><div class="v">${st.ch.length}</div></div>
      <div class="stat"><div class="k">Held · skipped</div><div class="v">${st.held} · ${st.skipped}</div></div>
    </div>
    ${chList ? `<div class="card tight"><ul class="list">${chList}</ul></div>` : ''}
    ${flags.length ? `<div class="chips" style="margin:10px 0">${flags.join('')}</div>` : '<p class="hint small">No Behind or effort flags.</p>'}
    ${s.tags.length || s.note ? `<div class="card tight"><div class="chips">${s.tags.map((t) => `<span class="chip static">${esc(L.TAG_LABEL[t])}</span>`).join('')}</div>${s.note ? `<p class="hint">${esc(s.note)}</p>` : ''}<p class="hint small">Context only. Everything still counts.</p></div>` : ''}
    ${paceHTML(pace)}
    <h3>Lifts</h3>
    <div class="t-wrap"><table class="t"><thead><tr><th>Lift</th><th>Score</th><th>vs number</th><th>Target</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${skipped.length ? `<p class="hint small">Skipped: ${skipped.join(', ')}</p>` : ''}
    <div style="margin-top:16px">${actions}</div>`;
}
function paceHTML(pace) {
  if (!pace) return '';
  const S = A.settings;
  const pOk = pace.overallPct !== null && pace.overallPct >= S.cbePct - 1e-9;
  const eOk = pace.effortAvg !== null && pace.effortAvg >= S.effortGate - 1e-9;
  const focus = pace.focus.map((p) => {
    const on = p.avg !== null && p.avg >= p.bar - 1e-9;
    return `<li><span>${starName(p.liftId)}</span><span>${p.count ? `${pct(p.pct)} <span class="${on ? 'up' : 'down'}">${on ? '✓ on pace' : '✗ under bar'}</span>` : '<span class="muted">no sessions yet</span>'}</span></li>`;
  }).join('');
  return `<div class="card"><div class="title-row"><h3 style="margin:0">Season ${pace.index + 1} pace</h3><span class="muted small">${plural(pace.daysLeft, 'day')} left</span></div>
    <div class="lift-stats">
      <div class="kv"><span class="k">Overall vs +${S.cbePct}% bar</span><span class="v ${pOk ? 'up' : 'down'}">${pct(pace.overallPct)} ${pace.overallPct === null ? '' : pOk ? '✓' : '✗'}</span></div>
      <div class="kv"><span class="k">Effort avg (gate ${eff(S.effortGate)})</span><span class="v ${eOk ? 'up' : 'down'}">${eff(pace.effortAvg)} ${pace.effortAvg === null ? '' : eOk ? '✓' : '✗'}</span></div>
    </div>
    ${focus ? `<div class="k small muted">Focus lifts vs their bar</div><ul class="list">${focus}</ul>` : '<p class="hint small">No focus lifts picked. Set them in Settings.</p>'}
  </div>`;
}

// ================================================================ REVIEW (every 2 weeks)
function reviewHTML(inSheet) {
  const today = todayStr();
  const R = L.buildReview(A, db.meta, today, db.meta.lastExportAt, db.routine);
  const due = L.reviewDue(db.meta, A.firstDate, today, A.settings.reviewDays);
  if (!A.sessionStats.length) return `${inSheet ? '' : '<h1>Review</h1>'}<div class="card"><p class="hint">Your first two-week review shows up 14 days after your first session. It compares every lift with its number, tracks effort and consistency, and lists anything that needs a decision.</p></div>`;
  const lifts = orderedLiftIds(R.lifts.map((x) => x.liftId)).map((id) => R.lifts.find((x) => x.liftId === id)).map((x) => `<tr>
      <td class="name">${starName(x.liftId)}${x.behind ? ' <span class="badge bad">▼</span>' : ''}</td>
      <td class="${x.ahead ? 'up' : 'down'}">${x.ahead ? '▲' : '▼'} ${pct(x.vsNumberPct)}</td>
      <td>${pct(x.change2w)}</td></tr>`).join('');
  const e = R.effort;
  const effDelta = ok(e.recent) && ok(e.previous) ? (e.recent - e.previous) * 100 : null;
  const c2 = R.consistency.twoWeeks, cs = R.consistency.season;
  const ctx = R.context.length ? `<div class="t-wrap"><table class="t"><thead><tr><th>Tag</th><th>n</th><th>Rating tagged / not</th><th>Effort tagged / not</th></tr></thead><tbody>${R.context.map((c) => `<tr>
      <td>${esc(L.TAG_LABEL[c.tag])}</td><td>${c.n}</td><td>${f0(c.ratingTagged)} / ${f0(c.ratingUntagged)}</td><td>${eff(c.effortTagged)} / ${eff(c.effortUntagged)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="hint small">Shows once a tag has 3+ sessions.</p>';
  const sugg = R.suggestions.length ? R.suggestions.map((sg) => `<li><span>${starName(sg.liftId)}<span class="hint small" style="display:block">Step back → ${esc(fs(L.computeTarget(sg.sets, lift(sg.liftId), A.settings).sets))}</span></span>
      <span class="btn-row" style="margin:0;flex:0 0 auto"><button class="btn sm primary" data-act="sb-accept" data-id="${sg.liftId}">Accept</button><button class="btn sm" data-act="sb-dismiss" data-id="${sg.liftId}">Dismiss</button></span></li>`).join('') : '';
  const spark = sparkline(e.series.map((x) => x.effort));
  return `${inSheet ? '' : `<div class="title-row"><h1>Review</h1><span class="muted small">${due ? 'Due' : db.meta.lastReviewAt ? `Last: ${dLabel(db.meta.lastReviewAt)}` : ''}</span></div>`}
    <p class="hint">${dLabel(R.from)} – ${dLabel(R.to)}. Riley met with the team every two weeks. Nobody got to explain away a bad stretch.</p>
    <h2>Lifts vs their number</h2>
    <div class="t-wrap"><table class="t"><thead><tr><th>Lift</th><th>Latest vs number</th><th>Number, 2 wk</th></tr></thead><tbody>${lifts}</tbody></table></div>
    <h2>Effort</h2>
    <div class="tiles">
      <div class="stat"><div class="k">Last 2 wk</div><div class="v">${eff(e.recent)}</div></div>
      <div class="stat"><div class="k">2 wk before</div><div class="v">${eff(e.previous)}</div></div>
      <div class="stat"><div class="k">Change</div><div class="v ${ok(effDelta) ? (effDelta >= 0 ? 'up' : 'down') : ''}">${ok(effDelta) ? `${effDelta >= 0 ? '+' : '−'}${Math.abs(Math.round(effDelta))}` : '–'}</div></div>
    </div>
    ${spark ? `<div class="card tight"><div class="k small muted">Effort, last ${e.series.length} sessions (0–100)</div>${spark}</div>` : ''}
    ${e.slip.slipping ? `<div class="banner warn"><span class="ico">⚠</span><div class="grow"><b>Effort slipping:</b> last 3 average ${f0(e.slip.recent)} vs norm ${f0(e.slip.norm)}.</div></div>` : ''}
    <h2>Consistency</h2>
    <div class="tiles">
      <div class="stat"><div class="k">Rated 1000+ (2 wk)</div><div class="v">${c2.pct1000 === null ? '–' : `${Math.round(c2.pct1000)}%`}</div></div>
      <div class="stat"><div class="k">Sessions/wk (2 wk)</div><div class="v">${c2.perWeek.toFixed(1)}</div></div>
      <div class="stat"><div class="k">Sessions/wk (season)</div><div class="v">${cs ? cs.perWeek.toFixed(1) : '–'}</div></div>
    </div>
    <h2>Context</h2>${ctx}
    <h2>Decisions</h2>
    ${sugg ? `<ul class="list">${sugg}</ul>` : '<p class="hint small">No step-back suggestions pending.</p>'}
    <button class="btn" data-act="go-editor">Change the plan</button>
    ${R.backupDue ? `<div class="banner warn" style="margin-top:14px"><span class="ico">💾</span><div class="grow">Last backup: ${R.backupAge === null ? 'never' : `${plural(R.backupAge, 'day')} ago`}. Export one so a lost phone doesn't cost you your history.</div><button class="btn sm" data-act="export">Export</button></div>` : ''}
    <div style="margin-top:18px"><button class="btn primary big" data-act="mark-reviewed">${inSheet ? 'Done: mark reviewed' : 'Mark reviewed'}</button></div>`;
}
function reviewView() { return reviewHTML(false); }
function sparkline(vals) {
  const v = vals.filter(ok);
  if (v.length < 2) return '';
  const w = 300, h = 40, n = vals.length;
  const X = (i) => 4 + (i * (w - 8)) / (n - 1);
  const Y = (x) => 4 + (h - 8) * (1 - x);
  const pts = vals.map((x, i) => (ok(x) ? `${X(i).toFixed(1)},${Y(x).toFixed(1)}` : null)).filter(Boolean).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Effort trend"><line x1="0" x2="${w}" y1="${Y(A.settings.effortGate)}" y2="${Y(A.settings.effortGate)}" stroke="var(--grid)" stroke-width="1"/><polyline points="${pts}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// ================================================================ SEASON END
function unseenSeasonEnd() {
  if (!A || !A.seasons.length) return -1;
  const seen = db.meta.seasonsSeen || [];
  const today = todayStr();
  let latest = -1;
  A.seasons.forEach((s, i) => { if (L.seasonEnd(s) <= today && !seen.includes(i)) latest = i; });
  return latest;
}
function seasonEndHTML(i, readOnly = false) {
  const r = L.seasonResults({ lifts: Object.values(A.perLift), seasons: A.seasons, index: i, sessions: A.sessionStats, settings: A.settings });
  const focus = L.focusFor(db.meta, i);
  const S = A.settings;
  const inc = r.perLift.filter((p) => p.included);
  const sat = r.perLift.filter((p) => !p.included && lift(p.liftId) && !lift(p.liftId).archived);
  const order = orderedLiftIdsFor(inc.map((p) => p.liftId), focus);
  const rows = order.map((id) => { const p = inc.find((x) => x.liftId === id); return `<tr><td class="name">${focus.includes(id) ? '<span class="star">★</span>' : ''}${esc(liftName(id))}</td><td>${f1(p.avg)}</td><td>${f1(p.bar)}</td><td>${pct(p.pct)}</td><td>${p.cbe ? '<span class="badge gold">CBE ✓</span>' : '<span class="muted">—</span>'}</td></tr>`; }).join('');
  const sorted = inc.slice().sort((a, b) => b.pct - a.pct);
  const gains = sorted.filter((p) => p.pct > 0).slice(0, 3);
  const drops = sorted.filter((p) => p.pct < 0).slice(-3).reverse();
  const cons = L.consistency(A.sessionStats, r.start, r.end);
  const verdict = r.overall === null ? '<div class="verdict"><div><div class="big">No verdict</div><div class="hint">Not enough sessions this season.</div></div></div>'
    : `<div class="verdict ${r.overall ? 'good' : 'bad'}"><div class="big">${r.overall ? '🏆 Career Best Effort' : 'No CBE this season'}</div></div>
       <div class="tiles"><div class="stat"><div class="k">Mean change</div><div class="v ${r.pctOk ? 'up' : 'down'}">${pct(r.overallPct)}</div><div class="sub">needs +${S.cbePct}% ${r.pctOk ? '✓' : '✗'}</div></div>
       <div class="stat"><div class="k">Effort avg</div><div class="v ${r.effortOk ? 'up' : 'down'}">${eff(r.effortAvg)}</div><div class="sub">needs ${eff(S.effortGate)} ${r.effortOk ? '✓' : '✗'}</div></div>
       <div class="stat"><div class="k">Lift CBEs</div><div class="v">${inc.filter((p) => p.cbe).length}/${inc.length}</div></div></div>`;
  const nextFocus = ui.nextFocus || L.focusFor(db.meta, i + 1);
  ui.nextFocus = nextFocus;
  const picker = readOnly ? '' : `<h2>Season ${i + 2} focus lifts <span class="muted">${nextFocus.length}/5</span></h2>
    <p class="hint">Carried over by default. Pick the lifts that matter most for you next.</p>
    ${db.routine.days.map((d) => `<h3>${esc(d.name)}</h3><div class="chips">${d.liftIds.filter((id) => lift(id) && !lift(id).archived).map((id) => `<button class="chip ${nextFocus.includes(id) ? 'on' : ''}" data-act="next-focus" data-id="${id}">${nextFocus.includes(id) ? '★ ' : ''}${esc(liftName(id))}</button>`).join('')}</div>`).join('')}
    <div style="margin-top:18px"><button class="btn primary big" data-act="season-confirm" data-i="${i}">Confirm focus and continue</button></div>`;
  return `<div class="sheet-h"><div><div class="eyebrow">Season ${i + 1} · ${dLabel(r.start)} – ${dLabel(L.addDays(r.end, -1))}</div><h2>Season results</h2></div>${readOnly ? '<button class="btn sm" data-act="close-sheet">Close</button>' : ''}</div>
    ${verdict}
    <h3>Per lift <span class="muted">average vs bar (1.01 × best of seed and earlier seasons)</span></h3>
    ${rows ? `<div class="t-wrap"><table class="t"><thead><tr><th>Lift</th><th>Avg</th><th>Bar</th><th>Change</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hint">No lift had 2+ sessions this season.</p>'}
    ${sat.length ? `<p class="hint small">Sat out (fewer than 2 sessions): ${sat.map((p) => esc(liftName(p.liftId))).join(', ')}</p>` : ''}
    <div class="grid2">
      <div class="card tight"><div class="k small muted">Biggest gains</div><ul class="list">${gains.map((p) => `<li><span>${esc(liftName(p.liftId))}</span><span class="up">${pct(p.pct)}</span></li>`).join('') || '<li class="muted">—</li>'}</ul></div>
      <div class="card tight"><div class="k small muted">Biggest drops</div><ul class="list">${drops.map((p) => `<li><span>${esc(liftName(p.liftId))}</span><span class="down">${pct(p.pct)}</span></li>`).join('') || '<li class="muted">—</li>'}</ul></div>
    </div>
    <div class="tiles"><div class="stat"><div class="k">Sessions</div><div class="v">${cons.count}</div></div>
      <div class="stat"><div class="k">Per week</div><div class="v">${cons.perWeek.toFixed(1)}</div></div>
      <div class="stat"><div class="k">Rated 1000+</div><div class="v">${cons.pct1000 === null ? '–' : `${Math.round(cons.pct1000)}%`}</div></div></div>
    ${picker}`;
}
function orderedLiftIdsFor(ids, focus) {
  const order = activeLiftIds();
  const rank = (id) => (focus.includes(id) ? focus.indexOf(id) : 100 + (order.indexOf(id) >= 0 ? order.indexOf(id) : 999));
  return ids.slice().sort((a, b) => rank(a) - rank(b));
}

// ================================================================ TRENDS
function trendsView() {
  const tm = ui.trendsMonth || L.monthKey(todayStr());
  const lm = L.addMonths(tm, -1), ly = L.addMonths(tm, -12);
  const c = L.monthCompare(A, tm, lm);
  const y = L.monthCompare(A, tm, ly);
  const ids = orderedLiftIds(c.perLift.filter((p) => p.a !== null || p.b !== null).map((p) => p.liftId));
  const row = (cmp, id) => { const p = cmp.perLift.find((x) => x.liftId === id); return `<td>${f1(p.b)}</td><td>${f1(p.a)}</td><td class="${ok(p.pct) ? (p.pct >= 0 ? 'up' : 'down') : ''}">${pct(p.pct)}</td>`; };
  const table = (cmp, labelB) => `<div class="t-wrap"><table class="t"><thead><tr><th>Lift</th><th>${esc(labelB)}</th><th>${esc(monthLabel(tm).split(' ')[0])}</th><th>Change</th></tr></thead><tbody>
      ${ids.map((id) => `<tr><td class="name">${starName(id)}</td>${row(cmp, id)}</tr>`).join('')}</tbody></table></div>`;
  const tiles = (cmp) => `<div class="tiles">
      <div class="stat"><div class="k">Mean lift change</div><div class="v ${ok(cmp.overallPct) ? (cmp.overallPct >= 0 ? 'up' : 'down') : ''}">${pct(cmp.overallPct)}</div></div>
      <div class="stat"><div class="k">Effort</div><div class="v">${eff(cmp.effortA)}</div><div class="sub">was ${eff(cmp.effortB)}</div></div>
      <div class="stat"><div class="k">Sessions</div><div class="v">${cmp.countA}</div><div class="sub">was ${cmp.countB}</div></div></div>`;
  const seasons = A.seasons.map((s, i) => {
    const done = L.seasonEnd(s) <= todayStr();
    if (done) {
      const r = L.seasonResults({ lifts: Object.values(A.perLift), seasons: A.seasons, index: i, sessions: A.sessionStats, settings: A.settings });
      return `<button class="row-btn" data-act="open-season-end" data-i="${i}" data-ro="1"><span>Season ${i + 1}<span class="sub">${dLabel(s.start)} – ${dLabel(L.addDays(L.seasonEnd(s), -1))}</span></span><span class="r">${r.overall === null ? '<span class="muted">no verdict</span>' : r.overall ? '<span class="badge gold">CBE ✓</span>' : '<span class="muted">no CBE</span>'} ${pct(r.overallPct)} <span class="chev">›</span></span></button>`;
    }
    const p = L.seasonPace(A, todayStr(), L.focusFor(db.meta, i));
    return `<div class="row-btn"><span>Season ${i + 1} <span class="badge accent">current</span><span class="sub">${plural(p.daysLeft, 'day')} left · ${p.sessionCount} sessions</span></span><span class="r">${pct(p.overallPct)} <span class="sub">vs +${A.settings.cbePct}% bar</span></span></div>`;
  }).reverse().join('');
  return `<div class="title-row"><h1>Trends</h1></div>
    <div class="top-row"><button class="btn sm" data-act="trend-month" data-d="-1" aria-label="Previous month">‹</button><b>${esc(monthLabel(tm))}</b><button class="btn sm" data-act="trend-month" data-d="1" aria-label="Next month" ${tm >= L.monthKey(todayStr()) ? 'disabled' : ''}>›</button></div>
    <h2>vs ${esc(monthLabel(lm))}</h2>
    ${c.countA || c.countB ? `${tiles(c)}${ids.length ? table(c, monthLabel(lm).split(' ')[0]) : ''}` : '<p class="hint">No sessions in either month yet.</p>'}
    ${y.hasB ? `<h2>vs ${esc(monthLabel(ly))}</h2>${tiles(y)}${table(y, monthLabel(ly).split(' ')[0] + ' ' + ly.slice(0, 4))}` : `<p class="hint small">Year-over-year shows up once you have a ${esc(monthLabel(ly))}.</p>`}
    <p class="hint small">Average lift score per lift; the overall number is the mean of per-lift % changes for lifts done in both months.</p>
    <h2>Seasons</h2>
    ${seasons || '<p class="hint">Season 1 starts with your first session.</p>'}`;
}

// ================================================================ HISTORY
function historyView() {
  if (ui.hist.liftId) return liftDetailHTML(ui.hist.liftId);
  const m = ui.hist.mode;
  const seg = `<div class="chips" style="margin:6px 0 4px"><button class="chip ${m === 'lifts' ? 'on' : ''}" data-act="hist-mode" data-m="lifts">Lifts</button><button class="chip ${m === 'sessions' ? 'on' : ''}" data-act="hist-mode" data-m="sessions">Sessions</button></div>`;
  if (m === 'sessions') {
    const list = A.sessionStats.slice().reverse().map((st) => `<button class="row-btn" data-act="open-report" data-id="${st.id}">
        <span>${esc(st.dayName || '')} · ${dLabel(st.date)}<span class="sub">${st.hits}/${st.targets} targets · effort ${eff(st.effort)}${st.tags.length ? ` · ${st.tags.map((t) => esc(L.TAG_LABEL[t])).join(', ')}` : ''}</span></span>
        <span class="r"><b class="${ok(st.rating) && st.rating >= 1000 ? 'up' : ''}">${f0(st.rating)}</b> <span class="chev">›</span></span></button>`).join('');
    return `<h1>History</h1>${seg}${list || '<p class="hint">No sessions yet.</p>'}`;
  }
  const ids = orderedLiftIds(activeLiftIds());
  const archived = Object.values(db.routine.lifts).filter((l) => l.archived && A.perLift[l.id] && A.perLift[l.id].timeline.length).map((l) => l.id);
  const row = (id) => {
    const P = A.perLift[id];
    if (!P) return '';
    const last = P.timeline[P.timeline.length - 1];
    return `<button class="row-btn" data-act="open-lift" data-id="${id}"><span>${starName(id)}${P.behind ? ' <span class="badge bad">▼ Behind</span>' : ''}<span class="sub">${P.timeline.length} sessions · target ${esc(fs(P.target.sets))}</span></span>
      <span class="r">${f1(P.number)}${last ? `<span class="sub">${pct((last.ratio - 1) * 100)} last</span>` : ''} <span class="chev">›</span></span></button>`;
  };
  return `<h1>History</h1>${seg}${ids.map(row).join('')}${archived.length ? `<h3>Archived</h3>${archived.map(row).join('')}` : ''}`;
}
function liftDetailHTML(id) {
  const lf = lift(id), P = A.perLift[id];
  if (!lf || !P) { ui.hist.liftId = null; return historyView(); }
  const tl = P.timeline;
  const off0 = L.offsetFor(lf, lf.seed.bw);
  const labels = ['Seed', ...tl.map((t) => dLabel(t.date))];
  const seasonSegs = [];
  A.seasons.forEach((s, si) => {
    const idx = tl.map((t, i) => (t.date >= s.start && t.date < L.seasonEnd(s) ? i + 1 : -1)).filter((i) => i >= 0);
    if (idx.length) seasonSegs.push({ a: idx[0], b: idx[idx.length - 1], y: L.mean(idx.map((i) => tl[i - 1].score)), label: `S${si + 1} avg` });
  });
  const tagged = tl.map((t, i) => (t.tags.length ? { i: i + 1, v: t.score, note: t.tags.map((x) => L.TAG_LABEL[x]).join(', ') } : null)).filter(Boolean);
  const chartA = lineChart(`a-${id}`, {
    labels,
    series: [
      { name: 'Lift score', values: [P.seedScore, ...tl.map((t) => t.score)], color: 'var(--s1)', dots: true },
      { name: 'Number (before session)', values: [P.seedScore, ...tl.map((t) => t.number)], color: 'var(--ref)' },
    ],
    segments: seasonSegs.map((s) => ({ ...s, color: 'var(--s3)' })),
    markers: tagged.map((m) => ({ ...m, color: 'var(--s2)' })),
  });
  const chartB = lineChart(`b-${id}`, {
    labels,
    series: [
      { name: 'Heaviest working set', values: [maxW(lf.seed.sets), ...tl.map((t) => t.heaviest)], color: 'var(--s1)', dots: true, unit: 'lb' },
      { name: 'Est. 1RM (Epley)', values: [L.bestE1rm(lf.seed.sets, off0), ...tl.map((t) => t.e1rm)], color: 'var(--s2)', dots: true, unit: 'lb' },
    ],
  });
  const rows = tl.slice().reverse().map((t) => `<tr><td>${dLabel(t.date)}${t.tags.length ? ` <span class="muted small" title="${esc(t.tags.map((x) => L.TAG_LABEL[x]).join(', '))}">●</span>` : ''}</td>
      <td style="text-align:left">${esc(fs(L.heavyFirst(t.work.filter(L.isDone))))}</td><td>${f1(t.score)}</td><td>${f1(t.number)}</td>
      <td>${t.held ? '⏸' : t.hit ? '<span class="up">✓</span>' : '<span class="down">✗</span>'}${t.behind ? ' <span class="down">▼</span>' : ''}${t.moveUp ? ' ↑' : ''}</td></tr>`).join('');
  const W = maxW(P.baseline);
  return `<div class="title-row"><button class="link" data-act="close-lift">‹ History</button></div>
    <h1>${starName(id)}</h1>
    <div class="lift-meta">${esc(L.EQUIPMENT_LABEL[lf.equipment])} · ${lf.repMin === lf.repMax ? lf.repMin : `${lf.repMin}–${lf.repMax}`} reps · +${fw(lf.increment)} lb${lf.archived ? ' · archived' : ''}</div>
    <div class="tiles">
      <div class="stat"><div class="k">Number</div><div class="v">${f1(P.number)}</div><div class="sub">seed ${f1(P.seedScore)}</div></div>
      <div class="stat"><div class="k">Heaviest</div><div class="v">${Number.isFinite(P.ch.heaviest) ? fw(P.ch.heaviest) : '–'}</div><div class="sub">${P.ch.repsAt[wKey(W)] || 0} reps @ ${fw(W)}</div></div>
      <div class="stat"><div class="k">Status</div><div class="v" style="font-size:16px">${P.behind ? '<span class="down">▼ Behind</span>' : '<span class="up">On it</span>'}</div><div class="sub">${P.missStreak ? `${plural(P.missStreak, 'miss')} in a row` : 'no miss streak'}</div></div>
    </div>
    <div class="card"><div class="kv"><span class="k">Best at current weight</span><span class="v">${esc(fs(P.baseline))}</span></div>
      <div class="kv" style="margin-top:6px"><span class="k">Next target</span><span class="v">${esc(fs(P.target.sets))}${lf.hold ? ' (held)' : ''}</span></div></div>
    <div class="card chart-card"><h3>Lift score vs your number</h3>${chartA}
      <div class="legend"><span class="key"><span class="sw" style="background:var(--s1)"></span>Lift score</span><span class="key"><span class="sw" style="background:var(--ref)"></span>Number before session</span>${seasonSegs.length ? '<span class="key"><span class="sw" style="background:var(--s3);height:3px"></span>Season average</span>' : ''}${tagged.length ? '<span class="key"><span class="sw dot" style="background:var(--s2)"></span>Tagged session</span>' : ''}</div></div>
    <div class="card chart-card"><h3>Heaviest set and estimated 1RM (lb)</h3>${chartB}
      <div class="legend"><span class="key"><span class="sw" style="background:var(--s1)"></span>Heaviest working set</span><span class="key"><span class="sw" style="background:var(--s2)"></span>Est. 1RM (Epley)</span></div></div>
    <h3>Sessions</h3>
    ${rows ? `<div class="t-wrap"><table class="t"><thead><tr><th>Date</th><th style="text-align:left">Working sets</th><th>Score</th><th>Number</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hint">No sessions yet. The seed is your starting number.</p>'}
    <div class="btn-row"><button class="btn" data-act="edit-lift" data-id="${id}">Edit lift</button></div>`;
}

// ---------------------------------------------------------------- charts (SVG, hover/touch crosshair)
const CHARTS = {};
function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}
function lineChart(key, cfg) {
  const { labels, series, segments = [], markers = [] } = cfg;
  const all = [...series.flatMap((s) => s.values), ...segments.map((s) => s.y)].filter(ok);
  if (!all.length) return '<p class="hint">No data yet.</p>';
  const Wd = 340, H = 190, pl = 38, pr = 10, pt = 10, pb = 26;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const step = niceStep(hi - lo, 4);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const n = labels.length;
  const X = (i) => pl + (n <= 1 ? (Wd - pl - pr) / 2 : (i * (Wd - pl - pr)) / (n - 1));
  const Y = (v) => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo));
  CHARTS[key] = { ...cfg, geo: { Wd, H, pl, pr, pt, pb, n } };
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  const grid = ticks.map((v) => `<line class="grid" x1="${pl}" x2="${Wd - pr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="axis-t" x="${pl - 6}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end">${Math.abs(v) >= 100 ? Math.round(v) : +v.toFixed(1)}</text>`).join('');
  const xl = [0, n - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => `<text class="axis-t" x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : 'end'}">${esc(labels[i])}</text>`).join('');
  const paths = series.map((s) => {
    let d = '';
    s.values.forEach((v, i) => { if (ok(v)) d += `${d && ok(s.values[i - 1]) ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; });
    const dots = s.dots && n <= 60 ? s.values.map((v, i) => (ok(v) ? `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>` : '')).join('') : '';
    return `<path class="ln" d="${d}" stroke="${s.color}"/>${dots}`;
  }).join('');
  const segs = segments.map((s) => `<line x1="${(X(s.a) - (s.a === s.b ? 6 : 0)).toFixed(1)}" x2="${(X(s.b) + (s.a === s.b ? 6 : 0)).toFixed(1)}" y1="${Y(s.y).toFixed(1)}" y2="${Y(s.y).toFixed(1)}" stroke="${s.color}" stroke-width="2.5" stroke-linecap="round"/>`).join('');
  const marks = markers.map((m) => { const x = X(m.i), y = Y(m.v); return `<path d="M${x.toFixed(1)},${(y - 6).toFixed(1)}L${(x + 6).toFixed(1)},${y.toFixed(1)}L${x.toFixed(1)},${(y + 6).toFixed(1)}L${(x - 6).toFixed(1)},${y.toFixed(1)}Z" fill="${m.color}" stroke="var(--surface)" stroke-width="2"/>`; }).join('');
  const desc = series.map((s) => `${s.name}: ${s.values.filter(ok).length} points`).join('; ');
  return `<div class="chart-wrap" data-chart="${key}"><svg class="chart" viewBox="0 0 ${Wd} ${H}" role="img" aria-label="${esc(desc)}">${grid}${segs}${paths}${marks}${xl}
    <line class="cross" x1="0" x2="0" y1="${pt}" y2="${H - pb}" visibility="hidden"/></svg><div class="tip" hidden></div></div>`;
}
function bindCharts(root) {
  root.querySelectorAll('.chart-wrap').forEach((wrap) => {
    if (wrap.dataset.bound) return;
    wrap.dataset.bound = '1';
    const cfg = CHARTS[wrap.dataset.chart];
    if (!cfg) return;
    const svg = wrap.querySelector('svg'), cross = wrap.querySelector('.cross'), tip = wrap.querySelector('.tip');
    const { Wd, pl, pr, n } = cfg.geo;
    const show = (ev) => {
      const rect = svg.getBoundingClientRect();
      const sx = ((ev.clientX - rect.left) / rect.width) * Wd;
      const i = n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((sx - pl) / (Wd - pl - pr)) * (n - 1))));
      const x = pl + (n <= 1 ? (Wd - pl - pr) / 2 : (i * (Wd - pl - pr)) / (n - 1));
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      tip.replaceChildren();
      const head = document.createElement('div'); head.className = 'tt'; head.textContent = cfg.labels[i]; tip.appendChild(head);
      cfg.series.forEach((s) => {
        const v = s.values[i];
        const r = document.createElement('div'); r.className = 'tr';
        const k = document.createElement('span'); k.className = 'lk'; k.style.background = s.color;
        const b = document.createElement('b'); b.textContent = ok(v) ? (Math.abs(v) >= 100 ? v.toFixed(1) : (+v.toFixed(2)).toString()) : '–';
        const nm = document.createElement('span'); nm.textContent = s.name;
        r.append(k, b, nm); tip.appendChild(r);
      });
      (cfg.segments || []).filter((sg) => i >= sg.a && i <= sg.b).forEach((sg) => {
        const r = document.createElement('div'); r.className = 'tr';
        const k = document.createElement('span'); k.className = 'lk'; k.style.background = sg.color;
        const b = document.createElement('b'); b.textContent = sg.y.toFixed(1);
        const nm = document.createElement('span'); nm.textContent = sg.label;
        r.append(k, b, nm); tip.appendChild(r);
      });
      (cfg.markers || []).filter((m) => m.i === i).forEach((m) => {
        const r = document.createElement('div'); r.className = 'tr';
        const nm = document.createElement('span'); nm.textContent = `Tagged: ${m.note}`;
        r.append(nm); tip.appendChild(r);
      });
      tip.hidden = false;
      const px = (x / Wd) * rect.width;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.max(0, Math.min(rect.width - tw, px > rect.width / 2 ? px - tw - 10 : px + 10))}px`;
    };
    wrap.addEventListener('pointerdown', show);
    wrap.addEventListener('pointermove', show);
    wrap.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); } });
  });
}

// ================================================================ SETTINGS + EDITOR
function settingsView() {
  const p = ui.set.page;
  if (p === 'days') return daysPage();
  if (p === 'day') return dayPage(ui.set.dayId);
  if (p === 'lift') return liftForm();
  if (p === 'lifts') return allLiftsPage();
  if (p === 'focus') return focusPage();
  if (p === 'rules') return rulesPage();
  if (p === 'about') return aboutPage();
  const S = A.settings;
  const lastExp = db.meta.lastExportAt ? `${dLabel(db.meta.lastExportAt)} (${plural(L.daysBetween(db.meta.lastExportAt, todayStr()), 'day')} ago)` : 'never';
  const persist = db.meta.persist || 'unknown';
  return `<h1>Settings</h1>
    <h3>Plan</h3>
    <button class="row-btn" data-act="set-page" data-p="days"><span>Days &amp; rotation<span class="sub">${db.routine.days.map((d) => esc(d.name)).join(' → ')}</span></span><span class="chev">›</span></button>
    <button class="row-btn" data-act="set-page" data-p="lifts"><span>All lifts<span class="sub">${activeLiftIds().length} active · sets, reps, increments, equipment</span></span><span class="chev">›</span></button>
    <button class="row-btn" data-act="set-page" data-p="focus"><span>Focus lifts · Season ${seasonIdx() + 1}<span class="sub">${focusNow().map((id) => esc(liftName(id))).join(', ') || 'none'}</span></span><span class="chev">›</span></button>
    <h3>You</h3>
    <div class="card"><div class="field"><label for="bw">Bodyweight (lb)</label><input id="bw" class="input" inputmode="decimal" data-setting="bodyweight" value="${esc(db.settings.bodyweight ?? '')}" placeholder="optional"></div>
      <p class="hint small">Scores bodyweight lifts (load = bodyweight + added). Saved with each session; stays on this device.</p></div>
    <h3>Rules</h3>
    <button class="row-btn" data-act="set-page" data-p="rules"><span>CBE defaults<span class="sub">Season ${S.seasonWeeks} wk · number window ${S.numberWindow} · Behind after ${S.behindAfter} · slip ${S.effortSlipPoints} pts · gate ${eff(S.effortGate)}</span></span><span class="chev">›</span></button>
    <h3>Backup</h3>
    <div class="card"><p class="hint" style="margin-top:0">Last backup: <b>${lastExp}</b>. Your data lives only on this phone, so export regularly and keep the file in iCloud Drive, Google Drive, or email.</p>
      <div class="btn-row"><button class="btn primary" data-act="export">Export backup</button><button class="btn" data-act="import">Import backup</button></div>
      <p class="hint small">Storage: ${persist === 'persistent' ? 'persistent ✓ (the browser won\'t clear it on its own)' : `${esc(persist)}`}${persist !== 'persistent' ? ' · <button class="link" data-act="persist">Request persistent storage</button>' : ''}</p></div>
    <h3>About</h3>
    <button class="row-btn" data-act="set-page" data-p="about"><span>How CBE works · version · self-tests</span><span class="chev">›</span></button>
    <h3>Danger zone</h3>
    <button class="btn danger" data-act="erase">Erase all data on this device</button>`;
}
function backBtn(page = null, label = 'Settings') { return `<button class="link" data-act="set-page" data-p="${page || ''}">‹ ${esc(label)}</button>`; }
function daysPage() {
  const days = db.routine.days;
  const rows = days.map((d, i) => `<div class="row-btn"><button class="link" style="flex:1;text-align:left;color:var(--text)" data-act="open-day" data-id="${d.id}">${i + 1}. ${esc(d.name)}<span class="sub">${plural(d.liftIds.filter((id) => lift(id) && !lift(id).archived).length, 'lift')}</span></button>
      <span class="r"><button class="btn sm" data-act="day-move" data-id="${d.id}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button> <button class="btn sm" data-act="day-move" data-id="${d.id}" data-d="1" ${i === days.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button></span></div>`).join('');
  return `${backBtn()}<h1>Days &amp; rotation</h1><p class="hint">The app opens to the day after the last one you did, in this order. Days aren't tied to weekdays.</p>${rows}
    <div class="btn-row"><button class="btn" data-act="add-day">+ Add day</button></div>`;
}
function dayPage(dayId) {
  const d = dayById(dayId);
  if (!d) { ui.set.page = 'days'; return daysPage(); }
  const ids = d.liftIds.filter((id) => lift(id) && !lift(id).archived);
  const rows = ids.map((id, i) => `<div class="row-btn"><button class="link" style="flex:1;text-align:left;color:var(--text)" data-act="edit-lift" data-id="${id}">${esc(liftName(id))}<span class="sub">${esc(L.EQUIPMENT_LABEL[lift(id).equipment])} · ${lift(id).sets} sets</span></button>
      <span class="r"><button class="btn sm" data-act="lift-move" data-id="${id}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button> <button class="btn sm" data-act="lift-move" data-id="${id}" data-d="1" ${i === ids.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button> <button class="btn sm" data-act="lift-remove" data-id="${id}" aria-label="Remove from day">✕</button></span></div>`).join('');
  const others = Object.values(db.routine.lifts).filter((l) => !d.liftIds.includes(l.id) || l.archived);
  return `${backBtn('days', 'Days')}<div class="field"><label for="dayname">Day name</label><input id="dayname" class="input" data-dayname="${d.id}" value="${esc(d.name)}"></div>
    <h3>Lifts, in order</h3>${rows || '<p class="hint">No lifts yet.</p>'}
    <div class="btn-row"><button class="btn primary" data-act="new-lift" data-day="${d.id}">+ New lift</button></div>
    ${others.length ? `<div class="field"><label for="add-existing">Add an existing lift</label><select id="add-existing" class="input" data-add-existing="${d.id}"><option value="">Choose…</option>${others.map((l) => `<option value="${l.id}">${esc(l.name)}${l.archived ? ' (archived)' : ''}</option>`).join('')}</select></div>` : ''}
    ${db.routine.days.length > 1 ? `<div class="btn-row" style="margin-top:24px"><button class="btn danger" data-act="delete-day" data-id="${d.id}">Delete this day</button></div>` : ''}`;
}
function allLiftsPage() {
  const act = activeLiftIds();
  const arch = Object.values(db.routine.lifts).filter((l) => l.archived).map((l) => l.id);
  const row = (id) => `<button class="row-btn" data-act="edit-lift" data-id="${id}"><span>${esc(liftName(id))}<span class="sub">${esc(L.EQUIPMENT_LABEL[lift(id).equipment])} · ${lift(id).sets} sets · ${lift(id).repMin}–${lift(id).repMax} · +${fw(lift(id).increment)} lb</span></span><span class="chev">›</span></button>`;
  return `${backBtn()}<h1>All lifts</h1>${act.map(row).join('')}${arch.length ? `<h3>Archived</h3>${arch.map(row).join('')}` : ''}<p class="hint small">To add a lift, open a day in Days &amp; rotation.</p>`;
}
function openLiftForm(id, dayId = null) {
  if (id) {
    const lf = lift(id), P = A.perLift[id];
    ui.form = {
      isNew: false, id, dayId, name: lf.name, equipment: lf.equipment, perSide: lf.perSide, sets: lf.sets,
      repMin: lf.repMin, repMax: lf.repMax, increment: lf.increment, base: lf.base || 0,
      ramp: lf.ramp.map((s) => ({ w: s.w ?? '', r: s.r ?? 10 })), drop: lf.drop.length > 0, dropW: lf.drop[0] ? lf.drop[0].w ?? '' : '',
      work: (P ? P.baseline : lf.seed.sets).map((s) => ({ w: s.w, r: s.r })), archived: lf.archived,
    };
  } else {
    const d = L.equipmentDefaults('machine');
    ui.form = { isNew: true, id: null, dayId, name: '', equipment: 'machine', perSide: false, sets: 3, repMin: d.repMin, repMax: d.repMax, increment: d.increment, base: 0, ramp: [], drop: false, dropW: '', work: [{ w: '', r: 10 }, { w: '', r: 10 }, { w: '', r: 10 }], archived: false };
  }
  ui.tab = 'settings';
  ui.set = { page: 'lift', dayId, back: ui.set.page };
}
function liftForm() {
  const f = ui.form;
  if (!f) { ui.set.page = null; return settingsView(); }
  const stepper = (act, val, label) => `<div class="stp" style="width:150px"><button class="sb" data-act="${act}" data-d="-1" aria-label="Fewer ${label}">−</button><span class="num" style="line-height:46px">${val}</span><button class="sb" data-act="${act}" data-d="1" aria-label="More ${label}">+</button></div>`;
  const work = f.work.map((s, i) => `<div class="su-row" style="display:flex;gap:6px;align-items:center;margin-top:6px"><span class="muted small" style="width:44px">Set ${i + 1}</span>
      <input class="input small" inputmode="decimal" data-fw="${i}" data-k="w" value="${esc(s.w ?? '')}" aria-label="Set ${i + 1} weight"> lb ×
      <input class="input small" inputmode="numeric" data-fw="${i}" data-k="r" value="${esc(s.r ?? '')}" aria-label="Set ${i + 1} reps"></div>`).join('');
  const ramp = f.ramp.map((s, i) => `<div class="su-row" style="display:flex;gap:6px;align-items:center;margin-top:6px"><span class="muted small" style="width:44px">Ramp ${i + 1}</span>
      <input class="input small" inputmode="decimal" data-fr="${i}" data-k="w" value="${esc(s.w ?? '')}" placeholder="lb" aria-label="Ramp ${i + 1} weight"> lb ×
      <input class="input small" inputmode="numeric" data-fr="${i}" data-k="r" value="${esc(s.r ?? '')}" aria-label="Ramp ${i + 1} reps"></div>`).join('');
  return `${f.isNew ? backBtn('day', 'Day') : backBtn(ui.set.back || 'lifts', 'Back')}
    <h1>${f.isNew ? 'New lift' : esc(f.name)}</h1>
    <div class="field"><label for="ef-name">Name</label><input id="ef-name" class="input" data-ef="name" value="${esc(f.name)}"></div>
    <div class="grid2">
      <div class="field"><label for="ef-eq">Equipment</label><select id="ef-eq" class="input" data-ef="equipment">${L.EQUIPMENT.map((e) => `<option value="${e}" ${f.equipment === e ? 'selected' : ''}>${L.EQUIPMENT_LABEL[e]}</option>`).join('')}</select></div>
      <div class="field"><label for="ef-inc">Increment (lb)</label><input id="ef-inc" class="input" inputmode="decimal" data-ef="increment" value="${esc(f.increment)}"></div>
    </div>
    <p class="hint small">${L.family(f.equipment) === 'together' ? 'Plate-loaded and machines: all working sets move up together.' : 'Cables, dumbbells, bodyweight: one set moves up a weight at a time and restarts at 6+ reps.'}</p>
    <div class="grid2">
      <div class="field"><label for="ef-rmin">Rep range: low</label><input id="ef-rmin" class="input" inputmode="numeric" data-ef="repMin" value="${esc(f.repMin)}"></div>
      <div class="field"><label for="ef-rmax">Rep range: top</label><input id="ef-rmax" class="input" inputmode="numeric" data-ef="repMax" value="${esc(f.repMax)}"></div>
    </div>
    <div class="grid2">
      ${f.equipment === 'bodyweight' ? '<div class="field"><span class="label">Load</span><p class="hint small">Bodyweight + added weight.</p></div>'
      : `<div class="field"><label for="ef-base">Base load (lb)</label><input id="ef-base" class="input" inputmode="decimal" data-ef="base" value="${esc(f.base)}"><span class="hint small">Added to every logged weight when scoring. Usually 0.</span></div>`}
      <div class="field"><span class="label">Per side</span><div class="toggle-row"><span class="hint small">Label only</span><button class="switch ${f.perSide ? 'on' : ''}" data-act="ef-toggle" data-k="perSide" aria-pressed="${f.perSide}" aria-label="Per side"></button></div></div>
    </div>
    <h3>Working sets ${stepper('ef-sets', f.sets, 'sets')}</h3>
    <p class="hint small">${f.isNew ? 'Starting sets. They become this lift\'s seed (its first number).' : 'Your best at the current weight. Changing these resets your baseline; your history and number stay.'}</p>
    ${work}
    <h3>Ramp sets ${stepper('ef-ramp', f.ramp.length, 'ramp sets')}</h3>
    <p class="hint small">Warm-ups. Pre-filled from last time, logged, never pushed.</p>
    ${ramp}
    <div class="toggle-row" style="margin-top:12px"><span>Drop set after the last set <span class="muted small">(logged, not scored)</span></span><button class="switch ${f.drop ? 'on' : ''}" data-act="ef-toggle" data-k="drop" aria-pressed="${f.drop}" aria-label="Drop set"></button></div>
    ${f.drop ? `<div class="su-row" style="display:flex;gap:6px;align-items:center"><span class="muted small" style="width:44px">Drop</span><input class="input small" inputmode="decimal" data-ef="dropW" value="${esc(f.dropW)}" placeholder="lb" aria-label="Drop set weight"> lb</div>` : ''}
    <div class="err-msg" id="ef-err" style="color:var(--bad-ink);margin-top:12px" hidden></div>
    <div class="btn-row" style="margin-top:18px"><button class="btn primary big" data-act="ef-save">${f.isNew ? 'Add lift' : 'Save'}</button></div>
    ${f.isNew ? '' : `<div class="btn-row" style="margin-top:18px">${f.archived ? `<button class="btn" data-act="ef-unarchive">Unarchive</button>` : `<button class="btn danger" data-act="ef-archive">Archive lift</button>`}</div>
      <p class="hint small">Archiving removes it from every day. History, seasons, and trends keep it.</p>`}`;
}
async function saveLiftForm() {
  const f = ui.form;
  const err = (m) => { const el = $('#ef-err'); el.textContent = m; el.hidden = false; el.scrollIntoView({ block: 'center' }); };
  const name = String(f.name || '').trim();
  const inc = num(f.increment), rmin = num(f.repMin), rmax = num(f.repMax), base = f.equipment === 'bodyweight' ? 0 : num(f.base) || 0;
  if (!name) return err('Give the lift a name.');
  if (!(inc > 0)) return err('Increment must be more than 0.');
  if (!(rmin >= 1 && rmax >= rmin && Number.isInteger(rmin) && Number.isInteger(rmax))) return err('Rep range: whole numbers, top at or above low.');
  const work = f.work.map((s) => ({ w: num(s.w), r: num(s.r) }));
  if (work.some((s) => s.w === null || s.w < 0 || !(s.r >= 1))) return err('Every working set needs a weight (0 or more) and reps.');
  const bodyweight = f.equipment === 'bodyweight';
  if (!bodyweight && work.some((s) => s.w + base <= 0)) return err('Weight plus base load must be more than 0.');
  if (bodyweight && !bwNow() && work.some((s) => s.w <= 0)) return err('Add your bodyweight in Settings first, so this lift has a load to score.');
  const ramp = f.ramp.map((s) => ({ w: num(s.w), r: num(s.r) || 10 }));
  const drop = f.drop ? [{ w: num(f.dropW), r: 10 }] : [];
  const today = todayStr();
  if (f.isNew) {
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'lift'}-${Math.random().toString(36).slice(2, 6)}`;
    const lf = makeLift(id, name, f.equipment, work.length, work[0].r, { repMin: rmin, repMax: rmax, increment: inc, perSide: f.perSide, base });
    lf.ramp = ramp; lf.drop = drop;
    lf.seed = { sets: L.heavyFirst(work), bw: bwNow(), date: today };
    db.routine.lifts[id] = lf;
    const d = dayById(f.dayId) || db.routine.days[0];
    d.liftIds.push(id);
    await saveKV('routine');
    recompute();
    ui.form = null; ui.set = { page: 'day', dayId: d.id };
    toast(`${name} added. Its number starts at those sets.`);
    render();
    return;
  }
  const lf = lift(f.id), P = A.perLift[f.id];
  const before = JSON.stringify(L.heavyFirst(P ? P.baseline : lf.seed.sets));
  Object.assign(lf, { name, equipment: f.equipment, perSide: !!f.perSide, repMin: rmin, repMax: rmax, increment: inc, base, bodyweight, ramp, drop, sets: work.length });
  if (JSON.stringify(L.heavyFirst(work)) !== before) {
    db.events.push({ id: uid(), type: 'rebase', liftId: lf.id, ts: Date.now(), date: today, sets: L.heavyFirst(work) });
    await saveKV('events');
  }
  if (lf.hold) lf.hold = null; // plan changed: the target follows the new plan
  await saveKV('routine');
  recompute();
  if (db.draft) { syncDraft(); saveDraftNow(); }
  toast('Saved. Targets updated.');
  ui.form = null;
  ui.set = { page: ui.set.back === 'day' ? 'day' : ui.set.back || 'lifts', dayId: ui.set.dayId };
  render();
}
function focusPage() {
  const sel = ui.focusSel || (ui.focusSel = focusNow().slice());
  const groups = db.routine.days.map((d) => `<h3>${esc(d.name)}</h3><div class="chips">${d.liftIds.filter((id) => lift(id) && !lift(id).archived).map((id) => `<button class="chip ${sel.includes(id) ? 'on' : ''}" data-act="focus-toggle" data-id="${id}">${sel.includes(id) ? '★ ' : ''}${esc(liftName(id))}</button>`).join('')}</div>`).join('');
  return `${backBtn()}<h1>Focus lifts</h1><p class="hint">Up to 5 for Season ${seasonIdx() + 1}. They show first in reports, reviews, and trends, with their own season pace. Each new season carries them over unless you change them.</p>
    <p><b>${sel.length}/5</b> picked</p>${groups}<div class="btn-row" style="margin-top:18px"><button class="btn primary big" data-act="focus-save">Save focus lifts</button></div>`;
}
function rulesPage() {
  const S = A.settings;
  const gates = [[1 / 3, '1 of 3 (33)'], [1 / 2, 'Half (50)'], [2 / 3, '2 of 3 (67)'], [3 / 4, '3 of 4 (75)'], [5 / 6, '5 of 6 (83)'], [1, 'All 3 (100)']];
  const field = (k, label, help) => `<div class="field"><label for="r-${k}">${label}</label><input id="r-${k}" class="input" inputmode="numeric" data-rule="${k}" value="${esc(S[k])}"><span class="hint small">${help}</span></div>`;
  return `${backBtn()}<h1>CBE defaults</h1>
    ${field('seasonWeeks', 'Season length (weeks)', 'A change applies from the next season, so finished seasons never shift.')}
    ${field('numberWindow', 'Number window (sessions)', 'Your number = the mean of this many recent lift scores.')}
    ${field('behindAfter', 'Behind after (sessions in a row)', 'Lift score below the number this many sessions in a row → Behind.')}
    ${field('effortSlipPoints', 'Effort slip (points)', 'Last 3 sessions this far below your effort norm → slipping.')}
    <div class="field"><label for="r-gate">Effort gate for an overall CBE</label><select id="r-gate" class="input" data-rule="effortGate">${gates.map(([v, l]) => `<option value="${v}" ${Math.abs(S.effortGate - v) < 1e-6 ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="btn-row"><button class="btn primary big" data-act="rules-save">Save</button></div>
    <button class="link" data-act="rules-reset">Reset to defaults</button>`;
}
function aboutPage() {
  return `${backBtn()}<h1>How CBE works</h1>
    <div class="card"><p><b>Every session:</b> each lift's target is one small step past your best at your current weight. Hit it and your best moves up. Miss and your best holds, so the target repeats. After 3 misses in a row you get a step-back suggestion.</p>
    <p><b>Lift score</b> = average Epley estimate (load × (1 + reps/30)) across your working sets. A skipped set counts as 0.</p>
    <p><b>Your number</b> = the mean of your last ${A.settings.numberWindow} lift scores. <b>Session rating</b> = 1000 × average(lift score ÷ number). 1000 is a normal day.</p>
    <p><b>Behind</b> = below your number ${A.settings.behindAfter} sessions in a row. <b>Effort</b> = your three yes/no checks; it's the early signal.</p>
    <p><b>Season (${A.settings.seasonWeeks} weeks):</b> a lift earns a CBE when its season average is at least 1% above its best before. Overall CBE also needs your effort average to reach the gate.</p>
    <p class="hint small">Context tags explain the data. They never excuse it: everything still counts.</p></div>
    <div class="card"><p class="hint" style="margin:0">Version: <b id="ver">…</b></p>
      <div class="btn-row"><a class="btn" href="tests.html">Run self-tests</a></div></div>`;
}

// ================================================================ BACKUP
async function exportBackup() {
  const data = { app: 'cbe-tracker', schema: 1, exportedAt: new Date().toISOString(), settings: db.settings, routine: db.routine, events: db.events, meta: db.meta, draft: db.draft, sessions: db.sessions };
  const json = JSON.stringify(data, null, 1);
  const name = `cbe-backup-${todayStr()}.json`;
  let shared = false;
  try {
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /iphone|ipad|ipod|android/i.test(navigator.userAgent)) {
      await navigator.share({ files: [file], title: 'CBE backup' });
      shared = true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') { toast('Export cancelled'); return; }
  }
  if (!shared) {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  db.meta.lastExportAt = todayStr();
  await saveKV('meta');
  toast(`Backup exported: ${name}`);
  render();
}
/** IDs end up in HTML attributes, so only accept plain slug/uuid characters from a file. */
function backupIdsSafe(data) {
  const okId = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(x);
  try {
    const lifts = data.routine.lifts || {};
    if (!Object.keys(lifts).every((k) => okId(k) && okId(lifts[k].id) && lifts[k].id === k)) return false;
    if (!(data.routine.days || []).every((d) => okId(d.id) && (d.liftIds || []).every(okId))) return false;
    if (!data.sessions.every((s) => okId(s.id) && okId(s.dayId) && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && (s.lifts || []).every((e) => okId(e.liftId)))) return false;
    if (!(data.events || []).every((e) => okId(e.liftId))) return false;
    return true;
  } catch { return false; }
}
async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file isn\'t valid JSON.'); return; }
  if (!data || data.app !== 'cbe-tracker' || !data.routine || !Array.isArray(data.sessions)) { toast('That isn\'t a CBE Tracker backup.'); return; }
  if (!backupIdsSafe(data)) { toast('That backup has malformed IDs, so it wasn\'t imported.'); return; }
  const yes = await confirmSheet('Replace all data?', `This replaces everything on this device with the backup from ${data.exportedAt ? new Date(data.exportedAt).toLocaleString() : 'that file'} (${plural(data.sessions.length, 'session')}).`, 'Replace', true);
  if (!yes) return;
  await store.replaceAll({ settings: data.settings || {}, routine: data.routine, events: data.events || [], meta: data.meta || {}, draft: data.draft || null, sessions: data.sessions });
  await loadState();
  recompute();
  ui.tab = 'today'; ui.set = { page: null };
  render();
  toast('Backup restored.');
}

// ================================================================ ACTIONS
const ACT = {
  tab(el) { ui.tab = el.dataset.tab; if (ui.tab !== 'history') ui.hist.liftId = null; if (ui.tab === 'settings') ui.set = { page: null }; render(); window.scrollTo(0, 0); },
  'close-sheet'() {
    if (ui.sheet === 'review') markReviewed(false);
    closeSheet(); render(); launchChecks({ review: false });
  },
  'confirm-yes'() { settleConfirm(true); },
  'confirm-no'() { settleConfirm(false); },
  // setup
  'setup-step'(el) {
    const step = +el.dataset.step;
    if (step === 2) { const errs = validateSetup(); if (errs.length) { showSetupErrors(errs); return; } }
    ui.setup.step = step; saveSetupSoon(); render(); window.scrollTo(0, 0);
  },
  'setup-focus'(el) { toggleIn(ui.setup.focus, el.dataset.id, 5); saveSetupSoon(); render(); },
  'setup-finish'() { const errs = validateSetup(); if (errs.length) { ui.setup.step = 1; render(); showSetupErrors(errs); return; } finishSetup(); },
  // today
  async 'switch-day'(el) {
    const id = el.dataset.id;
    if (db.draft && id === db.draft.dayId) return;
    if (draftHasDone() && !(await confirmSheet('Switch day?', 'Sets you marked done in this session will be cleared.', 'Switch'))) return;
    db.draft = newDraft(id); await saveDraftNow(); render(); window.scrollTo(0, 0);
  },
  async 'discard-draft'() {
    if (!(await confirmSheet('Discard this session?', 'Everything logged in it will be cleared.', 'Discard', true))) return;
    db.draft = null; await saveDraftNow(); render();
  },
  step(el) {
    const c = rowCtx(el);
    syncRow(c.row, c.s);
    const d = +el.dataset.d;
    if (el.dataset.f === 'w') { const inc = Number(lift(c.id).increment) || 5; c.s.w = Math.max(0, L.rw((num(c.s.w) ?? 0) + d * inc)); }
    else c.s.r = Math.max(0, (num(c.s.r) ?? 0) + d);
    saveDraftNow(); rerenderCard(c.id);
  },
  'toggle-done'(el) {
    const c = rowCtx(el);
    syncRow(c.row, c.s);
    if (!c.s.done) {
      if (num(c.s.w) === null || !(num(c.s.r) > 0)) { toast('Enter weight and reps first'); return; }
      c.s.done = true;
      if (navigator.vibrate) navigator.vibrate(12);
      if (c.kind === 'work') {
        const P = A.perLift[c.id];
        const res = L.chSession(P.ch, c.dl.work.map((s) => ({ ...s, w: num(s.w), r: num(s.r) })));
        const ev = res.events.find((e) => e.set === c.i);
        if (ev) toast(ev.type === 'heaviest' ? `🏆 Career high: ${fw(ev.w)} × ${ev.r}, heaviest ever` : `🏆 Career high: ${ev.total} reps @ ${fw(ev.w)}, most ever`, { gold: true });
      }
    } else c.s.done = false;
    saveDraftNow(); rerenderCard(c.id);
  },
  'add-set'(el) { const dl = db.draft.lifts[el.dataset.id]; const last = dl.work[dl.work.length - 1] || { w: 0, r: 10 }; dl.work.push({ w: last.w, r: last.r, done: false }); saveDraftNow(); rerenderCard(el.dataset.id); },
  'remove-set'(el) { const dl = db.draft.lifts[el.dataset.id]; if (dl.work.length > dl.prescribed) dl.work.pop(); saveDraftNow(); rerenderCard(el.dataset.id); },
  skip(el) { const dl = db.draft.lifts[el.dataset.id]; dl.skipped = !dl.skipped; saveDraftNow(); rerenderCard(el.dataset.id); },
  async hold(el) {
    const id = el.dataset.id, lf = lift(id), dl = db.draft.lifts[id];
    if (!lf.hold) { lf.hold = { sets: deep(dl.target), since: todayStr() }; dl.held = true; toast('Held: this target repeats and misses don\'t count.'); }
    else {
      lf.hold = null; dl.held = false;
      await saveKV('routine'); recompute();
      const P = A.perLift[id];
      dl.target = deep(P.target.sets); dl.kind = P.target.kind;
      if (!workDone(dl)) dl.work = dl.target.map((s) => ({ w: s.w, r: s.r, done: false }));
      toast('Hold off. Progression resumes from your best.');
    }
    await saveKV('routine'); recompute(); saveDraftNow(); rerenderCard(id);
  },
  async 'sb-accept'(el) {
    const id = el.dataset.id, P = A.perLift[id];
    if (!P || !P.suggestion) return;
    db.events.push({ id: uid(), type: 'stepback', liftId: id, ts: Date.now(), date: todayStr(), sets: deep(P.suggestion.sets) });
    await saveKV('events'); recompute();
    if (db.draft && db.draft.lifts[id]) { syncDraft(); saveDraftNow(); }
    toast(`Stepped back. ${liftName(id)} target: ${fs(A.perLift[id].target.sets)}`);
    refreshCurrent();
  },
  async 'sb-dismiss'(el) {
    const id = el.dataset.id;
    db.events.push({ id: uid(), type: 'dismiss', liftId: id, ts: Date.now(), date: todayStr() });
    await saveKV('events'); recompute(); toast('Dismissed. It comes back after 3 more misses.'); refreshCurrent();
  },
  finish() {
    if (!draftHasDone() || !Object.values(db.draft.lifts).some((dl) => !dl.skipped && workDone(dl))) { toast('Mark at least one working set done first'); return; }
    const all = everyTargetHit();
    ui.fin = { clean: false, nearFailure: false, attempted: all, prefilled: all, tags: [], note: '' };
    openSheet(finishHTML(), 'finish');
  },
  'fin-check'(el) { ui.fin[el.dataset.k] = !ui.fin[el.dataset.k]; if (el.dataset.k === 'attempted') ui.fin.prefilled = false; reopenFinish(); },
  'fin-tag'(el) { toggleIn(ui.fin.tags, el.dataset.t, 99); reopenFinish(); },
  'save-session'() { saveSession(); },
  // report / history
  'open-report'(el) { openSheet(reportHTML(el.dataset.id, false), 'report'); },
  'edit-session'(el) { openSheet(editSessionHTML(el.dataset.id), 'edit'); },
  async 'delete-session'(el) {
    if (!(await confirmSheet('Delete this session?', 'Its scores, misses, and flags are removed and everything after it recalculates.', 'Delete', true))) return;
    await store.deleteSession(el.dataset.id);
    db.sessions = db.sessions.filter((s) => s.id !== el.dataset.id);
    recompute(); closeSheet(); render(); toast('Session deleted.');
  },
  'es-check'(el) { const s = ui.edit; s.effort[el.dataset.k] = !s.effort[el.dataset.k]; openSheet(editSessionHTML(s.id), 'edit'); },
  'es-tag'(el) { toggleIn(ui.edit.tags, el.dataset.t, 99); openSheet(editSessionHTML(ui.edit.id), 'edit'); },
  'es-done'(el) { const e = ui.edit.lifts[+el.dataset.li]; const s = e.work[+el.dataset.i]; s.done = !s.done; openSheet(editSessionHTML(ui.edit.id), 'edit'); },
  'es-status'(el) { const e = ui.edit.lifts[+el.dataset.li]; e.status = e.status === 'done' ? 'skipped' : 'done'; if (e.status === 'done' && !e.work.length) e.work = e.target.map((t) => ({ w: t.w, r: t.r, done: true })); openSheet(editSessionHTML(ui.edit.id), 'edit'); },
  async 'es-save'() { await saveEditedSession(); },
  'hist-mode'(el) { ui.hist.mode = el.dataset.m; render(); },
  'open-lift'(el) { ui.hist.liftId = el.dataset.id; render(); window.scrollTo(0, 0); },
  'close-lift'() { ui.hist.liftId = null; render(); },
  'trend-month'(el) { const cur = ui.trendsMonth || L.monthKey(todayStr()); const next = L.addMonths(cur, +el.dataset.d); if (next <= L.monthKey(todayStr())) { ui.trendsMonth = next; render(); } },
  // seasons
  'open-season-end'(el) { ui.nextFocus = null; openSheet(seasonEndHTML(+el.dataset.i, el.dataset.ro === '1'), 'season'); },
  'next-focus'(el) { toggleIn(ui.nextFocus, el.dataset.id, 5); const sh = $('#sheet'); const top = sh.scrollTop; const i = +$('[data-act="season-confirm"]').dataset.i; openSheet(seasonEndHTML(i), 'season'); sh.scrollTop = top; },
  async 'season-confirm'(el) {
    const i = +el.dataset.i;
    db.meta.focus = { ...(db.meta.focus || {}), [i + 1]: (ui.nextFocus || []).slice(0, 5) };
    db.meta.seasonsSeen = [...new Set([...(db.meta.seasonsSeen || []), ...A.seasons.map((s, j) => j).filter((j) => j <= i)])];
    ui.nextFocus = null;
    await saveKV('meta'); recompute(); closeSheet(); render(); launchChecks();
  },
  // review
  'mark-reviewed'() { markReviewed(true); },
  'go-editor'() { closeSheet(); ui.tab = 'settings'; ui.set = { page: 'days' }; render(); window.scrollTo(0, 0); },
  // settings
  'set-page'(el) { ui.set = { page: el.dataset.p || null, dayId: ui.set.dayId }; ui.focusSel = null; render(); window.scrollTo(0, 0); },
  'open-day'(el) { ui.set = { page: 'day', dayId: el.dataset.id }; render(); window.scrollTo(0, 0); },
  async 'day-move'(el) { moveIn(db.routine.days, db.routine.days.findIndex((d) => d.id === el.dataset.id), +el.dataset.d); await saveKV('routine'); render(); },
  async 'add-day'() { const id = `day-${Math.random().toString(36).slice(2, 7)}`; db.routine.days.push({ id, name: `Day ${db.routine.days.length + 1}`, liftIds: [] }); await saveKV('routine'); ui.set = { page: 'day', dayId: id }; render(); },
  async 'delete-day'(el) {
    if (!(await confirmSheet('Delete this day?', 'Its lifts stay in your history and can be added to another day.', 'Delete', true))) return;
    db.routine.days = db.routine.days.filter((d) => d.id !== el.dataset.id);
    if (db.draft && db.draft.dayId === el.dataset.id && !draftHasDone()) db.draft = null;
    await saveKV('routine'); await saveDraftNow(); ui.set = { page: 'days' }; render();
  },
  async 'lift-move'(el) { const d = dayById(ui.set.dayId); moveIn(d.liftIds, d.liftIds.indexOf(el.dataset.id), +el.dataset.d); await saveKV('routine'); render(); },
  async 'lift-remove'(el) { const d = dayById(ui.set.dayId); d.liftIds = d.liftIds.filter((x) => x !== el.dataset.id); await saveKV('routine'); recompute(); render(); toast('Removed from this day. History kept.'); },
  'new-lift'(el) { openLiftForm(null, el.dataset.day); render(); window.scrollTo(0, 0); },
  'edit-lift'(el) { const back = ui.tab === 'history' ? null : ui.set.page; openLiftForm(el.dataset.id, ui.set.dayId); ui.set.back = back === 'day' ? 'day' : back || 'lifts'; render(); window.scrollTo(0, 0); },
  'ef-toggle'(el) { ui.form[el.dataset.k] = !ui.form[el.dataset.k]; render(); },
  'ef-sets'(el) { const f = ui.form; const n = Math.max(1, Math.min(10, f.work.length + +el.dataset.d)); while (f.work.length < n) f.work.push({ ...f.work[f.work.length - 1] }); f.work.length = n; f.sets = n; render(); },
  'ef-ramp'(el) { const f = ui.form; const n = Math.max(0, Math.min(6, f.ramp.length + +el.dataset.d)); while (f.ramp.length < n) f.ramp.push({ w: '', r: 10 }); f.ramp.length = n; render(); },
  'ef-save'() { saveLiftForm(); },
  async 'ef-archive'() {
    const id = ui.form.id;
    if (!(await confirmSheet('Archive this lift?', 'It leaves every day. History, seasons, and trends keep it.', 'Archive', true))) return;
    lift(id).archived = true; db.routine.days.forEach((d) => { d.liftIds = d.liftIds.filter((x) => x !== id); });
    if (db.draft) delete db.draft.lifts[id];
    await saveKV('routine'); await saveDraftNow(); recompute(); ui.form = null; ui.set = { page: 'lifts' }; render(); toast('Archived.');
  },
  async 'ef-unarchive'() { lift(ui.form.id).archived = false; ui.form.archived = false; await saveKV('routine'); recompute(); render(); toast('Unarchived. Add it to a day in Days & rotation.'); },
  'focus-toggle'(el) { toggleIn(ui.focusSel, el.dataset.id, 5); render(); },
  async 'focus-save'() { db.meta.focus = { ...(db.meta.focus || {}), [seasonIdx()]: ui.focusSel.slice(0, 5) }; ui.focusSel = null; await saveKV('meta'); ui.set = { page: null }; render(); toast('Focus lifts saved.'); },
  async 'rules-save'() {
    const vals = {};
    document.querySelectorAll('[data-rule]').forEach((inp) => { vals[inp.dataset.rule] = num(inp.value); });
    const okInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!okInt(vals.seasonWeeks, 1, 52)) return toast('Season length: 1–52 weeks');
    if (!okInt(vals.numberWindow, 1, 50)) return toast('Number window: 1–50 sessions');
    if (!okInt(vals.behindAfter, 1, 20)) return toast('Behind after: 1–20 sessions');
    if (!(vals.effortSlipPoints > 0 && vals.effortSlipPoints <= 100)) return toast('Effort slip: 1–100 points');
    Object.assign(db.settings, vals);
    await saveKV('settings'); recompute(); ui.set = { page: null }; render(); toast('Rules saved.');
  },
  async 'rules-reset'() { ['seasonWeeks', 'numberWindow', 'behindAfter', 'effortSlipPoints', 'effortGate'].forEach((k) => { db.settings[k] = L.DEFAULT_SETTINGS[k]; }); await saveKV('settings'); recompute(); render(); toast('Defaults restored.'); },
  export() { exportBackup(); },
  import() { $('#import-file').click(); },
  async persist() { db.meta.persist = await store.requestPersist(); await saveKV('meta'); render(); toast(db.meta.persist === 'persistent' ? 'Storage is now persistent.' : 'The browser kept best-effort storage. Install to the home screen and back up regularly.'); },
  async erase() {
    if (!(await confirmSheet('Erase everything?', 'All sessions, settings, and your routine numbers on this device will be deleted. Export a backup first if you might want them.', 'Erase', true))) return;
    if (!(await confirmSheet('Are you sure?', 'This cannot be undone.', 'Erase all data', true))) return;
    await store.replaceAll({});
    location.reload();
  },
};
function toggleIn(arr, v, max) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else if (arr.length < max) arr.push(v); else toast(`Up to ${max}`); }
function moveIn(arr, i, d) { const j = i + d; if (i < 0 || j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; }
function reopenFinish() { const sh = $('#sheet'); const top = sh.scrollTop; const note = $('[data-fin-note]'); if (note) ui.fin.note = note.value; openSheet(finishHTML(), 'finish'); sh.scrollTop = top; }
function refreshCurrent() { if (ui.sheet === 'review') { const sh = $('#sheet'); const top = sh.scrollTop; openSheet(reviewHTML(true), 'review'); sh.scrollTop = top; } render(); }
async function markReviewed(close) {
  db.meta.lastReviewAt = todayStr(); await saveKV('meta');
  if (close) { if (ui.sheet === 'review') closeSheet(); if (ui.tab === 'review') ui.tab = 'today'; render(); toast('Review done. Next one in 2 weeks.'); }
}

// ---------------------------------------------------------------- edit a past session
function editSessionHTML(sid) {
  if (!ui.edit || ui.edit.id !== sid) ui.edit = deep(db.sessions.find((s) => s.id === sid));
  const s = ui.edit;
  const lifts = s.lifts.map((e, li) => `<div class="card tight"><div class="lift-h"><div class="lift-title">${esc(liftName(e.liftId))}</div>
      <button class="btn sm" data-act="es-status" data-li="${li}">${e.status === 'done' ? 'Mark skipped' : 'Mark done'}</button></div>
      <div class="lift-meta">Target was ${esc(fs(e.target))}${e.held ? ' (held)' : ''}</div>
      ${e.status === 'done' ? e.work.map((w, i) => `<div class="su-row" style="display:flex;gap:6px;align-items:center;margin-top:6px"><span class="muted small" style="width:40px">Set ${i + 1}</span>
        <input class="input small" inputmode="decimal" data-es="${li}" data-i="${i}" data-k="w" value="${esc(w.w ?? '')}" aria-label="Weight"> ×
        <input class="input small" inputmode="numeric" data-es="${li}" data-i="${i}" data-k="r" value="${esc(w.r ?? '')}" aria-label="Reps">
        <button class="btn sm ${w.done ? 'primary' : ''}" data-act="es-done" data-li="${li}" data-i="${i}" aria-pressed="${!!w.done}">${w.done ? '✓ done' : 'not done'}</button></div>`).join('') : '<p class="hint small">Skipped</p>'}</div>`).join('');
  const chk = (k, t) => `<button class="check ${s.effort[k] ? 'on' : ''}" data-act="es-check" data-k="${k}"><span class="box">✓</span><span>${t}</span><span class="yn">${s.effort[k] ? 'Yes' : 'No'}</span></button>`;
  return `<div class="sheet-h"><h2>Edit session</h2><button class="btn sm" data-act="close-sheet">Cancel</button></div>
    <div class="field"><label for="es-date">Date</label><input id="es-date" class="input" type="date" data-es-date value="${esc(s.date)}"></div>
    ${lifts}
    <h3>Effort</h3>${chk('clean', 'Clean reps, full ROM')}${chk('nearFailure', 'Last set within 2 reps of failure')}${chk('attempted', 'Attempted every target')}
    <h3>Context</h3><div class="chips">${L.TAGS.map((t) => `<button class="chip ${s.tags.includes(t) ? 'on' : ''}" data-act="es-tag" data-t="${t}">${esc(L.TAG_LABEL[t])}</button>`).join('')}</div>
    <div class="field"><textarea class="input" data-es-note aria-label="Note">${esc(s.note || '')}</textarea></div>
    <button class="btn primary big" data-act="es-save">Save changes</button>`;
}
async function saveEditedSession() {
  const s = ui.edit;
  document.querySelectorAll('[data-es]').forEach((inp) => { const e = s.lifts[+inp.dataset.es]; const w = e.work[+inp.dataset.i]; w[inp.dataset.k] = num(inp.value); });
  const dIn = $('[data-es-date]'); if (dIn && /^\d{4}-\d{2}-\d{2}$/.test(dIn.value)) s.date = dIn.value;
  const nIn = $('[data-es-note]'); if (nIn) s.note = nIn.value.trim();
  s.lifts.forEach((e) => { e.work = e.work.map((w) => ({ w: w.w, r: w.r, done: !!w.done && w.r > 0 && w.w !== null })); if (e.status === 'done' && !e.work.some((w) => w.done)) e.status = 'skipped'; });
  await store.putSession(s);
  const i = db.sessions.findIndex((x) => x.id === s.id); db.sessions[i] = s; sortSessions();
  ui.edit = null; recompute(); closeSheet(); render(); toast('Session updated. Everything after it recalculated.');
}

// ================================================================ input + change handlers
function onInput(e) {
  const t = e.target;
  if (t.matches('.set input.num')) {
    const c = rowCtx(t);
    const v = num(t.value);
    if (t.dataset.f === 'w') c.s.w = v; else c.s.r = v === null ? null : Math.round(v);
    saveDraftSoon();
    return;
  }
  if (t.dataset.su) {
    const v = ui.setup.v[t.dataset.su];
    if (t.dataset.f === 'ramp') v.ramp[+t.dataset.i] = t.value; else v[t.dataset.f] = t.value;
    saveSetupSoon();
    return;
  }
  if (t.hasAttribute('data-su-bw')) { ui.setup.bw = t.value; saveSetupSoon(); return; }
  if (t.dataset.ef && ui.form) { ui.form[t.dataset.ef] = t.value; return; }
  if (t.dataset.fw !== undefined && ui.form) { ui.form.work[+t.dataset.fw][t.dataset.k] = t.value; return; }
  if (t.dataset.fr !== undefined && ui.form) { ui.form.ramp[+t.dataset.fr][t.dataset.k] = t.value; return; }
  if (t.hasAttribute('data-fin-note') && ui.fin) { ui.fin.note = t.value; return; }
}
async function onChange(e) {
  const t = e.target;
  if (t.matches('.set input.num')) { const c = rowCtx(t); saveDraftNow(); patchCard(c.id); return; }
  if (t.id === 'import-file' && t.files && t.files[0]) { const f = t.files[0]; t.value = ''; importBackup(f); return; }
  if (t.dataset.ef === 'equipment' && ui.form) {
    const d = L.equipmentDefaults(t.value);
    Object.assign(ui.form, { equipment: t.value, repMin: d.repMin, repMax: d.repMax, increment: d.increment });
    render(); return;
  }
  if (t.dataset.setting === 'bodyweight') {
    const v = num(t.value);
    db.settings.bodyweight = v !== null && v > 0 ? v : null;
    await saveKV('settings'); recompute(); toast('Bodyweight saved.'); return;
  }
  if (t.dataset.dayname) { const d = dayById(t.dataset.dayname); d.name = t.value.trim() || d.name; await saveKV('routine'); return; }
  if (t.dataset.addExisting && t.value) {
    const d = dayById(t.dataset.addExisting); const lf = lift(t.value);
    lf.archived = false; if (!d.liftIds.includes(lf.id)) d.liftIds.push(lf.id);
    await saveKV('routine'); recompute(); render(); toast(`${lf.name} added to ${d.name}.`); return;
  }
}

// ================================================================ launch checks, SW, boot
/** Launch sequence: unseen season results first, then the two-week review if it's due. */
function launchChecks({ review = true } = {}) {
  if (!db.meta.setupDone || ui.sheet) return;
  const i = unseenSeasonEnd();
  if (i >= 0) { ui.nextFocus = null; openSheet(seasonEndHTML(i), 'season'); return; }
  if (review && L.reviewDue(db.meta, A.firstDate, todayStr(), A.settings.reviewDays)) {
    openSheet(`<div class="sheet-h"><div><div class="eyebrow">Every two weeks</div><h2>Team review</h2></div><button class="btn sm" data-act="close-sheet">Close</button></div>${reviewHTML(true)}`, 'review');
  }
}
async function loadState() {
  const data = await store.loadAll();
  db.settings = data.settings || {};
  db.routine = data.routine || defaultRoutine();
  db.sessions = data.sessions || [];
  db.events = data.events || [];
  db.meta = data.meta || {};
  db.draft = data.draft || null;
  db.meta.focus = db.meta.focus || {};
  db.meta.seasons = db.meta.seasons || [];
  db.meta.seasonsSeen = db.meta.seasonsSeen || [];
  sortSessions();
  if (!data.routine) await saveKV('routine');
}
// Service worker: listen first (before any await) so an update that activates early isn't missed.
let reloading = false;
const swState = { hadController: 'serviceWorker' in navigator && !!navigator.serviceWorker.controller, notified: false };
function onNewVersion() {
  if (!swState.hadController || reloading || swState.notified) return;
  if (performance.now() < 15000 && !draftHasDone()) { reloading = true; location.reload(); return; }
  swState.notified = true;
  toast('A new version is ready.', { action: 'Reload', fn: () => location.reload(), sticky: true });
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'sw-activated') onNewVersion(); });
  navigator.serviceWorker.addEventListener('controllerchange', onNewVersion);
  navigator.serviceWorker.startMessages();
}
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}
async function showVersion() {
  const el = document.getElementById('ver');
  if (!el || !self.caches) return;
  try { const k = (await caches.keys()).find((x) => x.startsWith('cbe-')); el.textContent = k ? k.replace('cbe-', '') : 'not cached yet'; } catch { el.textContent = 'unknown'; }
}
async function boot() {
  try { await loadState(); }
  catch (err) {
    $('#main').innerHTML = `<div class="card"><h2>Storage unavailable</h2><p class="hint">${esc(err.message || err)}</p><p class="hint">Private browsing can block storage. Open the app normally or from your home screen.</p></div>`;
    return;
  }
  recompute();
  render();
  launchChecks();
  registerSW();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve(fn(el, e)).catch((err) => toast(`Something went wrong: ${err.message || err}`));
  if (el.dataset.act === 'set-page' && el.dataset.p === 'about') setTimeout(showVersion, 0);
});
document.addEventListener('input', onInput);
document.addEventListener('change', (e) => { onChange(e).catch((err) => toast(`Something went wrong: ${err.message || err}`)); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input.num, .input')) e.target.blur(); });
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.chart-wrap')) return;
  document.querySelectorAll('.chart-wrap .tip').forEach((t) => { t.hidden = true; });
  document.querySelectorAll('.chart-wrap .cross').forEach((c) => c.setAttribute('visibility', 'hidden'));
});

boot();
