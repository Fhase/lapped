const form = document.querySelector("#kom-form");
const textarea = document.querySelector("#segments");
const button = form.querySelector('button[type="submit"]');
const generate = document.querySelector("#generate");
const status = document.querySelector("#status");
const results = document.querySelector("#results");
const list = document.querySelector("#result-list");
const checkedAt = document.querySelector("#checked-at");
const reportSummary = document.querySelector("#report-summary");
const historyStart = document.querySelector("#history-start");
const historyStatus = document.querySelector("#history-status");
const historyList = document.querySelector("#history-list");

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));

function resultMarkup(item) {
  if (!item.ok) return `<article class="failure">Segment ${escapeHtml(item.id)} · ${escapeHtml(item.error)}</article>`;
  const segment = item.segment;
  const tags = segment.reasons.map((reason) => `<span class="tag">${escapeHtml(reason)}</span>`).join("");
  const pr = segment.pr ? `${escapeHtml(segment.pr)}${segment.prSpeed ? ` · ${escapeHtml(segment.prSpeed)}` : ""}` : "—";
  return `<article class="result"><div class="score">${segment.score}<small>${escapeHtml(segment.band)}</small></div><div class="segment"><h2>${escapeHtml(segment.name)}</h2><a href="https://www.strava.com/segments/${encodeURIComponent(segment.id)}" target="_blank" rel="noreferrer">View on Strava</a><div class="tags">${tags}</div></div><div class="facts"><p><strong>${pr}</strong><span>your PR</span></p><p><strong>${segment.totalAttempts.toLocaleString()}</strong><span>recorded attempts</span></p><p><strong>${segment.athleteCount.toLocaleString()}</strong><span>riders</span></p><p><strong>${segment.distanceKm.toFixed(1)} km</strong><span>${segment.grade.toFixed(1)}% avg grade</span></p></div></article>`;
}

async function requestReport(path, payload, message) {
  button.disabled = true;
  generate.disabled = true;
  status.textContent = message;
  results.hidden = true;
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not check those segments.");
    list.innerHTML = data.report.map(resultMarkup).join("");
    const viable = data.report.filter((item) => item.ok && item.segment.score >= 45);
    reportSummary.textContent = viable.length
      ? `${viable.length} ${viable.length === 1 ? "segment stands" : "segments stand"} out as worth a closer look. Start with the highest signal, then verify the current leaderboard in Strava.`
      : "No quiet opportunity surfaced from this shortlist. Your recent segments are heavily ridden—paste a less obvious segment link to test it.";
    checkedAt.textContent = `${data.source ? `${data.source} · ` : ""}checked ${new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(data.checkedAt))}`;
    results.hidden = false;
    status.textContent = "";
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { status.textContent = error.message || "Could not check those segments."; }
  finally { button.disabled = false; generate.disabled = false; }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const segments = textarea.value.split(/\n|,/).map((value) => value.trim()).filter(Boolean);
  if (!segments.length) { status.textContent = "Add a segment link, or generate a report from your recent rides."; return; }
  requestReport("/api/kom/report", { segments }, "Checking your shortlist…");
});

generate.addEventListener("click", () => {
  requestReport("/api/kom/suggested", {}, "Reading your recent rides and building a shortlist…");
});

function renderHistory(data) {
  if (data.status === "idle") { historyStatus.textContent = "Not started."; return; }
  historyStatus.textContent = data.status === "ready"
    ? `${data.ridesScanned.toLocaleString()} rides scanned · ${data.candidates.length} ranked segments found.`
    : `${data.phase} · ${data.ridesScanned.toLocaleString()} of ${data.ridesFound.toLocaleString()} rides scanned. It will keep going in the background.`;
  historyStart.disabled = data.status !== "ready";
  historyStart.textContent = data.status === "ready" ? "Scan complete" : "Scanning…";
  historyList.innerHTML = data.candidates.slice(0, 10).map((item) => `<div class="history-row"><span>${escapeHtml(item.name)}</span><strong>#${item.rank.toLocaleString()}</strong></div>`).join("");
}

async function pollHistory() {
  try {
    const response = await fetch("/api/kom/history");
    if (!response.ok) return;
    const data = await response.json();
    renderHistory(data);
    if (["listing", "scanning"].includes(data.status)) setTimeout(pollHistory, 15000);
  } catch (_) {}
}

historyStart.addEventListener("click", async () => {
  historyStart.disabled = true;
  try {
    const response = await fetch("/api/kom/history/start", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not start the history scan.");
    renderHistory(data); pollHistory();
  } catch (error) { historyStatus.textContent = error.message; historyStart.disabled = false; }
});
pollHistory();
