export const receiptSiteUrl = "www.lapped.fit";
export const receiptSiteHref = "https://www.lapped.fit";

export function formatReceiptLines({ lapCount, fastestLap, lifetimeLaps, ytdLaps, ytdYear, siteUrl = receiptSiteUrl }) {
  return [
    `laps: ${lapCount}`,
    fastestLap && `fastest lap: ${fastestLap}`,
    Number.isFinite(lifetimeLaps) && `lifetime laps: ${lifetimeLaps}`,
    Number.isFinite(ytdLaps) && Number.isFinite(ytdYear) && `${ytdYear} laps: ${ytdLaps}`,
    siteUrl
  ].filter(Boolean);
}

export function formatReceipt({ lapCount, fastestLap, lifetimeLaps, ytdLaps, ytdYear, siteUrl = receiptSiteUrl }) {
  return formatReceiptLines({ lapCount, fastestLap, lifetimeLaps, ytdLaps, ytdYear, siteUrl }).join("\n");
}

if (typeof document !== "undefined") {
  const example = document.querySelector("[data-description-example]");
  if (example) {
    const lines = formatReceiptLines({ lapCount: 14, fastestLap: "2:38 · 42.3 km/h", lifetimeLaps: 244, ytdLaps: 86, ytdYear: 2026 });
    example.replaceChildren(...lines.flatMap((line, index) => {
      const content = index === lines.length - 1
        ? Object.assign(document.createElement("a"), { href: receiptSiteHref, textContent: line })
        : Object.assign(document.createElement("span"), { textContent: line });
      return index === 0 ? [content] : [document.createElement("br"), content];
    }));
  }
}
