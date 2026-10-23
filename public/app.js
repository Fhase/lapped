import "./description-format.js";

const connect = document.querySelector("#connect"), disconnect = document.querySelector("#disconnect");
const onboarding = document.querySelector("#onboarding"), connectedOverview = document.querySelector("#connected-overview"), descriptionExample = document.querySelector("#description-example"), athleteName = document.querySelector("#athlete-name");
const connectedStatus = document.querySelector(".connected-status");
const lifetimeLaps = document.querySelector("#lifetime-laps"), ytdLaps = document.querySelector("#ytd-laps"), fastestLap = document.querySelector("#fastest-lap"), fastestSpeed = document.querySelector("#fastest-speed"), lifetimeKm = document.querySelector("#lifetime-km"), ytdKm = document.querySelector("#ytd-km"), ytdLabel = document.querySelector("#ytd-label"), lapStatsStatus = document.querySelector("#lap-stats-status");
const formatKm = (laps, partial = false) => `${Math.round(Number(laps) * 1.85).toLocaleString()}${partial ? "+" : ""} km`;
const lapLink = document.querySelector("#lap-link");
const themeToggle = document.querySelector("#theme-toggle"), themeLabel = document.querySelector("#theme-label");
const connectForm = document.querySelector("#connect-form"), consentBox = document.querySelector("#consent-box"), privacyConsent = document.querySelector("#privacy-consent");

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.checked = theme === "light";
  themeLabel.textContent = `${theme} mode`;
}
setTheme("light");
themeToggle.onchange = () => {
  const theme = themeToggle.checked ? "light" : "dark";
  setTheme(theme);
};
privacyConsent?.addEventListener("change", () => { connect.disabled = !privacyConsent.checked; });
connectForm?.addEventListener("submit", (event) => {
  if (!privacyConsent?.checked) event.preventDefault();
});
fetch("/api/status").then((r) => r.json()).then((data) => {
  if (!data.configured) { connect.textContent = "Configure .env first"; connect.disabled = true; return; }
  const localPreview = location.hostname === "localhost" && new URLSearchParams(location.search).has("preview-stats");
  if (!data.connected && !localPreview) return;
  const athlete = localPreview ? { firstname: "Example", lastname: "Rider" } : data.athlete;
  const name = [athlete?.firstname, athlete?.lastname].filter(Boolean).join(" ");
  athleteName.textContent = name || "Your laps";
  onboarding.hidden = true;
  connectedOverview.hidden = false;
  descriptionExample.hidden = true;
  lapLink.hidden = true;
  connectForm.hidden = true;
  consentBox.hidden = true;
  disconnect.hidden = false;
  connectedStatus.hidden = false;
  connectedOverview.classList.add("stats-loading");
  [lifetimeLaps, ytdLaps, fastestLap].forEach((element) => element.classList.add("stat-loading"));
  if (localPreview) {
    disconnect.hidden = true;
    lifetimeLaps.textContent = "2,043";
    ytdLaps.textContent = "756";
    fastestLap.textContent = "2:38";
    fastestSpeed.textContent = "42.3 km/h";
    lifetimeKm.textContent = formatKm(2043);
    ytdKm.textContent = formatKm(756);
    lapStatsStatus.textContent = "staging preview · example stats";
    [lifetimeLaps, ytdLaps, fastestLap].forEach((element) => element.classList.remove("stat-loading"));
    connectedOverview.classList.remove("stats-loading");
    return;
  }
  fetch("/api/lap-stats").then((response) => response.ok ? response.json() : Promise.reject()).then((stats) => {
    ytdLabel.textContent = `${stats.year} laps`;
    if (stats.lifetime !== null) {
      lifetimeLaps.textContent = Number(stats.lifetime).toLocaleString();
      lifetimeKm.textContent = formatKm(stats.lifetime);
      lifetimeLaps.classList.remove("stat-loading");
    }
    if (stats.fastestLap) {
      const [time, speed] = String(stats.fastestLap).split(" · ");
      fastestLap.textContent = time || "—";
      fastestSpeed.textContent = speed || "—";
      fastestLap.classList.remove("stat-loading");
    }
    if (stats.status !== "ready") {
      if (stats.ytdPartial !== null) {
        if (Number(stats.ytdPartial) > 0) {
          ytdLaps.textContent = `${Number(stats.ytdPartial).toLocaleString()}+`;
          ytdKm.textContent = formatKm(stats.ytdPartial, true);
        } else {
          ytdLaps.textContent = "—";
          ytdKm.textContent = "—";
        }
      }
      lapStatsStatus.textContent = "Your lap stats are loading slowly in the background. Come back in a while.";
      return;
    }
    connectedOverview.classList.remove("stats-loading");
    lifetimeLaps.textContent = stats.lifetime ?? "—";
    ytdLaps.textContent = stats.ytd === null ? "—" : Number(stats.ytd).toLocaleString();
    ytdKm.textContent = stats.ytd === null ? "—" : formatKm(stats.ytd);
    ytdLaps.classList.remove("stat-loading");
    lifetimeLaps.classList.remove("stat-loading");
    fastestLap.classList.remove("stat-loading");
    fastestLap.textContent = stats.fastestLap ? String(stats.fastestLap).split(" · ")[0] : "—";
    fastestSpeed.textContent = stats.fastestLap ? (String(stats.fastestLap).split(" · ")[1] || "—") : "—";
    lapStatsStatus.textContent = "Updated from your private Strava segment history.";
  }).catch(() => { [lifetimeLaps, ytdLaps, fastestLap].forEach((element) => element.classList.remove("stat-loading")); connectedOverview.classList.remove("stats-loading"); lapStatsStatus.textContent = "Lap stats are unavailable right now. Come back in a while."; });
}).catch(() => { connect.textContent = "Server unavailable"; connect.removeAttribute("href"); });
disconnect.onclick = async () => {
  disconnect.disabled = true;
  try { await fetch("/auth/disconnect", { method: "POST" }); } finally { location.reload(); }
};
const featureRequestForm = document.querySelector("#feature-request-form"), featureRequestStatus = document.querySelector("#feature-request-status");
featureRequestForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = featureRequestForm.querySelector("button"), formData = new FormData(featureRequestForm), request = formData.get("request")?.trim();
  if (!request) return;
  button.disabled = true;
  try {
    const response = await fetch("/api/feature-requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request }) });
    if (!response.ok) throw new Error("Could not send request.");
    featureRequestForm.reset();
    featureRequestStatus.textContent = "Thanks for submitting your request.";
  } catch (_) { featureRequestStatus.textContent = "Could not submit right now. Try again shortly."; }
  finally { button.disabled = false; }
});
