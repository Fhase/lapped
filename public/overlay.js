const $ = (selector) => document.querySelector(selector);
const canvas = $("#overlay"), ctx = canvas.getContext("2d");
const route = new Path2D("M279 42 C251 42 239 87 218 121 C194 161 168 190 132 211 C94 234 63 264 62 300 C60 330 80 347 85 370 C92 400 96 430 99 450 C103 477 96 497 99 520 C101 554 130 622 143 655 C156 686 181 700 210 708 C222 712 235 716 246 715 C270 718 300 707 312 684 C326 660 341 642 338 619 C333 590 309 570 303 535 C297 505 298 470 306 445 C315 412 289 385 286 358 C284 330 299 283 305 245 C312 205 311 157 310 88 C310 57 300 43 279 42 Z");
let ink = "white", photoUrl, photoImage, currentBlob, cropX = 50, cropY = 50, dragStart, loadedRide = false;
const ratios = { square: [1080, 1080], story: [1080, 1920], portrait: [1080, 1350], landscape: [1920, 1080] };
const status = (text) => { $("#status").textContent = text; };

function values() {
  const lapInput = $("#laps").textContent.trim(), speedInput = $("#speed").textContent.trim(), time = $("#time").textContent.trim();
  if (!lapInput || !speedInput || !time) return null;
  const laps = Number(lapInput), speed = Number(speedInput);
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
    // The canvas is always transparent. Photo/checker backgrounds belong to CSS only.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const stats = values();
    if (!loadedRide || !stats) {
      $("#copy").disabled = $("#save").disabled = $("#share").disabled = true;
      return;
    }
    const { laps, speed, time } = stats;
    ctx.save();
    ctx.fillStyle = ink === "white" ? "#ffffff" : "#20201e";
    const withLoop = $("#show-loop").checked;
    // Taller canvases add transparent room above the composition. The scale
    // control changes type/icon size while slightly opening or tightening gaps.
    const fitScale = Math.min(canvas.width / 1080, canvas.height / 720);
    const itemScale = Number($("#overlay-scale").value) / 100;
    const gapScale = 1 + (1 - itemScale) * .5;
    const x = (value) => 540 + (value - 540) * gapScale;
    const y = (value) => 92 + (value - 92) * gapScale;
    const size = (value) => value * itemScale;
    ctx.translate((canvas.width - 1080 * fitScale) / 2, canvas.height - 720 * fitScale);
    ctx.scale(fitScale, fitScale);
    text("high park laps", x(70), y(92), size(24));
    text(laps.toLocaleString("en-CA"), x(58), y(330), size(laps > 999 ? 170 : 220), true);
    text("laps", x(72), y(382), size(30));
    text("fastest lap", x(72), y(465), size(24));
    text(time, x(68), y(550), size(80), true);
    const speedX = x(68) + ctx.measureText(time).width + 26 * gapScale;
    text(`·  ${speed.toFixed(1)} km/h`, speedX, y(546), size(30));
    ctx.globalAlpha = .65; ctx.fillRect(x(72), y(602), 936 * gapScale, 1); ctx.globalAlpha = 1;
    ctx.font = `700 ${size(32)}px Arial, sans-serif`;
    ctx.fillText("Lapped", x(72), y(658));
    text("lapped.fit", x(862), y(658), size(24));
    if (withLoop) {
      ctx.save(); ctx.translate(x(690), y(76)); ctx.scale(.62 * itemScale, .62 * itemScale);
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 6; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke(route); ctx.restore();
    }
    ctx.restore();
    currentBlob = new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Couldn’t prepare the PNG.")), "image/png"));
    currentBlob.catch(() => {});
    status("");
  } catch (error) { status(error.message); }
  $("#copy").disabled = $("#save").disabled = $("#share").disabled = !currentBlob;
}
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
  background("checker");
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null; photoImage = null; cropX = cropY = 50;
  status("Photo removed.");
});
let ratioScrollPosition = null;
const ratioButtons = document.querySelectorAll("[data-ratio]");
ratioButtons.forEach((button) => {
  const rememberScroll = () => { ratioScrollPosition = { x: window.scrollX, y: window.scrollY }; };
  button.addEventListener("pointerdown", rememberScroll, { passive: true });
  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") rememberScroll();
  });
  button.addEventListener("click", () => {
  const scrollPosition = ratioScrollPosition || { x: window.scrollX, y: window.scrollY };
  ratioScrollPosition = null;
  const [width, height] = ratios[button.dataset.ratio];
  canvas.width = width; canvas.height = height;
  $("#preview").style.aspectRatio = `${width} / ${height}`;
  document.querySelectorAll("[data-ratio]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  draw();
  if (photoUrl) updateCrop();
  requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(scrollPosition.x, scrollPosition.y)));
  });
});
$("#overlay-scale").addEventListener("input", (event) => {
  const percentage = Number(event.currentTarget.value);
  $("#overlay-scale-value").textContent = `${percentage}%`;
  event.currentTarget.setAttribute("aria-valuetext", `${percentage} percent`);
  draw();
});

