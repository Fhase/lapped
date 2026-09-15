export const receiptSiteUrl = "www.lapped.fit";
export const receiptSiteHref = "https://www.lapped.fit";

export function formatReceiptLines({ lapCount, fastestLap, siteUrl = receiptSiteUrl, style = "unicode" }) {
  const useUnicode = style === "unicode";
  return [
    `${useUnicode ? "ʟᴀᴘꜱ" : "laps"}: ${lapCount}`,
    fastestLap && `${useUnicode ? "ꜰᴀꜱᴛᴇꜱᴛ ʟᴀᴘ" : "fastest lap"}: ${useUnicode ? fastestLap.replace("km/h", "ᴋᴍ/ʜ") : fastestLap}`,
    siteUrl
  ].filter(Boolean);
}

export function formatReceipt({ lapCount, fastestLap, siteUrl = receiptSiteUrl }) {
  return formatReceiptLines({ lapCount, fastestLap, siteUrl }).join("\n");
}

if (typeof document !== "undefined") {
  const example = document.querySelector("[data-description-example]");
  if (example) {
    const lines = formatReceiptLines({ lapCount: 14, fastestLap: "2:38 · 42.3 km/h", style: "normal" });
    example.replaceChildren(...lines.flatMap((line, index) => {
      const content = index === lines.length - 1
        ? Object.assign(document.createElement("a"), { href: receiptSiteHref, textContent: line })
        : Object.assign(document.createElement("span"), { textContent: line });
      return index === 0 ? [content] : [document.createElement("br"), content];
    }));
  }
}
