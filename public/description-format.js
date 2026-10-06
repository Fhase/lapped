export const receiptSiteUrl = "www.lapped.fit";
export const receiptSiteHref = "https://www.lapped.fit";
export const defaultDescriptionPreferences = Object.freeze({
  includeFastestLap: true,
  includeLink: true
});

export function normalizeDescriptionPreferences(value = {}) {
  const settings = value && typeof value === "object" ? value : {};
  return {
    includeFastestLap: settings.includeFastestLap !== false,
    includeLink: settings.includeLink !== false
  };
}

export function formatReceiptLines({ lapCount, fastestLap, siteUrl = receiptSiteUrl, preferences }) {
  const settings = normalizeDescriptionPreferences(preferences);
  return [
    `laps · ${lapCount}`,
    settings.includeFastestLap && fastestLap && `fastest lap · ${fastestLap}`,
    settings.includeLink && siteUrl
  ].filter(Boolean);
}

export function formatReceipt({ lapCount, fastestLap, siteUrl = receiptSiteUrl, preferences }) {
  return formatReceiptLines({ lapCount, fastestLap, siteUrl, preferences }).join("\n");
}

if (typeof document !== "undefined") {
  const example = document.querySelector("[data-description-example]");
  if (example) {
    const lines = formatReceiptLines({ lapCount: 14, fastestLap: "2:38 · 42.3 km/h" });
    example.replaceChildren(...lines.flatMap((line, index) => {
      const content = index === lines.length - 1
        ? Object.assign(document.createElement("a"), { href: receiptSiteHref, textContent: line })
        : Object.assign(document.createElement("span"), { textContent: line });
      return index === 0 ? [content] : [document.createElement("br"), content];
    }));
  }
}
