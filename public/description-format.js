export const receiptSiteUrl = "www.lapped.fit";
export const receiptSiteHref = "https://www.lapped.fit";

export function formatReceiptLines({ lapCount, fastestLap, lifetimeLaps, ytdLaps, ytdYear, options = {}, siteUrl = receiptSiteUrl }) {
  const lines = [
    options.lapCount !== false && Number.isFinite(lapCount) && `laps: ${lapCount}`,
    options.fastestLap !== false && fastestLap && `fastest lap: ${fastestLap}`,
    options.lifetimeLaps !== false && Number.isFinite(lifetimeLaps) && `lifetime laps: ${lifetimeLaps}`,
    options.ytdLaps !== false && Number.isFinite(ytdLaps) && Number.isFinite(ytdYear) && `${ytdYear} laps: ${ytdLaps}`
  ].filter(Boolean);
  return lines.length ? [...lines, siteUrl] : [];
}

export function formatReceipt({ lapCount, fastestLap, lifetimeLaps, ytdLaps, ytdYear, options, siteUrl = receiptSiteUrl }) {
  return formatReceiptLines({ lapCount, fastestLap, lifetimeLaps, ytdLaps, ytdYear, options, siteUrl }).join("\n");
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
