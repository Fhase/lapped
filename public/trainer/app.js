// Indoor Trainer for the browser: the same Home, Ride, History and Settings as the Mac app.
import {
  averageTarget, clockText, currentStep, peakTarget, percentAt, rideStats, rideSummary, tcx, trainingStress,
  wattsAt, workoutNamed, workouts, zoneForPercent, zoneForWatts
} from "./core.js";
import { Chart, zoneColor } from "./chart.js";
import { Devices, roles } from "./devices.js";
import { RideStore } from "./store.js";

// ---------- Preferences (per browser) ----------
// These follow the rider: each change is also saved to their lapped account (see account below).
const syncedPrefs = ["ftp", "weightKg", "maxHeartRate", "riderName", "workoutFavorites", "appearance", "stravaAutoUpload"];
const prefs = {
  get(key, fallback) { try { const v = localStorage.getItem("trainer." + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  local(key, value) { try { value == null ? localStorage.removeItem("trainer." + key) : localStorage.setItem("trainer." + key, JSON.stringify(value)); } catch {} },
  set(key, value) { prefs.local(key, value); if (syncedPrefs.includes(key)) account.queuePref(key, value); }
};
const profile = {
  get ftp() { const v = prefs.get("ftp", 0); return v >= 1 && v <= 1000 ? v : null; },
  get weight() { return prefs.get("weightKg", 0); },
  get maxHeart() { return prefs.get("maxHeartRate", 0); },
  get name() { return prefs.get("riderName", ""); }
};
const favorites = () => new Set(prefs.get("workoutFavorites", []));

// ---------- Icons ----------
const icon = (name, cls = "") => {
  const paths = {
    home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    ride: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    play: '<path d="M7 4v16l13-8z"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    boltOff: '<path d="M13 2 9 7.5M7 10.5 4 14h7l-1 8 4-5.5M16 13.5 20 10h-7l.5-4"/><path d="m3 3 18 18"/>',
    radio: '<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6M5 21h14"/>',
    down: '<path d="M12 4v14M6 12l6 6 6-6M5 21h14"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    wave: '<path d="M2 12h3l2-6 3 12 3-9 2 6 2-3h5"/>',
    pip: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" class="f"/>',
    arrowUpRight: '<path d="M7 17 17 7M8 7h9v9"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    exit: '<path d="M14 4h6v6M20 4l-8 8M10 4H4v16h16v-6"/>'
  };
  const filled = ["play", "pause", "star"].includes(name) && cls.includes("fill");
  return `<svg class="icon ${filled ? "fill" : ""} ${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
};
const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const value = (v, size = "", cls = "") => v == null ? `<span class="dash" style="font-size:${Math.max(13, size * 0.32)}px">–</span>` : `<span class="num ${cls}">${esc(v)}</span>`;
const decimal = (n, digits) => n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const label = (text, color) => `<span class="label"${color ? ` style="color:${color}"` : ""}>${esc(text)}</span>`;
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- State ----------
const ui = {
  page: "home", workout: workouts.find((w) => w.id === "endurance60"), favoritesOnly: false, settingsSection: "rider",
  category: "All", sort: "default", listPage: 0,
  endStage: null, pendingDelete: null, finished: null, error: null, selectedRide: null, selectedSamples: [],
  showPower: true, showHeart: true, requestedErg: true
};
const model = {
  store: null, ride: null, running: false, awaitingPower: false, countdownEnd: null, countdown: null, ergAtStart: false,
  erg: false, liveSamples: [], history: [], power: null, heart: null, cadence: null, recentPower: [],
  nextSample: 0, lastTarget: null, notice: null, warning: null, writing: false
};
const strava = { connected: false, athlete: null, busy: false, status: null };
const devices = new Devices(() => { if (ui.page === "settings" && ui.settingsSection === "devices") renderSection(); refreshRideBar(); });
devices.onReading = () => tick();
// ERG command failed or was not confirmed: turn ERG off and say why, like the Mac app.
devices.onError = (message) => { model.erg = false; model.lastTarget = null; model.warning = message; render(); };

// ---------- Lapped account: settings and ride history saved per Strava athlete ----------
// Every change waits in a queue (in this browser) until lapped confirms it: settings, finished or
// updated rides, and deletes. The queue is retried at sign-in, when the connection returns, when the
// tab comes back, and every two minutes, so nothing is lost to a dropped connection or a closed tab.
const account = {
  id: null,
  flushing: null,
  async request(path, method = "GET", body) {
    const response = await fetch("/api/trainer" + path, {
      method, credentials: "same-origin",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw Object.assign(new Error(`lapped answered ${response.status}`), { status: response.status });
    return response.status === 204 ? null : response.json();
  },
  queue(key, update) { prefs.local(key, update(prefs.get(key, key === "pendingPrefs" ? {} : []))); },
  queuePref(key, value) { account.queue("pendingPrefs", (p) => ({ ...p, [key]: value ?? null })); account.flush(); },
  pushRide(ride) { account.queue("pendingRides", (ids) => [...ids.filter((id) => id !== ride.id), ride.id]); return account.flush(); },
  forget(id) {
    account.queue("pendingRides", (ids) => ids.filter((r) => r !== id));
    account.queue("pendingDeletes", (ids) => [...ids.filter((d) => d !== id), id]);
    return account.flush();
  },
  mine: (ride) => (ride.athlete ?? null) === account.id,
  /** Sends everything waiting. A 4xx other than 401/429 can never succeed (e.g. a ride deleted elsewhere), so it's dropped. */
  flush() {
    if (!account.id) return Promise.resolve();
    if (account.flushing) return account.flushing.then(() => account.flush());
    const done = (key, value) => account.queue(key, (list) => Array.isArray(list) ? list.filter((x) => x !== value) : list);
    const final = (error) => error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 429;
    account.flushing = (async () => {
      const sent = prefs.get("pendingPrefs", {});
      if (Object.keys(sent).length) {
        try {
          await account.request("/prefs", "PUT", sent);
          // Keep any setting changed again while this was in flight.
          account.queue("pendingPrefs", (now) => Object.fromEntries(Object.entries(now).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(sent[k]))));
        } catch (error) { if (final(error)) prefs.local("pendingPrefs", {}); }
      }
      for (const id of prefs.get("pendingDeletes", [])) {
        try { await account.request(`/rides/${id}`, "DELETE"); done("pendingDeletes", id); } catch (error) { if (final(error)) done("pendingDeletes", id); }
      }
      const rides = await model.store.rides();
      for (const id of prefs.get("pendingRides", [])) {
        const ride = rides.find((r) => r.id === id);
        if (!ride || ride.state !== "finished" || !account.mine(ride)) { done("pendingRides", id); continue; }
        try {
          const { athlete, remote, ...summary } = ride;
          const samples = await model.store.samples(ride);
          await account.request(`/rides/${id}`, "PUT", { ride: summary, samples: samples.map((s) => [s.time ?? null, s.power ?? null, s.heart ?? null]) });
          done("pendingRides", id);
        } catch (error) { if (final(error)) done("pendingRides", id); }
      }
    })().finally(() => { account.flushing = null; });
    return account.flushing;
  }
};
addEventListener("online", () => account.flush());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") account.flush(); });
setInterval(() => account.flush(), 120000);

/** Merges this browser with the rider's lapped account: their settings, then rides both ways. */
async function syncAccount() {
  const id = strava.athlete?.id ? String(strava.athlete.id) : null;
  if (!id) return;
  const owner = prefs.get("owner", null);
  // Rides recorded before accounts existed belong to whoever used this browser first.
  for (const ride of await model.store.rides()) if (!ride.athlete && (!owner || owner === id)) await model.store.update({ ...ride, athlete: id });
  if (owner && owner !== id) { prefs.local("pendingPrefs", {}); prefs.local("pendingRides", []); prefs.local("pendingDeletes", []); } // another rider's queue
  account.id = id;
  await account.flush();
  let data;
  try { data = await account.request("/data"); } catch { return; }
  const waiting = prefs.get("pendingPrefs", {});
  if (Object.keys(data.prefs).length) syncedPrefs.forEach((k) => { if (!(k in waiting)) prefs.local(k, data.prefs[k]); });
  else if (!owner || owner === id) {
    for (const k of syncedPrefs) if (prefs.get(k, null) != null) account.queue("pendingPrefs", (p) => ({ ...p, [k]: prefs.get(k, null) }));
  } else syncedPrefs.forEach((k) => prefs.local(k, null)); // another rider's settings stay off this account
  prefs.local("owner", id);
  const deleted = new Set(data.deleted), remote = new Set(data.rides.map((r) => r.id)), here = new Set();
  for (const ride of await model.store.rides()) {
    if (!account.mine(ride)) continue;
    here.add(ride.id);
    if (deleted.has(ride.id)) await model.store.remove(ride);
    else if (ride.state === "finished" && !remote.has(ride.id)) account.queue("pendingRides", (ids) => ids.includes(ride.id) ? ids : [...ids, ride.id]);
  }
  for (const ride of data.rides) if (!here.has(ride.id)) await model.store.update({ ...ride, athlete: id, remote: true });
  account.flush();
  applyTheme();
}

// ---------- Model ----------
async function refreshHistory() {
  const rides = (await model.store.rides()).filter(account.mine);
  model.history = rides.filter((r) => r.state === "finished").sort((a, b) => b.started - a.started);
}

async function startRide(workout) {
  if (model.ride) return;
  try {
    model.ride = await model.store.begin(workout, profile.ftp ?? 0, account.id);
    model.liveSamples = []; model.recentPower = []; model.warning = null; model.lastTarget = null;
    model.awaitingPower = true;
    model.ergAtStart = ui.requestedErg && devices.canControl && workout.id !== "free";
    navigate("ride");
  } catch (error) { showError("Could not start the ride. " + error.message); }
}

function setRunning(active) {
  model.running = active;
  model.awaitingPower = false; model.countdownEnd = null; model.countdown = null;
  if (active) model.nextSample = performance.now() + 1000;
  wakeLock(active);
}

async function pauseRide() {
  if (!model.ride || !model.running) return;
  setRunning(false);
  devices.stopControl();
  model.ride = { ...model.ride, state: "paused" };
  await model.store.update(model.ride).catch(storageFailed);
  render();
}

async function resumeRide() {
  if (!model.ride || model.running || model.awaitingPower || model.countdownEnd) return;
  model.ride = { ...model.ride, state: "running" };
  model.notice = null;
  try { await model.store.update(model.ride); } catch (error) { return storageFailed(error); }
  setRunning(true);
  model.lastTarget = null;
  sendTarget();
  render();
}

async function finishRide() {
  if (!model.ride) return;
  setRunning(false);
  devices.stopControl();
  model.erg = false;
  try { await completed(await model.store.finish(model.ride)); } catch (error) { storageFailed(error); }
}

async function completed(saved) {
  const samples = model.liveSamples.slice();
  model.ride = null; model.liveSamples = []; model.notice = null;
  await refreshHistory();
  ui.finished = { ride: saved, samples, stats: rideStats(saved, samples) };
  // Only the three FTP tests produce an estimate; it becomes the rider's FTP right away (Undo puts the old one back).
  const estimate = ui.finished.stats.ftpEstimate;
  if (estimate >= 1 && estimate <= 1000) { ui.finished.ftp = { from: profile.ftp, to: estimate, applied: true }; prefs.set("ftp", estimate); }
  account.pushRide(saved);
  ui.page = "home";
  render();
  if (strava.connected && prefs.get("stravaAutoUpload", false) && !strava.busy) uploadToStrava(saved, samples);
}

async function discardRide() {
  if (!model.ride) return;
  setRunning(false);
  devices.stopControl();
  model.erg = false;
  try {
    await model.store.remove(model.ride);
    model.ride = null; model.liveSamples = []; model.notice = null;
    ui.page = "home";
    await refreshHistory();
    render();
  } catch (error) { storageFailed(error); }
}

async function deleteSaved(ride) {
  try {
    await model.store.remove(ride);
    account.forget(ride.id);
    await refreshHistory();
    if (model.history[0]) await loadRide(model.history[0]); else ui.selectedRide = null;
    render();
  } catch (error) { showError("Could not delete the ride. " + error.message); }
}

function storageFailed(error) {
  setRunning(false);
  devices.stopControl();
  model.erg = false;
  model.warning = "Recording paused. Your last saved second is intact. " + (error?.message || "");
  render();
}

function targetWatts(ride) {
  const current = currentStep(ride.steps, ride.elapsed);
  if (!current) return null;
  const step = ride.steps[current.index];
  const watts = wattsAt(step, ride.ftp, step.seconds - current.remaining);
  // Ramps change every second; ERG follows in steps of at least 3 W.
  if (step.end != null && model.lastTarget != null && Math.abs(watts - model.lastTarget) < 3) return model.lastTarget;
  return watts;
}

function sendTarget() {
  if (!model.running || !model.erg || !model.ride) return;
  const watts = targetWatts(model.ride);
  if (watts == null || watts === model.lastTarget) return;
  model.lastTarget = watts;
  devices.setPower(watts);
}

function setErg(enabled) {
  if (enabled && !(devices.canControl && model.ride && currentStep(model.ride.steps, model.ride.elapsed))) return;
  model.erg = enabled;
  model.lastTarget = null;
  if (enabled) model.warning = null;
  if (enabled) sendTarget(); else devices.stopControl();
  refreshRideBar();
}

function updateReadings() {
  const now = performance.now();
  const raw = devices.power();
  if (raw != null) model.recentPower.push({ time: now, watts: raw });
  model.recentPower = model.recentPower.filter((p) => now - p.time <= 3000);
  // Power display and recording use a rolling three-second average, like the Mac app.
  model.power = model.recentPower.length ? Math.round(model.recentPower.reduce((t, p) => t + p.watts, 0) / model.recentPower.length) : null;
  model.heart = devices.heart();
  model.cadence = devices.cadence();
}

async function tick() {
  updateReadings();
  const now = performance.now();
  if (model.ride && model.awaitingPower && model.power != null) {
    model.awaitingPower = false;
    model.countdownEnd = now + 3000;
  }
  if (model.countdownEnd) {
    const left = Math.ceil((model.countdownEnd - now) / 1000);
    if (left > 0) model.countdown = left;
    else {
      setRunning(true);
      if (model.ergAtStart) { model.erg = true; model.lastTarget = null; sendTarget(); }
      model.ride = { ...model.ride, state: "running" };
      model.store.update(model.ride).catch(storageFailed);
      render();
    }
  }
  if (model.running && model.ride && now >= model.nextSample && !model.writing) {
    // One real observation per tick: a suspended tab cannot measure missed seconds.
    model.nextSample = Math.max(model.nextSample + 1000, now + 800);
    const ride = model.ride;
    const sample = { time: Date.now(), power: model.power, heart: model.heart };
    const advanced = { ...ride, elapsed: ride.elapsed + 1 };
    const finished = ride.steps.length > 0 && !currentStep(ride.steps, advanced.elapsed);
    model.writing = true;
    try {
      await model.store.append(ride, sample, false);
      model.liveSamples.push(sample);
      model.ride = advanced;
      if (finished) { await finishRide(); return; }
      sendTarget();
    } catch (error) { storageFailed(error); } finally { model.writing = false; }
  }
  live();
}

let lock = null;
async function wakeLock(on) {
  try {
    if (on && !lock && navigator.wakeLock) { lock = await navigator.wakeLock.request("screen"); lock.addEventListener("release", () => { lock = null; }); }
    if (!on && lock) { await lock.release(); lock = null; }
  } catch {}
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && model.running) wakeLock(true); });

// ---------- Strava ----------
async function loadStrava() {
  try {
    const me = await (await fetch("/api/trainer/me", { credentials: "same-origin" })).json();
    strava.connected = me.connected; strava.athlete = me.athlete;
  } catch { strava.connected = false; }
}

async function uploadToStrava(ride, samples) {
  if (strava.busy) return;
  strava.busy = true; strava.status = "Uploading to Strava…"; stravaChanged();
  const fail = (message) => { strava.status = message; strava.busy = false; stravaChanged(); };
  try {
    const query = new URLSearchParams({ name: ride.name.toLowerCase(), description: rideSummary(ride, samples), external_id: `indoortrainer-${ride.id}` });
    const response = await fetch(`/api/trainer/uploads?${query}`, {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/vnd.garmin.tcx+xml" }, body: tcx(ride, samples)
    });
    let upload = await response.json().catch(() => ({}));
    if (response.status === 401) { strava.connected = false; return fail("Connect with Strava again in Settings."); }
    if (!response.ok) return fail("Strava upload failed. " + (upload.message || upload.error || `Error ${response.status}`));
    strava.status = "Strava is processing the ride…"; stravaChanged();
    for (let attempt = 0; attempt < 30 && !upload.activity_id && !upload.error; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await fetch(`/api/trainer/uploads/${upload.id}`, { credentials: "same-origin" });
      upload = await poll.json().catch(() => ({}));
      if (!poll.ok) return fail("Strava upload failed. " + (upload.message || `Error ${poll.status}`));
    }
    if (upload.error) return fail(/duplicate/i.test(upload.error) ? "Strava upload failed. This ride is already on Strava. Delete it there first to reupload." : "Strava upload failed. " + String(upload.error).replace(/<[^>]*>/g, ""));
    if (!upload.activity_id) return fail("Strava is still processing the ride. Check Strava before retrying.");
    strava.lastActivity = upload.activity_id;
    await rememberUpload(ride, samples, upload.activity_id);
    await fetch(`/api/trainer/activities/${upload.activity_id}/mute`, { method: "PUT", credentials: "same-origin" }).catch(() => {});
    fail("Uploaded to Strava.");
  } catch (error) { fail("Strava upload failed. " + error.message); }
}

/** Marks the ride as on Strava, here and in the rider's lapped account, so its button hides or becomes Reupload. */
async function rememberUpload(ride, samples, activity) {
  const saved = { ...ride, stravaActivity: activity };
  await model.store.update(saved).catch(() => {});
  account.pushRide(saved);
  model.history = model.history.map((r) => r.id === ride.id ? saved : r);
  if (ui.finished?.ride.id === ride.id) ui.finished.ride = saved;
  if (ui.selectedRide?.id === ride.id) {
    ui.selectedRide = saved;
    for (const button of document.querySelectorAll('[data-act="upload"]')) button.innerHTML = `${icon("up")}Reupload to Strava`;
  }
}

/** Updates only the upload status and buttons, so the page and dialog don't rebuild (no flash, no replayed animation). */
function stravaChanged() {
  const area = document.querySelector("[data-strava-area]");
  if (area) area.innerHTML = completeStravaHtml();
  for (const button of document.querySelectorAll('[data-act="upload"]')) button.disabled = strava.busy;
  for (const caption of document.querySelectorAll("[data-strava-status]")) caption.textContent = strava.status ?? "";
  if (ui.page === "settings" && ui.settingsSection === "strava") renderSection();
}

// ---------- Rendering ----------
const app = document.getElementById("app");
let charts = [];
let rideView = null;
const keepCharts = (list) => { charts.forEach((c) => c.destroy()); charts = list; };

// Page changes and the theme switch animate with View Transitions where the browser has them.
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
function transition(update) {
  if (!document.startViewTransition || calm() || document.visibilityState !== "visible") return update();
  const view = document.startViewTransition(update);
  // A quick second click skips the first transition; that's expected, not an error.
  for (const step of [view.ready, view.finished, view.updateCallbackDone]) step.catch(() => {});
  return view;
}

function navigate(page) {
  if (page === "history" && !ui.selectedRide && model.history[0]) { loadRide(model.history[0]).then(render); }
  const changing = page !== ui.page;
  const update = () => { ui.page = page; render(); document.querySelector(".main")?.scrollTo(0, 0); };
  changing ? transition(update) : update();
}

let lastPage = null;
function render() {
  const onRide = ui.page === "ride" && model.ride;
  const sidebar = onRide ? "" : sidebarHtml();
  rideView = null;
  keepCharts([]);
  // The page fades in only when it changes; re-renders on the same page (star, tabs) stay still.
  const entering = ui.page !== lastPage; lastPage = ui.page;
  app.innerHTML = `${zoneGlowHtml()}${sidebar}<main class="main"><div class="page${entering ? " enter" : ""}">${noticesHtml()}${pageHtml()}</div></main>${onRide ? `<button class="key pip" data-act="mini" title="Mini player (⇧⌘M)" aria-label="Open mini player">${icon("pip")}</button>` : ""}<div id="overlay"></div><div id="dialog">${dialogHtml()}</div>`;
  mountCharts();
  overlayKey = null;
  live();
}

function sidebarHtml() {
  const nav = (page, name, ico) => `<button class="nav ${ui.page === page ? "on" : ""}" data-nav="${page}">${icon(ico)}<span>${name}</span></button>`;
  return `<nav class="sidebar"><div class="logo"></div>${nav("home", "Home", "home")}${model.ride ? nav("ride", "Ride", "ride") : ""}${nav("history", "History", "history")}${nav("settings", "Settings", "settings")}<div class="spacer"></div>${model.ride ? `<button class="live" data-nav="ride" title="Return to ride"><div class="top"><span class="bars"><i></i><i></i><i></i></span><span class="state"></span><span class="arrow">${icon("arrowUpRight")}</span></div><span class="num clock"></span><span class="name">${esc(model.ride.name)}</span>${model.ride.steps.length ? '<div class="progress"><i></i></div>' : ""}</button>` : ""}</nav>`;
}

function noticesHtml() {
  const list = [model.warning, model.notice, !devices.supported ? "Bluetooth sensors need Chrome or Edge (Mac, Windows, Android or Chromebook). Safari and iPhone can browse workouts and history only." : null].filter(Boolean);
  return list.map((n) => `<div class="notice">${esc(n)}</div>`).join("");
}

function pageHtml() {
  if (ui.page === "ride" && model.ride) return rideHtml();
  if (ui.page === "history") return historyHtml();
  if (ui.page === "settings") return settingsHtml();
  return homeHtml();
}

// Home
// Workout types in training order, each with the zone colour its sessions mostly live in.
const categories = [
  ["Test", "var(--accent)"], ["Recovery", "var(--z1)"], ["Endurance", "var(--z2)", "Endurance · Z2"], ["Tempo", "var(--z3)"],
  ["Sweet Spot", "var(--z3)"], ["Threshold", "var(--z4)"], ["VO₂ Max", "var(--z5)"], ["Anaerobic", "var(--z6)"], ["Sprint", "var(--z6)"]
];
const sorts = [["default", "Recommended"], ["short", "Shortest first"], ["long", "Longest first"], ["type", "By type"]];
const perPage = 10;

// Recommended order under All: one of each type first (so page one is a real mix), then the rest taking turns.
const featured = ["ftpTest", "recovery", "endurance60", "tempo2x20", "sweetSpot2x20", "threshold2x20", "vo2Max5x3", "tabata", "sprints"];
function variety(list) {
  const groups = categories.map(([c]) => list.filter((w) => w.category === c).sort((a, b) => featured.includes(b.id) - featured.includes(a.id)));
  const mixed = [];
  for (let i = 0; groups.some((g) => i < g.length); i++) for (const g of groups) if (g[i]) mixed.push(g[i]);
  return mixed;
}

/** The list after the Saved tab, type filter and sort; Free Ride stays first under All. */
function filteredWorkouts(favs) {
  let list = workouts.filter((w) => w.id !== "free" && (!ui.favoritesOnly || favs.has(w.name)) && (ui.category === "All" || w.category === ui.category));
  const order = (w) => categories.findIndex(([c]) => c === w.category);
  if (ui.sort === "default" && ui.category === "All") list = variety(list);
  if (ui.sort === "short") list = [...list].sort((a, b) => a.minutes - b.minutes);
  if (ui.sort === "long") list = [...list].sort((a, b) => b.minutes - a.minutes);
  if (ui.sort === "type") list = [...list].sort((a, b) => order(a) - order(b) || a.minutes - b.minutes);
  const free = workouts.find((w) => w.id === "free");
  return ui.category === "All" && (!ui.favoritesOnly || favs.has(free.name)) ? [free, ...list] : list;
}

function homeHtml() {
  const favs = favorites();
  const all = filteredWorkouts(favs);
  const pages = Math.max(1, Math.ceil(all.length / perPage));
  ui.listPage = Math.min(ui.listPage, pages - 1);
  const list = all.slice(ui.listPage * perPage, (ui.listPage + 1) * perPage);
  const tabs = ["All", "Saved"].map((t) => `<button class="${(t === "Saved") === ui.favoritesOnly ? "on" : ""}" data-act="tab" data-tab="${t}">${t}</button>`).join("");
  // Type filter as underlined text tabs, the same style as All / Saved.
  const tab = (id) => `<button class="${ui.category === id ? "on" : ""}" data-act="category" data-category="${esc(id)}" aria-pressed="${ui.category === id}">${esc(id)}</button>`;
  const types = [tab("All"), ...categories.map(([id]) => tab(id))].join("");
  const sort = `<label class="sort"><span class="sr">Sort</span><select data-act="sort" aria-label="Sort workouts">${sorts.map(([id, text]) => `<option value="${id}" ${ui.sort === id ? "selected" : ""}>${text}</option>`).join("")}</select></label>`;
  const pager = pages > 1 ? `<nav class="pager" aria-label="Workout pages"><button data-act="page" data-page="${ui.listPage - 1}" ${ui.listPage === 0 ? "disabled" : ""} aria-label="Previous page">${icon("back")}</button>${Array.from({ length: pages }, (_, i) => `<button class="${i === ui.listPage ? "on" : ""}" data-act="page" data-page="${i}" aria-label="Page ${i + 1}" ${i === ui.listPage ? 'aria-current="page"' : ""}>${i + 1}</button>`).join("")}<button data-act="page" data-page="${ui.listPage + 1}" ${ui.listPage === pages - 1 ? "disabled" : ""} aria-label="Next page">${icon("chevron")}</button></nav>` : "";
  const empty = ui.favoritesOnly ? "No saved sessions here. Star a session to keep it." : "No sessions of this type.";
  return `<div class="home-head"><h1 class="heading">Workouts</h1><div class="tabs">${tabs}</div></div>
    <div class="filters"><div class="tabs types" role="group" aria-label="Workout type">${types}</div>${sort}</div>
    <div class="split"><div class="list">${list.length ? "" : `<p class="muted" style="font-size:13px;margin:0">${empty}</p>`}${list.map((w) => rowHtml(w, favs)).join("")}${pager}</div>
    <div id="session">${sessionHtml()}</div></div>`;
}

function rowHtml(w, favs) {
  return `<button class="row ${w === ui.workout ? "on" : ""}" data-workout="${w.id}"><span class="text"><span class="title">${esc(w.name)}${favs.has(w.name) ? `<span class="star">${icon("star", "fill")}</span>` : ""}</span><span class="sub">${w.id === "free" ? "Open ride" : esc(w.category)}</span></span>${w.id === "free" ? `<span class="free">${icon("wave")}</span>` : `<span class="profile" data-chart-mini="${w.id}"></span>`}<span class="min num">${w.id === "free" ? "–" : w.minutes + "m"}</span></button>`;
}

function stat(name, v, unit) {
  return `<div class="stat">${label(name)}<div class="value">${value(v, 26)}${unit && v != null ? `<span class="unit">${unit}</span>` : ""}</div></div>`;
}

function sessionHtml() {
  const w = ui.workout, ftp = profile.ftp, fav = favorites().has(w.name);
  const ergButton = devices.canControl && w.id !== "free"
    ? `<button class="key" data-act="request-erg">${ui.requestedErg ? `<span style="color:var(--accent)">${icon("bolt", "fill")}</span>ERG On` : `<span class="muted">${icon("boltOff")}</span>ERG Off`}</button>` : "";
  const action = model.ride
    ? `<button class="key prominent" data-nav="ride">${icon("play", "fill")}Return to Ride</button>`
    : `<button class="key prominent" data-act="start">${icon("play", "fill")}Start Session</button>`;
  return `<div class="session"><div><div class="name"><h2>${esc(w.name)}</h2><button class="fav ${fav ? "on" : ""}" data-act="favorite" aria-label="${fav ? "Remove from saved" : "Save session"}">${icon("star", fav ? "fill" : "")}</button></div>
      <div class="meta">${w.id === "free" ? "Open duration" : `${esc(w.category)}  ·  ${w.minutes} min`}</div>${w.id !== "free" ? `<div class="summary">${esc(w.summary)}</div>` : ""}</div>
    ${w.id === "free" ? `<div class="summary" style="min-height:160px">${esc(w.summary)}</div>` : `<div style="height:200px" data-chart-session></div>
      <div style="display:flex;flex-direction:column;gap:6px">${label("Main set")}<div class="structure">${esc(w.structure)}</div></div>
      <div class="stats">${stat("Duration", w.minutes, "min")}${stat("Max target", ftp ? peakTarget(w.steps, ftp) : null, "W")}${stat("Est. TSS", trainingStress(w.steps), "")}${stat("Avg target", ftp ? averageTarget(w.steps, ftp) : null, "W")}</div>`}
    <div class="divider"></div>
    <div class="foot">${w.id !== "free" ? `<button class="ftp-link" data-act="edit-ftp" title="Edit FTP in Settings"><span class="k">FTP</span>${ftp ? `<span class="v num">${ftp} W</span>` : '<span class="set">Set in Settings</span>'}</button>` : ""}<span class="spacer"></span>${ergButton}${action}</div><div id="start-note"></div></div>`;
}

// Ride
function rideHtml() {
  const ride = model.ride, hasPlan = ride.steps.length > 0;
  const blur = ui.page === "ride" && overlayVisible() ? "blurred" : "unblurred";
  return `<div class="ride ${blur}" id="ride" style="display:flex;flex-direction:column;gap:14px">
    <div class="ride-head"><button class="back" data-nav="home">${icon("back")}Home</button><span class="sep"></span><h2>${esc(ride.name)}</h2></div>
    <div class="grid"><div class="top">
      <div class="col"><div class="l">${label("Power")}<span id="r-target-label">${label("Target")}</span></div><div class="n"><div class="line" id="r-power"></div></div><div class="track" id="r-band"><div class="rail"></div><div class="band"></div><div class="tick"></div></div></div>
      <div class="col"><div class="l"><span id="r-interval-label"></span></div><div class="n"><div class="line"><span class="num big" id="r-clock"></span><span class="num of" id="r-of"></span></div></div><div class="track" id="r-fill"><div class="rail"></div><div class="fill"></div></div></div>
    </div><div class="bottom" id="r-small"></div></div>
    <div class="workout"><div class="head">${label(hasPlan ? "Workout" : "Ride")}<span class="spacer"></span>${toggleHtml("Power", "var(--ink)", ui.showPower, "power")}${toggleHtml("Heart rate", "var(--heart)", ui.showHeart, "heart")}</div>
      <div data-chart-ride style="height:${chartHeight()}px"></div></div>
    <div class="bar" id="r-bar">${rideBarHtml()}</div></div>`;
}
const chartHeight = () => Math.max(115, Math.min(560, innerHeight - 500 - (model.warning ? 50 : 0) - (model.notice ? 50 : 0)));
const toggleHtml = (name, color, on, key) => `<button class="toggle ${on ? "on" : ""}" data-act="trace" data-trace="${key}" style="--c:${color}"><i></i>${name}</button>`;

function rideBarHtml() {
  const ride = model.ride;
  if (!ride) return "";
  const ergAvailable = devices.canControl || model.erg;
  return `<button class="seg" data-act="toggle-run" aria-label="${model.running ? "Pause" : "Resume"}"><span class="accent">${icon(model.running ? "pause" : "play", "fill")}</span>${model.running ? "Pause" : "Resume"}<span class="hint">Space</span></button><span class="div"></span>
    <button class="seg" data-act="end">End Ride</button>${ride.steps.length ? `<span class="div"></span><button class="seg" data-act="erg" ${ergAvailable ? "" : "disabled"} title="${ergAvailable ? "Let the trainer hold target power" : "Pair a trainer that supports power control"}"><span class="${model.erg ? "accent" : "muted"}">${icon(model.erg ? "bolt" : "boltOff", model.erg ? "fill" : "")}</span>${model.erg ? "ERG On" : "ERG Off"}</button>` : ""}
    <span class="div"></span><button class="seg" data-act="devices">${icon("radio")}Devices</button>`;
}
function refreshRideBar() {
  const bar = document.getElementById("r-bar");
  if (bar) bar.innerHTML = rideBarHtml();
}

function updateRide() {
  const ride = model.ride, el = (id) => document.getElementById(id);
  if (!ride || !el("r-power")) return;
  const current = currentStep(ride.steps, ride.elapsed);
  const step = current ? ride.steps[current.index] : null;
  const target = step ? wattsAt(step, ride.ftp, step.seconds - current.remaining) : null;
  const next = current ? ride.steps[current.index + 1] : null;
  el("r-target-label").style.visibility = target != null ? "visible" : "hidden";
  el("r-power").innerHTML = (model.power != null ? `<span class="num big">${model.power}</span><span class="w">W</span>` : '<span class="nopower">No power</span>') + (target != null ? `<span class="num target">${target}</span>` : "");
  const band = el("r-band");
  band.style.visibility = target != null ? "visible" : "hidden";
  if (target != null) {
    const width = band.clientWidth;
    const pos = (w) => Math.min(1, Math.max(0, (w / Math.max(1, target) - 0.6) / 0.8)) * width;
    const b = band.querySelector(".band");
    b.style.left = `${pos(target * 0.95)}px`; b.style.width = `${pos(target * 1.05) - pos(target * 0.95)}px`;
    const t = band.querySelector(".tick");
    t.style.display = model.power != null ? "block" : "none";
    if (model.power != null) t.style.left = `${pos(model.power)}px`;
  }
  el("r-interval-label").innerHTML = label(current ? `Interval ${current.index + 1} of ${ride.steps.length}` : "Ride time");
  el("r-clock").textContent = current ? clockText(current.remaining) : clockText(ride.elapsed);
  el("r-of").textContent = step ? `of ${clockText(step.seconds)}` : "";
  const fill = el("r-fill");
  fill.style.visibility = step ? "visible" : "hidden";
  if (step) {
    const f = fill.querySelector(".fill");
    f.style.width = `${(step.seconds - current.remaining) / Math.max(1, step.seconds) * 100}%`;
    f.style.background = zoneColor(zoneForPercent(percentAt(step, step.seconds - current.remaining)));
  }
  const small = (name, v, unit, detail) => `<div class="small">${label(name)}<div class="value">${value(v, 30)}${unit && v != null ? `<span class="unit">${unit}</span>` : ""}${detail ? `<span class="detail num">${detail}</span>` : ""}</div></div>`;
  const maxHeart = profile.maxHeart, weight = profile.weight;
  el("r-small").innerHTML = small("Heart rate", model.heart, "bpm", model.heart != null && maxHeart > 0 ? `${Math.floor(model.heart * 100 / maxHeart)}% max` : null)
    + small("Cadence", model.cadence, "rpm")
    + small("W/kg", weight > 0 && model.power != null ? decimal(model.power / weight, 1) : null, "")
    + (current ? small("Ride time", clockText(ride.elapsed), "") + small(next ? "Next interval" : "Final interval", next ? wattsAt(next, ride.ftp) : null, "W") : "");
  rideView?.set({ samples: model.liveSamples, cursor: ride.elapsed, live: model.running, showPower: ui.showPower, showHeart: ui.showHeart });
  refreshGlow();
}

function liveZone() {
  const ride = model.ride;
  if (!ride) return null;
  const zone = zoneForWatts(model.power, ride.ftp);
  if (zone) return zone;
  const current = currentStep(ride.steps, ride.elapsed);
  if (!current) return null;
  const step = ride.steps[current.index];
  return zoneForPercent(percentAt(step, step.seconds - current.remaining));
}

const grain = `<svg aria-hidden="true"><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#grain)"/></svg>`;
function zoneGlowHtml() { return ui.page === "ride" && model.ride ? `<div class="glow" id="glow"><div class="g"></div>${grain}</div>` : ""; }
let glowZone = null;
function refreshGlow() {
  const glow = document.querySelector("#glow .g");
  if (!glow) return;
  const zone = liveZone();
  if (zone === glowZone) return;
  glowZone = zone;
  const c = zone ? zoneColor(zone).replace("rgb(", "rgba(").replace(")", "") : null;
  glow.style.background = c ? `radial-gradient(ellipse at bottom, ${c},0.24) 0%, ${c},0.06) 35%, transparent 62%)` : "none";
}

// History
function historyHtml() {
  if (!model.history.length) return `<h1 class="heading">History</h1><div class="panel"><strong style="font-size:15px">No saved rides yet</strong><div><button class="key" data-nav="home">Browse sessions</button></div></div>`;
  const ride = ui.selectedRide;
  return `<h1 class="heading">History</h1>${ride ? detailsHtml(ride) : ""}<div class="panel"><strong style="font-size:15px">Saved rides</strong><div>${model.history.map((r) => `<button class="history-row ${ride?.id === r.id ? "on" : ""}" data-ride="${r.id}" style="width:100%"><span style="color:var(--accent);width:24px;display:grid;place-items:center">${icon("wave")}</span><span class="text"><span class="t">${esc(r.name)}</span><span class="d">${dateText(r.started)}</span></span><span class="num" style="font-size:14px">${clockText(r.elapsed)}</span><span class="muted" style="font-size:11px">${icon("chevron")}</span></button>`).join("")}</div></div>`;
}
const dateText = (ms) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

function detailsHtml(ride) {
  const samples = ui.selectedSamples;
  const stats = rideStats(ride, samples);
  const metric = (name, v, unit, color) => `<div class="metric"><span class="k">${name}</span><div class="value">${value(v, 34, "")}${unit && v != null ? `<span class="unit muted" style="font:400 11px var(--font)">${unit}</span>` : ""}</div></div>`.replace('class="num "', `class="num" style="color:${color || "var(--ink)"}"`);
  return `<div style="display:flex;flex-direction:column;gap:12px"><div class="panel">
    <div class="details-head"><div class="text"><h2>${esc(ride.name)}</h2><span class="muted">${dateText(ride.started)}</span></div>
      <button class="key" data-act="upload" ${strava.busy ? "disabled" : ""} title="${strava.connected ? "Upload this ride file with its stats" : "Connect Strava in Settings"}">${icon("up")}${!strava.connected ? "Connect Strava" : ride.stravaActivity ? "Reupload to Strava" : "Upload to Strava"}</button>
      <button class="key" data-act="export">${icon("down")}Export TCX</button>
      <button class="delete" data-act="delete-saved">${icon("trash")}Delete ride</button></div>
    <div style="display:flex;gap:16px">${toggleHtml("Power", "var(--ink)", ui.showPower, "power")}${toggleHtml("Heart rate", "var(--heart)", ui.showHeart, "heart")}</div>
    <span class="caption" data-strava-status>${esc(strava.status ?? "")}</span>
    <div style="height:170px" data-chart-history></div></div>
    <div class="metrics">${metric("Duration", clockText(ride.elapsed), "")}${metric("Avg power", ride.avgPower, "W", "var(--power)")}${metric("Avg heart rate", ride.avgHeart, "bpm")}</div>
    <div class="metrics">${metric("Est. distance", stats.distanceKm != null ? decimal(stats.distanceKm, 2) : null, "km")}${metric("Est. avg speed", stats.speed != null ? decimal(stats.speed, 1) : null, "km/h")}${metric("Elevation gain", "0", "m")}</div>
    <span class="caption">Distance and speed estimated from power · flat route</span></div>`;
}

async function loadRide(ride) {
  ui.selectedRide = ride;
  ui.selectedSamples = await model.store.samples(ride);
  // A ride saved from another browser: fetch its seconds once, then keep them here.
  if (ride.remote && !ui.selectedSamples.length) {
    try {
      const { samples } = await account.request(`/rides/${ride.id}/samples`);
      const rows = samples.map(([time, power, heart]) => ({ time, power, heart }));
      const local = { ...ride, remote: false };
      await model.store.put(local, rows);
      if (ui.selectedRide === ride) { ui.selectedRide = local; ui.selectedSamples = rows; }
    } catch {}
  }
}

// Settings
function settingsHtml() {
  const sections = [["rider", "Rider"], ["devices", "Devices"], ["strava", "Strava"]];
  const theme = prefs.get("appearance", "Dark");
  return `<h1 class="heading">Settings</h1><div class="settings"><div class="index">${sections.map(([id, name]) => `<button class="${ui.settingsSection === id ? "on" : ""}" data-section="${id}">${name}</button>`).join("")}
    <div class="theme">${["Dark", "Light"].map((t) => `<button class="${theme.toLowerCase() === t.toLowerCase() ? "on" : ""}" data-appearance="${t}" aria-label="${t} appearance">${t}</button>`).join("")}</div></div>
    <div class="section" id="section">${sectionHtml()}</div></div>`;
}

function sectionHtml() {
  if (ui.settingsSection === "devices") return devicesHtml();
  if (ui.settingsSection === "strava") return stravaHtml();
  const ftp = profile.ftp, weight = profile.weight;
  const field = (key, name, v, unit, max) => `<div class="field"><span class="k">${name}</span><label class="input" data-field="${key}"><input class="num" inputmode="decimal" placeholder="–" value="${v || ""}" data-profile="${key}" data-max="${max}" aria-label="${name} in ${unit}"><span class="u">${unit}</span></label><span class="err"></span></div>`;
  return `<div class="panel"><div class="fields">
    <div class="field"><span class="k">Name</span><label class="input"><input maxlength="40" placeholder="Your name" value="${esc(profile.name)}" data-profile="riderName"></label><span class="err"></span></div>
    ${field("ftp", "FTP", ftp, "W", 1000)}${field("weightKg", "Weight", weight ? decimal(weight, 1) : "", "kg", 200)}${field("maxHeartRate", "Max heart rate", profile.maxHeart, "bpm", 230)}</div>
    ${ftp && weight > 0 ? `<span class="num muted" style="font-size:13px">${decimal(ftp / weight, 2)} W/kg at FTP</span>` : ""}</div>`;
}

function devicesHtml() {
  if (!devices.supported) return `<div class="home-head"><span style="font:700 22px var(--font)">Devices</span></div><div class="panel"><strong>This browser can't use Bluetooth.</strong><span class="muted">Open lapped.fit/trainer in Chrome or Edge on a Mac, Windows PC, Chromebook or Android device to connect a trainer, power meter or heart-rate strap. Safari and iPhone don't support Web Bluetooth.</span></div>`;
  return `<div class="home-head"><span style="font:700 22px var(--font)">Devices</span></div><div class="panel">${label("Paired roles")}${roles.map((role) => {
    const link = devices.links[role.id];
    // Trainer Simulator on this Mac can't appear in the browser's Bluetooth list, so Pair offers it alongside.
    const choosing = ui.pairChoice === role.id && !link;
    return `<div class="device-row"><span class="role">${role.name}</span><span class="dn">${esc(devices.name(role.id))}</span>${link ? `<span class="st ${link.state === "live" ? "live" : ""}">${devices.label(role.id)}</span><button class="key" data-forget="${role.id}">Forget</button>` : choosing ? `<button class="key" data-pair-sim="${role.id}">Trainer Sim · This Mac</button><button class="key" data-pair-bt="${role.id}">Bluetooth device…</button>` : `<button class="key" data-pair="${role.id}">Pair</button>`}</div>`;
  }).join("")}</div><span class="caption">Pair opens your browser's Bluetooth list. Wake the sensor first (pedal, or wear the strap). A trainer that supports FTMS can hold ERG targets. Pairings last until you close this tab.</span>`;
}

function stravaHtml() {
  const name = strava.athlete ? `${strava.athlete.firstname} ${strava.athlete.lastname}`.trim() : "";
  return `<div class="panel"><div style="display:flex;align-items:center">${label("Strava")}<span style="flex:1"></span>${strava.busy ? '<span class="caption">Working…</span>' : ""}</div>
    ${strava.connected
      ? `<div style="display:flex;align-items:center"><span style="font:500 14px var(--font)">Connected to Strava${name ? ` as ${esc(name)}` : ""}</span><span style="flex:1"></span><a class="key" href="/" style="text-decoration:none">Manage on lapped.fit</a></div>
         <label class="check"><input type="checkbox" data-act="auto-upload" ${prefs.get("stravaAutoUpload", false) ? "checked" : ""}>Auto-upload finished rides</label>`
      : `<span class="muted" style="font:400 13px var(--font)">Rides upload through your lapped.fit Strava connection. By connecting you accept lapped's <a href="/terms.html">terms</a> and <a href="/privacy.html">privacy policy</a>.</span>
         <div><a class="key prominent" href="/trainer/connect?consent=yes" style="text-decoration:none">Connect with Strava</a></div>`}
    ${strava.status ? `<span class="caption">${esc(strava.status)}</span>` : ""}</div>`;
}
function renderSection() {
  const section = document.getElementById("section");
  if (section) section.innerHTML = sectionHtml();
}

// Dialogs
function dialogHtml() {
  if (ui.error) return `<div class="modal"><div class="dialog"><h3>Ride details</h3><p>${esc(ui.error)}</p><div style="display:flex;justify-content:flex-end"><button class="key prominent" data-act="close-error">OK</button></div></div></div>`;
  if (ui.pendingDelete) return confirmHtml("delete-saved-confirm", "cancel-delete");
  if (ui.endStage === "choose" && model.ride) {
    const stats = rideStats(model.ride, model.liveSamples);
    return `<div class="modal"><div class="dialog"><h3>End ride?</h3><div class="row3">${stat("Time", clockText(model.ride.elapsed), "")}${stat("Avg power", stats.averagePower, "W")}${stats.completion != null ? stat("Done", stats.completion, "%") : ""}</div>
      <div class="stack"><button class="key prominent wide" data-act="save">Save ride</button><button class="delete wide" data-act="confirm-discard" style="width:100%">Delete ride</button><button class="quiet" data-act="keep">Keep riding</button></div></div></div>`;
  }
  if (ui.endStage === "confirm" && model.ride) return confirmHtml("discard", "back-to-choose");
  if (ui.finished) return completeHtml();
  return "";
}
const confirmHtml = (yes, no) => `<div class="modal"><div class="dialog"><h3>Delete this ride?</h3><div class="stack"><button class="delete" data-act="${yes}" style="width:100%">Delete ride</button><button class="quiet" data-act="${no}">Cancel</button></div></div></div>`;

function completeHtml() {
  const { ride, stats } = ui.finished, ftp = profile.ftp;
  const s = (n, v, u) => stat(n, v, u);
  return `<div class="modal"><div class="dialog complete"><div style="display:flex;flex-direction:column;gap:4px">${label("Ride complete", "var(--accent)")}<h3 style="font-size:26px">${esc(ride.name)}</h3>${stats.completion != null ? `<span class="num muted" style="font-size:15px">${stats.completion}% completed</span>` : ""}</div>
    <div class="grid3">${s("Time", clockText(ride.elapsed), "")}${s("Distance", stats.distanceKm != null ? decimal(stats.distanceKm, 1) : null, "km")}${s("TSS", stats.stress, "")}${s("Avg power", stats.averagePower, "W")}${s("NP", stats.normalizedPower, "W")}${s("Max power", stats.maxPower, "W")}${s("Avg HR", stats.averageHeart, "bpm")}${s("Max HR", stats.maxHeart, "bpm")}${s("Energy", stats.kilojoules, "kJ")}</div>
    <div class="divider"></div><div data-strava-area style="display:contents">${completeStravaHtml()}</div></div></div>`;
}
function completeStravaHtml() {
  const auto = prefs.get("stravaAutoUpload", false);
  const status = strava.status ?? (strava.connected && auto ? "Uploading to Strava…" : null);
  // The button stays put so Done never moves: greyed out while uploading and once the ride is on Strava.
  const uploaded = Boolean(ui.finished.ride.stravaActivity);
  const f = ui.finished.ftp;
  const delta = f?.from ? f.to - f.from : 0;
  const change = !f ? "" : `<div class="ftp-change"><div><span class="label">FTP</span><div class="v num">${f.applied
    ? `${f.from ? `<span class="muted">${f.from}</span><span class="muted arrow">→</span>` : ""}${f.to} W${delta ? `<span class="d" style="color:${delta > 0 ? "var(--z2)" : "var(--heart)"}">${delta > 0 ? "+" : "−"}${Math.abs(delta)}</span>` : ""}`
    : `${f.from ?? "–"} W<span class="muted kept">kept</span>`}</div></div><button class="key" data-act="ftp-undo">${f.applied ? "Undo" : `Use ${f.to} W`}</button></div>`;
  return `${change}${status ? `<div class="status">${esc(status)}</div>` : ""}
    <div class="actions">${!strava.connected ? `<button class="key" data-act="connect-from-complete">Connect Strava</button>` : `<button class="key" data-act="upload-finished" ${strava.busy || uploaded ? "disabled" : ""}>${icon("up")}${uploaded ? "Uploaded" : "Upload to Strava"}</button>`}<button class="key prominent" data-act="done" style="width:120px;flex:none">Done</button></div>`;
}
function refreshDialog() { const d = document.getElementById("dialog"); if (d) d.innerHTML = dialogHtml(); }

// Overlays: waiting for power, 3-2-1 countdown and the pause symbol.
let overlayKey = null;
let shownOverlay = ""; // survives render(), which rebuilds the overlay host
// "Start pedaling", the countdown and the pause symbol only cover the ride page.
const overlayVisible = () => Boolean(ui.page === "ride" && model.ride && (model.awaitingPower || model.countdown != null || pausedVisible()));
const pausedVisible = () => ui.page === "ride" && model.ride && !model.running && !model.awaitingPower && model.countdown == null && !ui.endStage && !ui.finished && !ui.error;
function refreshOverlay() {
  const host = document.getElementById("overlay");
  if (!host) return;
  const key = !overlayVisible() ? "" : model.countdown != null ? `c${model.countdown}` : model.awaitingPower ? "wait" : "pause";
  if (key === overlayKey) return;
  // Already covered (next countdown number, or a page re-render): keep the blur and darkening steady.
  const continuing = Boolean(key && shownOverlay);
  overlayKey = key; shownOverlay = key;
  const ride = document.getElementById("ride");
  if (ride) ride.className = `ride ${key && ui.page === "ride" ? "blurred" : "unblurred"}${continuing ? " steady" : ""}`;
  if (!key) { host.innerHTML = ""; return; }
  const content = key === "wait" ? `<div class="waiting"><h3>Start pedaling</h3><p>The countdown starts when your power reads.</p></div>`
    : key === "pause" ? `<button class="paused" data-act="toggle-run" title="Resume" aria-label="Paused. Resume ride">${icon("pause", "fill")}</button>`
    : `<div class="count num">${model.countdown}</div>`;
  const cover = host.querySelector(".cover");
  if (cover) {
    cover.classList.toggle("fast", key === "pause");
    cover.lastElementChild.remove();
    cover.insertAdjacentHTML("beforeend", content); // only the number animates in
    return;
  }
  host.innerHTML = `<div class="cover pass ${key === "pause" ? "fast" : ""}${continuing ? " steady" : ""}"><div class="dim"></div>${content}</div>`;
}

// Mini player in a Document Picture-in-Picture window (Chrome and Edge).
let mini = null;
async function openMini() {
  if (!("documentPictureInPicture" in window) || !model.ride) return;
  if (mini) { mini.focus?.(); return; }
  const pip = await documentPictureInPicture.requestWindow({ width: 320, height: 150 });
  mini = pip;
  for (const sheet of document.querySelectorAll('link[rel="stylesheet"]')) {
    const link = pip.document.createElement("link"); link.rel = "stylesheet"; link.href = sheet.href; pip.document.head.append(link);
  }
  pip.document.documentElement.dataset.theme = "dark";
  pip.document.body.innerHTML = `<div class="mini-root"><div class="pw"><div class="mchart"></div><div style="display:flex;align-items:baseline;gap:4px"><span class="num" id="m-power" style="font-size:50px;line-height:.85"></span><span class="tiny" style="font-size:11px">W</span></div><div id="m-target" style="display:flex;align-items:baseline;gap:4px"></div></div><div class="right"><div class="cell"><span class="num" id="m-clock" style="font-size:30px"></span><span class="tiny" id="m-clock-l"></span></div><div class="pair"><div class="cell"><span class="num" id="m-heart" style="font-size:23px"></span><span class="tiny">bpm</span></div><div class="cell"><span class="num" id="m-cad" style="font-size:23px"></span><span class="tiny">rpm</span></div></div></div></div>`;
  const host = pip.document.querySelector(".mchart");
  mini.chart = model.ride.steps.length ? new MiniChart(host) : null;
  pip.addEventListener("pagehide", () => { mini?.chart?.destroy(); mini = null; });
  live();
}
class MiniChart extends Chart { constructor(host) { super(host, { steps: model.ride.steps, ftp: model.ride.ftp, cursor: model.ride.elapsed, live: model.running, miniature: true }); } }
function updateMini() {
  if (!mini || !model.ride) { if (mini && !model.ride) mini.close(); return; }
  const d = mini.document, ride = model.ride, current = currentStep(ride.steps, ride.elapsed), step = current ? ride.steps[current.index] : null;
  d.getElementById("m-power").textContent = model.power ?? "–";
  d.getElementById("m-target").innerHTML = step ? `<span class="tiny" style="font-weight:700;letter-spacing:.8px">TARGET</span><span class="num" style="font-size:24px">${wattsAt(step, ride.ftp, step.seconds - current.remaining)}</span><span class="tiny" style="font-size:11px">W</span>` : "";
  d.getElementById("m-clock").textContent = current ? clockText(current.remaining) : clockText(ride.elapsed);
  d.getElementById("m-clock-l").textContent = current ? "left" : "ride";
  d.getElementById("m-heart").textContent = model.heart ?? "–";
  d.getElementById("m-cad").textContent = model.cadence ?? "–";
  mini.chart?.set({ cursor: ride.elapsed, live: model.running });
}

// Per-tick updates that never rebuild the page.
function live() {
  if (ui.page === "ride") updateRide();
  const card = document.querySelector(".live");
  if (card && model.ride) {
    const zone = liveZone(), color = zone ? zoneColor(zone) : "var(--accent)", total = model.ride.steps.reduce((t, s) => t + s.seconds, 0);
    card.querySelector(".bars").className = `bars ${model.running && !reduceMotion() ? "on" : ""}`;
    card.querySelectorAll(".bars i").forEach((i) => { i.style.background = color; });
    card.querySelector(".state").textContent = model.running ? "RIDING" : "PAUSED";
    card.querySelector(".state").style.color = model.running ? "var(--ink)" : "var(--muted)";
    const clock = card.querySelector(".clock");
    clock.textContent = clockText(model.ride.elapsed); clock.style.color = model.running ? "var(--ink)" : "var(--muted)";
    const bar = card.querySelector(".progress i");
    if (bar) { bar.style.width = `${Math.min(100, model.ride.elapsed / total * 100)}%`; bar.style.background = color; }
  }
  refreshOverlay();
  updateMini();
}

function mountCharts() {
  const list = [];
  document.querySelectorAll("[data-chart-mini]").forEach((host) => list.push(new Chart(host, { steps: workouts.find((w) => w.id === host.dataset.chartMini).steps, miniature: true })));
  const session = document.querySelector("[data-chart-session]");
  if (session) list.push(new Chart(session, { steps: ui.workout.steps, ftp: profile.ftp ?? 0 }));
  const history = document.querySelector("[data-chart-history]");
  if (history && ui.selectedRide) list.push(new Chart(history, { steps: ui.selectedRide.steps, ftp: ui.selectedRide.ftp, samples: ui.selectedSamples, recordedOnly: true, showPower: ui.showPower, showHeart: ui.showHeart }));
  const ride = document.querySelector("[data-chart-ride]");
  if (ride && model.ride) {
    rideView = new Chart(ride, { steps: model.ride.steps, ftp: model.ride.ftp, samples: model.liveSamples, cursor: model.ride.elapsed, live: model.running, showPower: ui.showPower, showHeart: ui.showHeart });
    list.push(rideView);
  }
  charts = list;
}

function selectWorkout(workout) {
  ui.workout = workout;
  document.querySelectorAll(".row").forEach((row) => row.classList.toggle("on", row.dataset.workout === workout.id));
  charts = charts.filter((c) => { if (c.host.matches("[data-chart-session]")) { c.destroy(); return false; } return true; });
  document.getElementById("session").innerHTML = sessionHtml();
  document.querySelector("#session .session")?.classList.add("enter"); // fade only when a workout is picked
  const host = document.querySelector("[data-chart-session]");
  if (host) charts.push(new Chart(host, { steps: workout.steps, ftp: profile.ftp ?? 0 }));
  // On phones the session panel sits above the list.
  if (matchMedia("(max-width: 760px)").matches) document.querySelector(".main")?.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
}

function showError(message) { ui.error = message; refreshDialog(); }

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/vnd.garmin.tcx+xml" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Events ----------
app.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-nav],[data-act],[data-workout],[data-ride],[data-section],[data-appearance],[data-pair],[data-pair-sim],[data-pair-bt],[data-forget]");
  if (!target) return;
  const d = target.dataset;
  if (d.nav) return navigate(d.nav);
  if (d.workout) return selectWorkout(workouts.find((w) => w.id === d.workout));
  if (d.ride) { await loadRide(model.history.find((r) => r.id === d.ride)); return render(); }
  if (d.section) { ui.settingsSection = d.section; return render(); }
  if (d.appearance) {
    const root = document.documentElement;
    root.classList.add("theme-flip"); // plain quick fade
    const done = transition(() => { prefs.set("appearance", d.appearance); applyTheme(); render(); });
    const clear = () => root.classList.remove("theme-flip");
    (done?.finished ?? Promise.resolve()).then(clear, clear);
    return;
  }
  const bluetooth = async (role) => { try { await devices.pair(role); } catch (error) { if (!/cancel/i.test(error.message)) showError("Could not connect. " + error.message); } };
  if (d.pair) {
    // Checked within Chrome's click window, so the Bluetooth list still opens when the simulator isn't running.
    if (await devices.simulatorAvailable()) { ui.pairChoice = d.pair; return renderSection(); }
    await bluetooth(d.pair); return renderSection();
  }
  if (d.pairSim) { ui.pairChoice = null; try { await devices.connectSimulator(d.pairSim); } catch (error) { showError("Could not connect. " + error.message); } return renderSection(); }
  if (d.pairBt) { ui.pairChoice = null; await bluetooth(d.pairBt); return renderSection(); }
  if (d.forget) { devices.forget(d.forget); return renderSection(); }
  switch (d.act) {
    case "tab": ui.favoritesOnly = d.tab === "Saved"; ui.listPage = 0; return render();
    case "category": ui.category = d.category; ui.listPage = 0; return render();
    case "page": ui.listPage = Number(d.page); render(); return document.querySelector(".list")?.scrollIntoView({ block: "nearest" });
    case "favorite": {
      const favs = favorites();
      favs.has(ui.workout.name) ? favs.delete(ui.workout.name) : favs.add(ui.workout.name);
      prefs.set("workoutFavorites", [...favs]);
      return render();
    }
    case "edit-ftp": ui.settingsSection = "rider"; return navigate("settings");
    case "request-erg": ui.requestedErg = !ui.requestedErg; return selectWorkout(ui.workout);
    case "start": {
      // Before starting, the rider needs an FTP (for targets) and a power source (the countdown waits for power).
      const needFtp = ui.workout.id !== "free" && !profile.ftp;
      const needDevice = !devices.links.trainer && !devices.links.power;
      if (!needFtp && !needDevice) return startRide(ui.workout);
      const note = document.getElementById("start-note");
      note.className = "start-note";
      note.innerHTML = `<span>${needFtp && needDevice ? "Set your FTP and pair a trainer or power meter first." : needFtp ? "Set your FTP first so targets are in watts." : "Pair a trainer or power meter first."}</span>`
        + (needFtp ? '<button class="key" data-act="edit-ftp">Set FTP</button>' : "")
        + (needDevice ? `<button class="key" data-act="devices">${icon("radio")}Pair device</button>` : "");
      note.animate?.([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: reduceMotion() ? 0 : 180, easing: "ease-out" });
      return;
    }
    case "toggle-run": return model.running ? pauseRide() : resumeRide();
    case "end": ui.endStage = "choose"; refreshOverlay(); return refreshDialog();
    case "keep": ui.endStage = null; refreshDialog(); overlayKey = null; return live();
    case "confirm-discard": ui.endStage = "confirm"; return refreshDialog();
    case "back-to-choose": ui.endStage = "choose"; return refreshDialog();
    case "save": ui.endStage = null; return finishRide();
    case "discard": ui.endStage = null; return discardRide();
    case "erg": return setErg(!model.erg);
    case "devices": ui.settingsSection = "devices"; return navigate("settings");
    case "mini": return openMini();
    case "trace": ui[d.trace === "power" ? "showPower" : "showHeart"] = !ui[d.trace === "power" ? "showPower" : "showHeart"]; target.classList.toggle("on");
      return ui.page === "ride" ? updateRide() : render();
    case "upload": return strava.connected ? uploadToStrava(ui.selectedRide, ui.selectedSamples) : (ui.settingsSection = "strava", navigate("settings"));
    case "export": return download(`${ui.selectedRide.name} ${new Date(ui.selectedRide.started).toISOString().slice(0, 10)}.tcx`, tcx(ui.selectedRide, ui.selectedSamples));
    case "delete-saved": ui.pendingDelete = ui.selectedRide; return refreshDialog();
    case "delete-saved-confirm": { const ride = ui.pendingDelete; ui.pendingDelete = null; return deleteSaved(ride); }
    case "cancel-delete": ui.pendingDelete = null; return refreshDialog();
    case "close-error": ui.error = null; return refreshDialog();
    case "ftp-undo": {
      const f = ui.finished.ftp;
      f.applied = !f.applied;
      prefs.set("ftp", f.applied ? f.to : f.from);
      const area = document.querySelector("[data-strava-area]");
      if (area) area.innerHTML = completeStravaHtml(); // in place: no dialog replay
      return;
    }
    case "upload-finished": return uploadToStrava(ui.finished.ride, ui.finished.samples);
    case "connect-from-complete": ui.finished = null; ui.settingsSection = "strava"; return navigate("settings");
    case "done": ui.finished = null; strava.status = null; return refreshDialog();
  }
});

app.addEventListener("change", (event) => {
  if (event.target.dataset.act === "sort") { ui.sort = event.target.value; ui.listPage = 0; return render(); }
  if (event.target.dataset.act === "auto-upload") prefs.set("stravaAutoUpload", event.target.checked);
});

// Profile fields save when editing ends; only a too-high value is flagged.
app.addEventListener("focusout", (event) => {
  const input = event.target.closest("[data-profile]");
  if (!input) return;
  const key = input.dataset.profile, text = input.value.trim();
  if (key === "riderName") return prefs.set("riderName", text.slice(0, 40));
  const number = Number(text.replace(",", "."));
  const max = Number(input.dataset.max);
  const field = input.closest(".field");
  const tooHigh = number > max;
  field.querySelector(".input").classList.toggle("bad", tooHigh);
  field.querySelector(".err").textContent = tooHigh ? `Too high · max ${max.toLocaleString()} ${field.querySelector(".u").textContent}` : "";
  if (tooHigh || !text) return;
  if (key === "ftp" && Number.isInteger(number) && number >= 1) prefs.set("ftp", number);
  if (key === "weightKg" && number >= 20) prefs.set("weightKg", Math.round(number * 10) / 10);
  if (key === "maxHeartRate" && Number.isInteger(number) && number >= 100) prefs.set("maxHeartRate", number);
  renderSection();
});
app.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target.matches("[data-profile]")) event.target.blur(); });

