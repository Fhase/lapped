const themeToggle = document.querySelector("#theme-toggle"), themeLabel = document.querySelector("#theme-label");
function setTheme(theme) { document.documentElement.dataset.theme = theme; themeToggle.checked = theme === "light"; themeLabel.textContent = `${theme} mode`; }
setTheme("light");
themeToggle.onchange = () => setTheme(themeToggle.checked ? "light" : "dark");

const name = document.querySelector("#name"), stats = document.querySelector("#stats"), lifetime = document.querySelector("#lifetime"), lifetimeKm = document.querySelector("#lifetime-km"), ytd = document.querySelector("#ytd"), ytdKm = document.querySelector("#ytd-km"), ytdLabel = document.querySelector("#ytd-label"), sinceJoining = document.querySelector("#since-joining"), sinceJoiningKm = document.querySelector("#since-joining-km"), fastest = document.querySelector("#fastest"), action = document.querySelector("#ytd-action"), loadYtd = document.querySelector("#load-ytd"), status = document.querySelector("#status"), error = document.querySelector("#error");
const kilometres = (laps) => Number.isFinite(Number(laps)) ? `${Math.round(Number(laps) * 1.85).toLocaleString()} km` : "— km";
async function load(includeYtd = false) {
  error.textContent = "";
  if (includeYtd) { loadYtd.disabled = true; status.textContent = "Checking your year-to-date laps…"; }
  try {
    const response = await fetch(`/api/me/stats${includeYtd ? "?ytd=1" : ""}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load your laps.");
    const athleteName = [data.athlete?.firstname, data.athlete?.lastname].filter(Boolean).join(" ");
    name.textContent = athleteName ? `${athleteName}’s laps.` : "My laps.";
    lifetime.textContent = data.lifetime ?? "—";
    lifetimeKm.textContent = kilometres(data.lifetime);
    ytdLabel.textContent = `${data.year} laps`;
    sinceJoining.textContent = data.sinceJoining ?? "—";
    sinceJoiningKm.textContent = kilometres(data.sinceJoining);
    fastest.textContent = data.fastestSinceJoining || "—";
    stats.hidden = false;
    action.hidden = false;
    if (data.ytdReady) { ytd.textContent = data.ytd ?? "—"; ytdKm.textContent = kilometres(data.ytd); loadYtd.hidden = true; status.textContent = ""; }
    else if (data.retryAt) { status.textContent = "Strava is rate-limiting requests. Try again shortly."; }
    else if (!includeYtd) status.textContent = "Year-to-date is loaded only when you ask, to conserve Strava API requests.";
  } catch (requestError) { error.textContent = requestError.message; }
  finally { loadYtd.disabled = false; }
}
load();
loadYtd.onclick = () => load(true);
