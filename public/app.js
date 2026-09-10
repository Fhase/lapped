import "./description-format.js";

const connect = document.querySelector("#connect"), connectForm = document.querySelector("#connect-form"), disconnect = document.querySelector("#disconnect");
const onboarding = document.querySelector("#onboarding"), connectedOverview = document.querySelector("#connected-overview"), descriptionExample = document.querySelector("#description-example"), athleteName = document.querySelector("#athlete-name");
const lapLink = document.querySelector("#lap-link");
const themeToggle = document.querySelector("#theme-toggle"), themeLabel = document.querySelector("#theme-label");

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
fetch("/api/status").then((r) => r.json()).then((data) => {
  if (!data.configured) { connect.textContent = "Configure .env first"; connect.disabled = true; return; }
  if (!data.connected) return;
  const name = [data.athlete?.firstname, data.athlete?.lastname].filter(Boolean).join(" ");
  athleteName.textContent = name || "Your laps";
  onboarding.hidden = true;
  connectedOverview.hidden = false;
  descriptionExample.hidden = true;
  lapLink.innerHTML = "see laps <span>↓</span>";
  lapLink.href = "/me";
  connectForm.hidden = true;
  disconnect.hidden = false;
}).catch(() => { connect.textContent = "Server unavailable"; connect.disabled = true; });
disconnect.onclick = async () => {
  disconnect.disabled = true;
  try { await fetch("/auth/disconnect", { method: "POST" }); } finally { location.reload(); }
};
const featureRequestForm = document.querySelector("#feature-request-form"), featureRequestStatus = document.querySelector("#feature-request-status");
featureRequestForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = featureRequestForm.querySelector("button"), request = new FormData(featureRequestForm).get("request")?.trim();
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
