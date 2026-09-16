const form = document.querySelector("#kom-form");
const textarea = document.querySelector("#segments");
const button = form.querySelector('button[type="submit"]');
const generate = document.querySelector("#generate");
const status = document.querySelector("#status");
const results = document.querySelector("#results");
const list = document.querySelector("#result-list");
const checkedAt = document.querySelector("#checked-at");

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
