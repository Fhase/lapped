const $ = (selector) => document.querySelector(selector);
const canvas = $("#overlay"), ctx = canvas.getContext("2d");
const route = new Path2D("M279 42 C251 42 239 87 218 121 C194 161 168 190 132 211 C94 234 63 264 62 300 C60 330 80 347 85 370 C92 400 96 430 99 450 C103 477 96 497 99 520 C101 554 130 622 143 655 C156 686 181 700 210 708 C222 712 235 716 246 715 C270 718 300 707 312 684 C326 660 341 642 338 619 C333 590 309 570 303 535 C297 505 298 470 306 445 C315 412 289 385 286 358 C284 330 299 283 305 245 C312 205 311 157 310 88 C310 57 300 43 279 42 Z");
let ink = "white", photoUrl, currentBlob;
const status = (text) => { $("#status").textContent = text; };

function values() {
  const laps = Number($("#laps").value), speed = Number($("#speed").value), time = $("#time").value.trim();
  if (!Number.isInteger(laps) || laps < 1 || laps > 9999) throw new Error("Enter a lap count between 1 and 9,999.");
  if (!/^\d{1,3}:[0-5]\d$/.test(time) || time.split(":").every((part) => Number(part) === 0)) throw new Error("Use minutes:seconds for your fastest lap, like 2:38.");
  if (!Number.isFinite(speed) || speed <= 0 || speed > 150) throw new Error("Enter a speed between 0.1 and 150 km/h.");
  return { laps, speed, time };
}
function text(value, x, y, size, serif = false) {
  ctx.font = `${serif ? "400" : "500"} ${size}px ${serif ? "Georgia, serif" : "Arial, sans-serif"}`;
  ctx.fillText(value, x, y);
}
function draw() {
  currentBlob = null;
  try {
    const { laps, speed, time } = values();
    // The canvas is always transparent. Photo/checker backgrounds belong to CSS only.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = ink === "white" ? "#ffffff" : "#20201e";
    const withLoop = $("#show-loop").checked;
    text("high park laps", 70, 92, 24);
    text(laps.toLocaleString("en-CA"), 58, 330, laps > 999 ? 170 : 220, true);
    text("laps", 72, 382, 30);
    text("fastest lap", 72, 465, 24);
    text(time, 68, 550, 80, true);
    const speedX = 68 + ctx.measureText(time).width + 26;
    text(`·  ${speed.toFixed(1)} km/h`, speedX, 546, 30);
    ctx.globalAlpha = .65;
    ctx.fillRect(72, 602, 936, 1);
    ctx.globalAlpha = 1;
    ctx.font = "700 32px Arial, sans-serif";
    ctx.fillText("Lapped", 72, 658);
    text("lapped.fit", 862, 658, 24);
    if (withLoop) {
      ctx.save(); ctx.translate(690, 76); ctx.scale(.62, .62);
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 6; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke(route); ctx.restore();
    }
    currentBlob = new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Couldn’t prepare the PNG.")), "image/png"));
    currentBlob.catch(() => {});
    status("");
  } catch (error) { status(error.message); }
  $("#copy").disabled = $("#save").disabled = $("#share").disabled = !currentBlob;
}
function edited() { $("#sample").hidden = true; draw(); }
for (const field of ["#laps", "#time", "#speed"]) $(field).addEventListener("input", edited);
$("#show-loop").addEventListener("change", draw);
$("#receipt").addEventListener("input", () => {
  const source = $("#receipt").value;
  const laps = source.match(/\blaps\s*[:·•]\s*(\d[\d,]*)/i);
  const fastest = source.match(/fastest lap\s*[:·•]\s*(\d{1,3}:[0-5]\d)\s*[:·•]?\s*(\d+(?:\.\d+)?)\s*km\/?h/i);
  if (laps) $("#laps").value = laps[1].replaceAll(",", "");
  if (fastest) { $("#time").value = fastest[1]; $("#speed").value = fastest[2]; }
  if (laps && fastest) edited();
  else { currentBlob = null; for (const id of ["#copy", "#save", "#share"]) $(id).disabled = true; status("Paste both Lapped stat lines, or fill in the stats below."); }
});
document.querySelectorAll("[data-ink]").forEach((button) => button.addEventListener("click", () => {
  ink = button.dataset.ink;
  document.querySelectorAll("[data-ink]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  draw();
}));
function background(value) {
  $("#preview").dataset.background = value;
  $("#preview").style.backgroundImage = "";
  document.querySelectorAll("[data-bg]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.bg === value)));
  $("#remove-photo").hidden = true;
}
document.querySelectorAll("[data-bg]").forEach((button) => button.addEventListener("click", () => background(button.dataset.bg)));
$("#photo").addEventListener("change", () => {
  const file = $("#photo").files[0]; if (!file) return;
  if (!file.type.startsWith("image/")) return status("Choose an image to preview.");
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = URL.createObjectURL(file);
  const image = new Image(); image.onload = () => {
    background("photo"); $("#preview").style.backgroundImage = `url("${photoUrl}")`; $("#remove-photo").hidden = false;
  }; image.onerror = () => status("This photo format can’t be previewed here. Try a JPEG or PNG."); image.src = photoUrl;
});
$("#remove-photo").addEventListener("click", () => { background("dark"); $("#photo").value = ""; if (photoUrl) URL.revokeObjectURL(photoUrl); photoUrl = null; });
function download(blob) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = "lapped-ride-overlay.png"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
$("#copy").addEventListener("click", async () => {
  if (!currentBlob) return;
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("Image copy isn’t supported in this browser. Use Save PNG instead.");
    // Start clipboard access inside the tap; Safari accepts a promise for PNG data.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": currentBlob })]);
    status("Overlay copied. Paste into an app that supports image pasting, or save it as a photo sticker.");
  } catch (error) { status(error.message.includes("supported") ? error.message : "Couldn’t copy here. Save PNG, then add it as a photo sticker in your story."); }
});
$("#save").addEventListener("click", async () => { try { if (currentBlob) { download(await currentBlob); status("Transparent PNG saved. Add it as a photo sticker over your story photo."); } } catch { status("Couldn’t save the PNG. Please try again."); } });
const shareSupported = navigator.canShare?.({ files: [new File([""], "overlay.png", { type: "image/png" })] });
$("#share").hidden = !shareSupported;
$("#share").addEventListener("click", async () => {
  try { if (!currentBlob) return; const file = new File([await currentBlob], "lapped-ride-overlay.png", { type: "image/png" }); await navigator.share({ files: [file] }); status("Overlay shared."); }
  catch (error) { if (error.name !== "AbortError") status("Sharing isn’t available here. Use Save PNG instead."); }
});
draw();
