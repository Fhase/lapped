export const receiptSiteUrl = "https://lapped.fit";

export function formatReceiptLines({ lapCount, fastestLap, siteUrl = receiptSiteUrl }) {
  return [
    `laps: ${lapCount}`,
    fastestLap && `fastest lap: ${fastestLap}`,
    siteUrl
  ].filter(Boolean);
}

export function formatReceipt({ lapCount, fastestLap, siteUrl = receiptSiteUrl }) {
  return formatReceiptLines({ lapCount, fastestLap, siteUrl }).join("\n");
}

if (typeof document !== "undefined") {
  const example = document.querySelector("[data-description-example]");
  if (example) {
    const lines = formatReceiptLines({ lapCount: 14, fastestLap: "2:38 · 42.3 km/h" });
    example.replaceChildren(...lines.flatMap((line, index) => {
      const content = index === lines.length - 1
        ? Object.assign(document.createElement("a"), { href: receiptSiteUrl, textContent: line })
        : Object.assign(document.createElement(index === 0 ? "em" : "span"), { textContent: line });
      return index === 0 ? [content] : [document.createElement("br"), content];
    }));
  }
}