document.addEventListener("keydown", (event) => {
  const typing = event.target.matches?.("input, textarea");
  if (event.key === "Escape") {
    if (ui.error) { ui.error = null; return refreshDialog(); }
    if (ui.pendingDelete) { ui.pendingDelete = null; return refreshDialog(); }
    if (ui.endStage) { ui.endStage = ui.endStage === "confirm" ? "choose" : null; refreshDialog(); overlayKey = null; return live(); }
    if (ui.finished) return;
    if (typing) return event.target.blur();
    if (ui.page !== "home") navigate("home");
    return;
  }
  if (typing) return;
  if (event.key === " " && ui.page === "ride" && model.ride && !ui.endStage && !ui.finished) {
    event.preventDefault();
    model.running ? pauseRide() : resumeRide();
  }
  if (event.key === "Enter" && ui.endStage === "choose") { ui.endStage = null; finishRide(); }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "m") { event.preventDefault(); openMini(); }
});

// A ride in progress is saved every second; warn before closing the tab mid-ride.
addEventListener("beforeunload", (event) => { if (model.running) event.preventDefault(); });
addEventListener("resize", () => { const c = document.querySelector("[data-chart-ride]"); if (c) c.style.height = `${chartHeight()}px`; });

function applyTheme() { document.documentElement.dataset.theme = prefs.get("appearance", "Dark").toLowerCase() === "light" ? "light" : "dark"; }

