import "./description-format.js";

const connect = document.querySelector("#connect"), disconnect = document.querySelector("#disconnect");
const onboarding = document.querySelector("#onboarding"), connectedOverview = document.querySelector("#connected-overview"), descriptionExample = document.querySelector("#description-example"), athleteName = document.querySelector("#athlete-name"), lapStatsValues = document.querySelector("#lap-stats-values"), lifetimeLaps = document.querySelector("#lifetime-laps"), ytdLaps = document.querySelector("#ytd-laps"), ytdLapsLabel = document.querySelector("#ytd-laps-label"), lifetimeLapStat = document.querySelector("#lifetime-lap-stat"), ytdLapStat = document.querySelector("#ytd-lap-stat");
const lapLink = document.querySelector("#lap-link");
const optionInputs = [...document.querySelectorAll("[data-receipt-option]")];
const themeToggle = document.querySelector("#theme-toggle"), themeLabel = document.querySelector("#theme-label");
let receiptOptions = null;

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.checked = theme === "light";
  themeLabel.textContent = `${theme[0].toUpperCase()}${theme.slice(1)} mode`;
}
function currentOptions() { return Object.fromEntries(optionInputs.map((input) => [input.name, input.checked])); }
function showSelectedStats() {
  const wantsLifetime = receiptOptions?.lifetimeLaps, wantsYtd = receiptOptions?.ytdLaps;
  lifetimeLapStat.hidden = !wantsLifetime;
  ytdLapStat.hidden = !wantsYtd;
  lapStatsValues.hidden = !wantsLifetime && !wantsYtd;
}
async function refreshLapStats() {
  showSelectedStats();
  if (!receiptOptions?.lifetimeLaps && !receiptOptions?.ytdLaps) return;
  try {
    const response = await fetch("/api/lap-stats");
    const stats = await response.json().catch(() => null);
    if (!stats?.available) {
      if (stats?.rateLimited && receiptOptions.ytdLaps) ytdLapsLabel.textContent = "Strava is refreshing";
      return;
    }
    if (receiptOptions.lifetimeLaps && Number.isFinite(stats.lifetime)) lifetimeLaps.textContent = stats.lifetime;
    if (receiptOptions.ytdLaps) {
      if (Number.isFinite(stats.ytd)) {
        ytdLaps.textContent = stats.ytd;
        ytdLapsLabel.textContent = `${stats.year} laps`;
      } else if (stats.rateLimited) ytdLapsLabel.textContent = "Strava is refreshing";
    }
  } catch (_) {}
}
function applyReceiptOptions(options) {
  receiptOptions = options;
  optionInputs.forEach((input) => { input.checked = Boolean(options[input.name]); });
  refreshLapStats();
}

const savedTheme = localStorage.getItem("lapped-theme");
setTheme(savedTheme === "dark" ? "dark" : "light");
themeToggle.onchange = () => {
  const theme = themeToggle.checked ? "light" : "dark";
  setTheme(theme);
  localStorage.setItem("lapped-theme", theme);
};
optionInputs.forEach((input) => input.addEventListener("change", async () => {
  const previous = receiptOptions, next = currentOptions();
  optionInputs.forEach((control) => { control.disabled = true; });
  try {
    const response = await fetch("/api/receipt-options", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    if (!response.ok) throw new Error("Could not save receipt preferences.");
    applyReceiptOptions(await response.json());
  } catch (_) {
    if (previous) applyReceiptOptions(previous);
  } finally {
    optionInputs.forEach((control) => { control.disabled = false; });
  }
}));
fetch("/api/status").then((r) => r.json()).then(async (data) => {
  if (!data.configured) { connect.textContent = "Configure .env first"; connect.removeAttribute("href"); return; }
  if (!data.connected) return;
  const name = [data.athlete?.firstname, data.athlete?.lastname].filter(Boolean).join(" ");
  athleteName.textContent = name || "Your laps";
  onboarding.hidden = true;
  connectedOverview.hidden = false;
  descriptionExample.hidden = true;
  lapLink.innerHTML = "see laps <span>↓</span>";
  connect.hidden = true;
  disconnect.hidden = false;
  try {
    const response = await fetch("/api/receipt-options");
    if (!response.ok) throw new Error("Could not load receipt preferences.");
    applyReceiptOptions(await response.json());
  } catch (_) {
    applyReceiptOptions({ lapCount: true, fastestLap: true, lifetimeLaps: false, ytdLaps: false });
  }
}).catch(() => { connect.textContent = "Server unavailable"; connect.removeAttribute("href"); });
disconnect.onclick = async () => {
  disconnect.disabled = true;
  try { await fetch("/auth/disconnect", { method: "POST" }); } finally { location.reload(); }
};
