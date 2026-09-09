import "./description-format.js";

const connect = document.querySelector("#connect"), disconnect = document.querySelector("#disconnect");
const onboarding = document.querySelector("#onboarding"), connectedOverview = document.querySelector("#connected-overview"), descriptionExample = document.querySelector("#description-example"), athleteName = document.querySelector("#athlete-name");
const lapLink = document.querySelector("#lap-link");
const themeToggle = document.querySelector("#theme-toggle"), themeLabel = document.querySelector("#theme-label");

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.checked = theme === "light";
  themeLabel.textContent = `${theme} mode`;
}
const savedTheme = localStorage.getItem("lapped-theme");
setTheme(savedTheme === "dark" ? "dark" : "light");
themeToggle.onchange = () => {
  const theme = themeToggle.checked ? "light" : "dark";
  setTheme(theme);
  localStorage.setItem("lapped-theme", theme);
};
fetch("/api/status").then((r) => r.json()).then((data) => {
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
}).catch(() => { connect.textContent = "Server unavailable"; connect.removeAttribute("href"); });
disconnect.onclick = async () => {
  disconnect.disabled = true;
  try { await fetch("/auth/disconnect", { method: "POST" }); } finally { location.reload(); }
};