// ---------- Start ----------
(async function boot() {
  applyTheme();
  try { model.store = await RideStore.open(); } catch (error) {
    app.innerHTML = `<div class="unsupported"><h1 class="heading" style="font-size:28px">Can't open ride storage</h1><p class="muted">This browser blocked local storage (private windows often do). Open lapped.fit/trainer in a normal Chrome or Edge window.</p></div>`;
    return;
  }
  await loadStrava();
  await syncAccount();
  const rides = (await model.store.rides()).filter(account.mine);
  const unfinished = rides.filter((r) => r.state !== "finished").sort((a, b) => b.started - a.started)[0];
  if (unfinished) {
    model.ride = { ...unfinished, state: "paused" };
    model.liveSamples = await model.store.samples(unfinished);
    model.ride.elapsed = model.liveSamples.length;
    await model.store.update(model.ride);
    model.notice = "Recovered your ride in progress. It's paused: press Resume to keep going.";
  }
  await refreshHistory();
  if (["localhost", "127.0.0.1"].includes(location.hostname) && new URLSearchParams(location.search).has("simulate")) devices.simulate();
  if (new URLSearchParams(location.search).has("connected")) {
    history.replaceState(null, "", "/trainer/");
    if (strava.connected) { ui.page = "settings"; ui.settingsSection = "strava"; }
  }
  render();
  setInterval(tick, 200);
})();
