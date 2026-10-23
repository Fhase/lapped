const $ = (selector) => document.querySelector(selector);
const canvas = $("#overlay"), ctx = canvas.getContext("2d");
const route = new Path2D("M279 42 C251 42 239 87 218 121 C194 161 168 190 132 211 C94 234 63 264 62 300 C60 330 80 347 85 370 C92 400 96 430 99 450 C103 477 96 497 99 520 C101 554 130 622 143 655 C156 686 181 700 210 708 C222 712 235 716 246 715 C270 718 300 707 312 684 C326 660 341 642 338 619 C333 590 309 570 303 535 C297 505 298 470 306 445 C315 412 289 385 286 358 C284 330 299 283 305 245 C312 205 311 157 310 88 C310 57 300 43 279 42 Z");
let ink = "white", photoUrl, photoImage, currentBlob, cropX = 50, cropY = 50, dragStart;
const ratios = { story: [1080, 1920], portrait: [1080, 1350], square: [1080, 1080], landscape: [1920, 1080] };
const status = (text) => { $("#status").textContent = text; };

function values() {
  const laps = Number($("#laps").value), speed = Number($("#speed").value), time = $("#time").value.trim();
  if (!Number.isInteger(laps) || laps < 1 || laps > 9999) throw new Error("Enter a lap count between 1 and 9,999.");
  if (!/^\d{1,3}:[0-5]\d$/.test(time) || time.split(":").every((part) => Number(part) === 0)) throw new Error("Use minutes:seconds for your fastest lap, like 2:38.");
  if (!Number.isFinite(speed) || speed <= 0 || speed > 150) throw new Error("Enter a speed between 0.1 and 150 km/h.");
  return { laps, speed, time };
}
function text(value, x, y, size, weight = 500) {
  ctx.font = `${weight} ${size}px Arial, Helvetica, sans-serif`;
  ctx.fillText(value, x, y);
}
function draw() {
  currentBlob = null;
  try {
    const { laps, speed, time } = values();
    // The canvas is always transparent. Photo/checker backgrounds belong to CSS only.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.fillStyle = ink === "white" ? "#ffffff" : "#20201e";
    const withLoop = $("#show-loop").checked;
    // Keep the artwork at one consistent scale and spacing. Taller canvases
    // simply add transparent room above it; the composition stays at the bottom.
    const scale = Math.min(canvas.width / 1080, canvas.height / 720);
    ctx.translate((canvas.width - 1080 * scale) / 2, canvas.height - 720 * scale);
    ctx.scale(scale, scale);
    text("high park laps", 70, 92, 24, 600);
    text(laps.toLocaleString("en-CA"), 58, 330, laps > 999 ? 170 : 220, 500);
    text("laps", 72, 382, 30, 500);
    text("fastest lap", 72, 465, 24, 600);
    text(time, 68, 550, 80, 500);
    const speedX = 68 + ctx.measureText(time).width + 26;
    text(`·  ${speed.toFixed(1)} km/h`, speedX, 546, 30, 500);
    ctx.globalAlpha = .65; ctx.fillRect(72, 602, 936, 1); ctx.globalAlpha = 1;
    text("Lapped", 72, 658, 32, 700);
    text("lapped.fit", 862, 658, 24, 500);
    if (withLoop) {
      ctx.save(); ctx.translate(690, 76); ctx.scale(.62, .62);
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 6; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke(route); ctx.restore();
    }
    ctx.restore();
    currentBlob = new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Couldn’t prepare the PNG.")), "image/png"));
    currentBlob.catch(() => {});
    status("");
  } catch (error) { status(error.message); }
  $("#copy").disabled = $("#save").disabled = $("#share").disabled = !currentBlob;
}
function edited() { $("#sample").hidden = true; draw(); }
for (const field of ["#laps", "#time", "#speed"]) $(field).addEventListener("input", edited);
$("#show-loop").addEventListener("change", draw);
document.querySelectorAll("[data-ink]").forEach((button) => button.addEventListener("click", () => {
  ink = button.dataset.ink;
  document.querySelectorAll("[data-ink]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  draw();
}));
function background(value) {
  $("#preview").dataset.background = value;
  $("#preview").style.backgroundImage = "";
  $("#preview").style.backgroundSize = "";
  $("#preview").style.backgroundPosition = "50% 50%";
  document.querySelectorAll("[data-bg]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.bg === value)));
  $("#remove-photo").hidden = true;
  $("#photo-adjust").hidden = true;
}
document.querySelectorAll("[data-bg]").forEach((button) => button.addEventListener("click", () => background(button.dataset.bg)));
$("#photo").addEventListener("change", () => {
  const file = $("#photo").files[0]; if (!file) return;
  if (!file.type.startsWith("image/")) return status("Choose an image to preview.");
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = URL.createObjectURL(file);
  const selectedUrl = photoUrl;
  const image = new Image(); image.onload = () => {
    if (photoUrl !== selectedUrl) return;
    photoImage = image;
    background("photo");
    const preview = $("#preview"), bounds = preview.getBoundingClientRect();
    const cover = Math.max(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
    preview.style.backgroundImage = `url("${selectedUrl}")`;
    preview.style.backgroundSize = `${image.naturalWidth * cover}px ${image.naturalHeight * cover}px`;
    cropX = cropY = 50; preview.style.backgroundPosition = `${cropX}% ${cropY}%`;
    $("#remove-photo").hidden = false; $("#photo-adjust").hidden = false; $("#photo-zoom").value = "1";
    status("");
  }; image.onerror = () => {
    if (photoUrl !== selectedUrl) return;
    status("This photo format can’t be previewed here. Try a JPEG or PNG."); URL.revokeObjectURL(selectedUrl); photoUrl = null; photoImage = null; $("#photo").value = "";
  }; image.src = selectedUrl;
});
function updateCrop() {
  const preview = $("#preview"), image = photoImage;
  if (!photoUrl || !image) return;
  const bounds = preview.getBoundingClientRect();
  const cover = Math.max(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight) * Number($("#photo-zoom").value);
  preview.style.backgroundSize = `${image.naturalWidth * cover}px ${image.naturalHeight * cover}px`;
  preview.style.backgroundPosition = `${cropX}% ${cropY}%`;
}
window.addEventListener("resize", () => { if (photoUrl) updateCrop(); });
$("#photo-zoom").addEventListener("input", updateCrop);
$("#reset-crop").addEventListener("click", () => { cropX = cropY = 50; $("#photo-zoom").value = "1"; updateCrop(); });
$("#preview").addEventListener("pointerdown", (event) => {
  if (!photoUrl) return;
  dragStart = { x: event.clientX, y: event.clientY, cropX, cropY };
  $("#preview").setPointerCapture(event.pointerId);
});
$("#preview").addEventListener("pointermove", (event) => {
  if (!dragStart || !photoUrl) return;
  const bounds = $("#preview").getBoundingClientRect();
  cropX = Math.max(0, Math.min(100, dragStart.cropX - (event.clientX - dragStart.x) / bounds.width * 100));
  cropY = Math.max(0, Math.min(100, dragStart.cropY - (event.clientY - dragStart.y) / bounds.height * 100));
  $("#preview").style.backgroundPosition = `${cropX}% ${cropY}%`;
});
$("#preview").addEventListener("pointerup", () => { dragStart = null; });
$("#preview").addEventListener("pointercancel", () => { dragStart = null; });
$("#remove-photo").addEventListener("click", () => {
  $("#photo").value = "";
  background("dark");
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null; photoImage = null; cropX = cropY = 50;
  status("Photo removed.");
});
document.querySelectorAll("[data-ratio]").forEach((button) => button.addEventListener("click", () => {
  const [width, height] = ratios[button.dataset.ratio];
  canvas.width = width; canvas.height = height;
  $("#preview").style.aspectRatio = `${width} / ${height}`;
  document.querySelectorAll("[data-ratio]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  draw();
  if (photoUrl) updateCrop();
}));
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
    status("Overlay copied.");
  } catch (error) { status(error.message.includes("supported") ? error.message : "Couldn’t copy the image here."); }
});
$("#save").addEventListener("click", async () => { try { if (currentBlob) { download(await currentBlob); status("Transparent PNG saved."); } } catch { status("Couldn’t save the PNG. Please try again."); } });
const shareSupported = navigator.canShare?.({ files: [new File([""], "overlay.png", { type: "image/png" })] });
$("#share").hidden = !shareSupported;
$("#share").addEventListener("click", async () => {
  try { if (!currentBlob) return; const file = new File([await currentBlob], "lapped-ride-overlay.png", { type: "image/png" }); await navigator.share({ files: [file] }); status("Overlay shared."); }
  catch (error) { if (error.name !== "AbortError") status("Sharing isn’t available here. Use Save PNG instead."); }
});
draw();
