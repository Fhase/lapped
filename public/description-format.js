export const receiptSiteUrl = "www.lapped.fit";
export const receiptSiteHref = "https://www.lapped.fit";

function unicodeDigits(value) {
  const digits = Array.from("𝟶𝟷𝟸𝟹𝟺𝟻𝟼𝟽𝟾𝟿");
  return String(value).replace(/\d/g, (digit) => digits[Number(digit)]);
}

export function formatReceiptLines({ lapCount, fastestLap, siteUrl = receiptSiteUrl, style = "normal" }) {
  const useUnicode = style === "unicode";
  const separator = useUnicode ? " · " : ": ";
  return [
    `${useUnicode ? "𝚕𝚊𝚙𝚜" : "laps"}${separator}${useUnicode ? unicodeDigits(lapCount) : lapCount}`,
    fastestLap && `${useUnicode ? "𝚏𝚊𝚜𝚝𝚎𝚜𝚝 𝚕𝚊𝚙" : "fastest lap"}${separator}${useUnicode ? unicodeDigits(fastestLap).replace("km/h", "𝚔𝚖/𝚑") : fastestLap}`,
    siteUrl
  ].filter(Boolean);
}

export function formatReceipt({ lapCount, fastestLap, siteUrl = receiptSiteUrl, style = "normal" }) {
  return formatReceiptLines({ lapCount, fastestLap, siteUrl, style }).join("\n");
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
