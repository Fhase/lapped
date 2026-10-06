import { formatReceiptLines, receiptSiteHref } from "./description-format.js";

const fastest = document.querySelector("#show-fastest");
const link = document.querySelector("#show-link");
const preview = document.querySelector("#receipt-preview");
const savedState = document.querySelector("#saved-state");
const themeToggle = document.querySelector("#theme-toggle");
const themeLabel = document.querySelector("#theme-label");
let saveTimer;

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.checked = theme === "light";
  themeLabel.textContent = `${theme} mode`;
}
setTheme("light");
themeToggle.onchange = () => setTheme(themeToggle.checked ? "light" : "dark");

function preferences() {
  return { includeFastestLap: fastest.checked, includeLink: link.checked };
}

function renderPreview() {
  const lines = formatReceiptLines({ lapCount: 14, fastestLap: "2:38 · 42.3 km/h", preferences: preferences() });
  preview.replaceChildren(...lines.flatMap((line, index) => {
    const content = line === "www.lapped.fit"
      ? Object.assign(document.createElement("a"), { href: receiptSiteHref, textContent: line })
      : Object.assign(document.createElement("span"), { textContent: line });
    return index === 0 ? [content] : [document.createElement("br"), content];
  }));
}

async function save() {
  savedState.textContent = "Saving…";
  savedState.dataset.state = "";
  try {
    const response = await fetch("/api/description-preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferences: preferences() })
    });
    if (!response.ok) throw new Error();
    savedState.textContent = "Saved";
    savedState.dataset.state = "saved";
  } catch (_) {
    savedState.textContent = "Couldn’t save — try again.";
    savedState.dataset.state = "";
  }
}

function scheduleSave() {
  renderPreview();
  savedState.textContent = "Unsaved changes";
  savedState.dataset.state = "";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 350);
}

[fastest, link].forEach((input) => input.addEventListener("change", scheduleSave));

fetch("/api/description-preferences")
  .then((response) => response.ok ? response.json() : Promise.reject())
  .then(({ preferences: saved }) => {
    fastest.checked = saved.includeFastestLap !== false;
    link.checked = saved.includeLink !== false;
    renderPreview();
    savedState.textContent = "Saved";
    savedState.dataset.state = "saved";
  })
  .catch(() => { savedState.textContent = "Couldn’t load your settings."; renderPreview(); });

renderPreview();
