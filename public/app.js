const status = document.querySelector("#status"), connect = document.querySelector("#connect"), disconnect = document.querySelector("#disconnect");
const themeToggle = document.querySelector("#theme-toggle");
const savedTheme = localStorage.getItem("lapped-theme");
if (savedTheme === "light") { document.documentElement.dataset.theme = "light"; themeToggle.checked = true; }
themeToggle.onchange = () => {
  const theme = themeToggle.checked ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("lapped-theme", theme);
};
fetch("/api/status").then(r => r.json()).then(data => {
  if (!data.configured) { status.textContent = "Setup needed"; connect.textContent = "Configure .env first"; connect.removeAttribute("href"); return; }
  if (data.connected) { status.textContent = "Strava connected"; connect.hidden = true; disconnect.hidden = false; }
  else status.textContent = "Ready to connect";
}).catch(() => status.textContent = "Server unavailable");
disconnect.onclick = async () => { await fetch("/auth/disconnect", { method: "POST" }); location.reload(); };