function rideMessage(message, showConnect = false) {
  const output = $("#ride-status");
  output.replaceChildren(document.createTextNode(message));
  if (showConnect) {
    output.append(" ");
    const link = document.createElement("a");
    link.href = "/#connect-card";
    link.textContent = "connect strava";
    output.append(link, " to choose a ride.");
  }
}
async function requestRide(path, options) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || (response.status === 404
      ? "This local preview has no Lapped API server attached yet. Ride lookup will work on lapped.fit after rollout."
      : "Could not load that ride."));
    error.status = response.status;
    throw error;
  }
  return body;
}
function showRide(ride) {
  if (!ride?.laps) {
    loadedRide = false;
    $("#laps").textContent = ""; $("#time").textContent = ""; $("#speed").textContent = "";
    draw();
    rideMessage("No completed High Park laps on this ride, so there’s nothing to add.");
    return;
  }
  $("#laps").textContent = String(ride.laps);
  $("#time").textContent = ride.fastestLap?.time || "";
  $("#speed").textContent = ride.fastestLap?.speedKmh || "";
  loadedRide = true;
  draw();
  const date = ride.date ? ` · ${new Date(ride.date).toLocaleDateString()}` : "";
  rideMessage(`${ride.title || "ride"}${date} · ${ride.laps} High Park lap${ride.laps === 1 ? "" : "s"}`);
}
async function loadRide(id) {
  if (!/^\d+$/.test(String(id))) return;
  rideMessage("loading ride…");
  $("#recent-ride").disabled = true;
  try { showRide(await requestRide(`/api/overlay/rides/${encodeURIComponent(id)}`)); }
  catch (error) {
    rideMessage(error.status === 401 ? "Connect Strava to choose one of your rides." : error.message, error.status === 401);
  } finally { $("#recent-ride").disabled = false; }
}
async function loadRecentRides() {
  const select = $("#recent-ride");
  try {
    const { rides = [] } = await requestRide("/api/overlay/rides");
    select.replaceChildren(new Option(rides.length ? "choose a ride…" : "no recent rides found", ""));
    for (const ride of rides) {
      const date = ride.date ? ` · ${new Date(ride.date).toLocaleDateString()}` : "";
      select.add(new Option(`${ride.title || "ride"}${date}`, ride.id));
    }
    if (!rides.length) rideMessage("No recent rides found on this Strava account.");
    else rideMessage("Choose a recent ride or paste a link to make your overlay.");
  } catch (error) {
    select.replaceChildren(new Option(error.status === 401 ? "connect strava to load rides" : "recent rides unavailable", ""));
    rideMessage(error.status === 401 ? "Connect Strava to choose one of your rides." : error.message, error.status === 401);
  }
}
$("#recent-ride").addEventListener("change", (event) => loadRide(event.target.value));
$("#ride-link-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = $("#ride-link").value.trim();
  if (!url) return rideMessage("Paste a Strava ride link first.");
  const button = $("#load-link"); button.disabled = true; button.textContent = "loading…";
  try { showRide(await requestRide("/api/overlay/rides/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) })); }
  catch (error) { rideMessage(error.status === 401 ? "Connect Strava to load one of your rides." : error.message, error.status === 401); }
  finally { button.disabled = false; button.textContent = "load ride"; }
});
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
loadRecentRides();
