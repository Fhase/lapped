const status = document.querySelector("#status"), connect = document.querySelector("#connect"), disconnect = document.querySelector("#disconnect");
const themeToggle = document.querySelector("#theme-toggle"), themeLabel = document.querySelector("#theme-label");
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.checked = theme === "light";
  themeLabel.textContent = `${theme[0].toUpperCase()}${theme.slice(1)} mode`;
}
const savedTheme = localStorage.getItem("lapped-theme");
setTheme(savedTheme === "light" ? "light" : "dark");
themeToggle.onchange = () => {
  const theme = themeToggle.checked ? "light" : "dark";
  setTheme(theme);
  localStorage.setItem("lapped-theme", theme);
};
fetch("/api/status").then(r => r.json()).then(data => {
  if (!data.configured) { status.textContent = "Setup needed"; connect.textContent = "Configure .env first"; connect.removeAttribute("href"); return; }
  if (data.connected) { status.textContent = "Strava connected"; connect.hidden = true; disconnect.hidden = false; }
  else status.textContent = "Ready to connect";
}).catch(() => status.textContent = "Server unavailable");
disconnect.onclick = async () => { await fetch("/auth/disconnect", { method: "POST" }); location.reload(); };
