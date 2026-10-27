const $ = (selector) => document.querySelector(selector);
const canvas = $("#overlay"), ctx = canvas.getContext("2d");
const localHost = /^(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})$/.test(location.hostname);
const previewParams = new URLSearchParams(location.search);
const designPreview = localHost && ["styles", "styles-two"].includes(previewParams.get("preview"));
const route = new Path2D("M279 42 C251 42 239 87 218 121 C194 161 168 190 132 211 C94 234 63 264 62 300 C60 330 80 347 85 370 C92 400 96 430 99 450 C103 477 96 497 99 520 C101 554 130 622 143 655 C156 686 181 700 210 708 C222 712 235 716 246 715 C270 718 300 707 312 684 C326 660 341 642 338 619 C333 590 309 570 303 535 C297 505 298 470 306 445 C315 412 289 385 286 358 C284 330 299 283 305 245 C312 205 311 157 310 88 C310 57 300 43 279 42 Z");
let ink = "white", overlayStyle = "original", photoUrl, photoImage, currentBlob, cropX = 50, cropY = 50, dragStart, loadedRide = false;
let rideMetrics = { distanceMeters: null, averageSpeedMps: null, normalizedPowerWatts: null, elapsedSeconds: null };
const ratios = { square: [1080, 1080], story: [1080, 1920], portrait: [1080, 1350], landscape: [1920, 1080] };
const status = (text) => { $("#status").textContent = text; };

function usesRideMetrics(style = overlayStyle) { return style === "stack" || style === "ledger"; }

function values() {
  const lapInput = $("#laps").textContent.trim(), speedInput = $("#speed").textContent.trim(), time = $("#time").textContent.trim();
  if (!lapInput || !speedInput || !time) return null;
  const laps = Number(lapInput), speed = Number(speedInput);
  if (!Number.isInteger(laps) || laps < 1 || laps > 9999) throw new Error("Enter a lap count between 1 and 9,999.");
  if (!/^\d{1,3}:[0-5]\d$/.test(time) || time.split(":").every((part) => Number(part) === 0)) throw new Error("Use minutes:seconds for your fastest lap, like 2:38.");
  if (!Number.isFinite(speed) || speed <= 0 || speed > 150) throw new Error("Enter a speed between 0.1 and 150 km/h.");
  return { laps, speed, time };
}
function text(value, x, y, size) {
  ctx.font = `500 ${size}px Helvetica, Arial, sans-serif`;
  ctx.fillText(value, x, y);
}
function numberText(value, x, y, size, weight = 400) {
  ctx.font = `${weight} ${size}px "Geist Mono", monospace`;
  ctx.textAlign = "left";
  ctx.fillText(value, x, y);
}
// Compact styles share the same transparent canvas and verified ride values.
function drawCompact(stats, itemScale, horizontalGapScale) {
  const { laps, time, speed } = stats;
  const left = 72;
  const right = 1008;
  const bottom = 648;
  const label = (value, x, y, align = "left") => {
    ctx.textAlign = align;
    ctx.font = `400 ${19 * itemScale}px Helvetica, Arial, sans-serif`;
    ctx.fillText(value, x, y);
  };
  const number = (value, x, y, fontSize = 54, align = "left") => {
    ctx.textAlign = align;
    ctx.font = `400 ${fontSize * itemScale}px "Geist Mono", monospace`;
    ctx.fillText(value, x, y);
  };
  const line = (x1, y, x2, alpha = .4) => {
    ctx.globalAlpha = alpha;
    ctx.fillRect(x1, y, x2 - x1, 1);
    ctx.globalAlpha = 1;
  };
  if (overlayStyle === "studio") {
    label("high park / ride data", left, bottom - 155);
    label("lapped.fit", right, bottom - 155, "right");
    line(left, bottom - 133, right);
    const columns = [left, (left + right) / 2, right];
    const alignments = ["left", "center", "right"];
    const metrics = [[laps.toLocaleString("en-CA"), "laps"], [time, "fastest lap"], [speed.toFixed(1), "km/h"]];
    metrics.forEach(([value, title], index) => {
      number(value, columns[index], bottom - 49, 54, alignments[index]);
      label(title, columns[index], bottom - 9, alignments[index]);
    });
  }
  ctx.textAlign = "left";
}
function formatElapsed(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.round(seconds), hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60), remainder = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
}
function redesignedMetrics() {
  const distance = Number(rideMetrics.distanceMeters);
  const speed = Number(rideMetrics.averageSpeedMps);
  const power = Number(rideMetrics.normalizedPowerWatts);
  const elapsed = Number(rideMetrics.elapsedSeconds);
  return [
    ["distance", Number.isFinite(distance) && distance > 0 ? `${(distance / 1000).toFixed(1)} km` : "—"],
    ["average speed", Number.isFinite(speed) && speed > 0 ? `${(speed * 3.6).toFixed(1)} km/h` : "—"],
    ["normalized power", Number.isFinite(power) && power > 0 ? `${Math.round(power)} W` : "—"],
    ["elapsed time", formatElapsed(elapsed)]
  ];
}
function drawRedesigned(metrics, itemScale) {
  const center = 540;
  const line = (x1, y, x2, alpha = .34) => {
    ctx.globalAlpha = alpha; ctx.fillRect(x1, y, x2 - x1, 1); ctx.globalAlpha = 1;
  };
  const number = (value, x, y, align = "center", size = 42, weight = 400) => {
    ctx.font = `${weight} ${size * itemScale}px "Geist Mono", monospace`;
    ctx.textAlign = align;
    ctx.fillText(value, x, y);
  };
  const siteLink = (x, y, align = "left") => {
    ctx.font = `500 ${24 * itemScale}px Helvetica, Arial, sans-serif`;
    ctx.textAlign = align;
    ctx.fillText("lapped.fit", x, y);
  };
  if (overlayStyle === "stack") {
    metrics.forEach(([, value], index) => {
      const top = 54 + index * 56;
      number(value, center, top, "center", 43, 350);
    });
    siteLink(center, 300, "center");
  } else if (overlayStyle === "ledger") {
    const gridLeft = 72, gridRight = 1008;
    const rowBaseline = 560, scale = itemScale / .8;
    metrics.forEach(([, value], index) => {
      const x = gridLeft + (gridRight - gridLeft) * (index + .5) / metrics.length;
      number(value, x, rowBaseline, "center", 39, 400);
    });
    line(gridLeft, rowBaseline - 50 * scale, gridRight, .45);
    line(gridLeft, rowBaseline + 28 * scale, gridRight, .45);
    siteLink(862, rowBaseline + 80 * scale);
  }
  ctx.textAlign = "left";
}
function draw() {
  currentBlob = null;
  try {
    // The canvas is always transparent. Photo/gradient backgrounds belong to CSS only.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!loadedRide) {
      $("#copy").disabled = $("#save").disabled = $("#share").disabled = true;
      return;
    }
    const redesignedStyle = usesRideMetrics();
    const stats = redesignedStyle ? null : values();
    if (!redesignedStyle && !stats) {
      $("#copy").disabled = $("#save").disabled = $("#share").disabled = true;
      return;
    }
    ctx.save();
    ctx.fillStyle = ink === "white" ? "#ffffff" : "#20201e";
    const withLoop = !redesignedStyle && $("#show-loop").checked;
    // Taller canvases add transparent room above the composition. The scale
    // control changes type/icon size and horizontal spacing without stretching
    // the vertical rhythm between lines.
    const fitScale = Math.min(canvas.width / 1080, canvas.height / 720);
    // The former 90% setting is the new 100% reference size.
    const sliderValue = Number($("#overlay-scale").value);
    const itemScale = overlayStyle === "original"
      ? .8 + (sliderValue - 100) / 100
      : .9 + (sliderValue - 100) / 100;
    const horizontalGapScale = 1 + (1 - itemScale) * .5;
    const x = (value) => 540 + (value - 540) * horizontalGapScale;
    const y = (value) => value;
    const size = (value) => value * itemScale;
    const originalBottomPadding = !redesignedStyle && overlayStyle === "original" ? 60 * fitScale : 0;
    ctx.translate((canvas.width - 1080 * fitScale) / 2, canvas.height - 720 * fitScale - originalBottomPadding);
    ctx.scale(fitScale, fitScale);
    if (redesignedStyle) {
      const layoutScale = itemScale / .9;
      if (overlayStyle === "ledger") {
        // UI scaling: keep the ledger grid full width and scale its type and rhythm in place.
        drawRedesigned(redesignedMetrics(), 1 * (Number($("#overlay-scale").value) / 100));
      } else {
        ctx.save();
        const stackScale = layoutScale * 1.25;
        ctx.translate(540, 195); ctx.scale(stackScale, stackScale); ctx.translate(-540, -195);
        drawRedesigned(redesignedMetrics(), .9);
        ctx.restore();
      }
    } else if (overlayStyle === "studio") {
      drawCompact(stats, itemScale, 1);
    } else {
    const { laps, speed, time } = stats;
    text("high park laps", x(72), y(365), size(24));
    numberText(laps.toLocaleString("en-CA"), x(72), y(486), size(laps > 999 ? 118 : 148));
    text("laps", x(72), y(523), size(26));
    text("fastest lap", x(72), y(566), size(21));
    numberText(time, x(72), y(645), size(70));
    const speedX = x(72) + ctx.measureText(time).width + 26 * horizontalGapScale;
    numberText(`·  ${speed.toFixed(1)} km/h`, speedX, y(640), size(27));
    ctx.globalAlpha = .65; ctx.fillRect(x(72), y(668), 936 * horizontalGapScale, 1); ctx.globalAlpha = 1;
    text("lapped.fit", x(862), y(708), size(24));
    if (withLoop) {
      const loopScale = .46 * itemScale;
      ctx.save(); ctx.translate(x(1008) - 342 * loopScale, y(622) - 718 * loopScale); ctx.scale(loopScale, loopScale);
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 6; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke(route); ctx.restore();
    }
    }
    ctx.restore();
    currentBlob = new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Couldn’t prepare the PNG.")), "image/png"));
    currentBlob.catch(() => {});
    status("");
  } catch (error) { status(error.message); }
  $("#copy").disabled = $("#save").disabled = $("#share").disabled = !currentBlob;
}
$("#show-loop").addEventListener("change", draw);
document.querySelectorAll("[data-style]").forEach((button) => button.addEventListener("click", () => {
  if (button.hidden) return;
  overlayStyle = button.dataset.style;
  document.querySelectorAll("[data-style]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  $("#loop-option").hidden = usesRideMetrics() || overlayStyle !== "original";
  $(".fields-laps").hidden = usesRideMetrics();
  $(".fields-ride").hidden = !usesRideMetrics();
  $(".preview-note").textContent = usesRideMetrics()
    ? "ride metrics · normalized power appears when Strava has a value."
    : overlayStyle === "original"
    ? "Your photo stays in this browser. Only the text and loop are exported."
    : "Your photo stays in this browser. Only the text is exported.";
  draw();
}));
document.querySelectorAll("[data-ink]").forEach((button) => button.addEventListener("click", () => {
  ink = button.dataset.ink;
  $("#preview").dataset.ink = ink;
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
  background("gradient");
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null; photoImage = null; cropX = cropY = 50;
  status("Photo removed.");
});
let ratioScrollPosition = null;
let ratioRestoreToken = 0;
const ratioButtons = document.querySelectorAll("[data-ratio]");
ratioButtons.forEach((button) => {
  const rememberScroll = () => {
    ratioScrollPosition = { button, top: button.getBoundingClientRect().top, left: window.scrollX };
  };
  button.addEventListener("pointerdown", rememberScroll, { passive: true });
  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") rememberScroll();
  });
  button.addEventListener("click", () => {
    const scrollPosition = ratioScrollPosition || { button, top: button.getBoundingClientRect().top, left: window.scrollX };
    ratioScrollPosition = null;
    const restoreToken = ++ratioRestoreToken;
    const [width, height] = ratios[button.dataset.ratio];
    canvas.width = width; canvas.height = height;
    $("#preview").style.aspectRatio = `${width} / ${height}`;
    document.querySelectorAll("[data-ratio]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    draw();
    if (photoUrl) updateCrop();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (restoreToken !== ratioRestoreToken) return;
      const newTop = scrollPosition.button.getBoundingClientRect().top;
      const root = document.documentElement;
      const previousScrollBehavior = root.style.scrollBehavior;
      root.style.scrollBehavior = "auto";
      window.scrollTo(scrollPosition.left, window.scrollY + newTop - scrollPosition.top);
      root.style.scrollBehavior = previousScrollBehavior;
    }));
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
      ? "This local preview has no lapped API server attached yet. Ride lookup will work on lapped.fit after rollout."
      : "Could not load that ride."));
    error.status = response.status;
    throw error;
  }
  return body;
}
function showRide(ride) {
  const metric = (value) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  rideMetrics = {
    distanceMeters: metric(ride?.distanceMeters),
    averageSpeedMps: metric(ride?.averageSpeedMps),
    normalizedPowerWatts: metric(ride?.normalizedPowerWatts),
    elapsedSeconds: metric(ride?.elapsedSeconds)
  };
  const [distance, speed, power, elapsed] = redesignedMetrics().map(([, value]) => value);
  $("#ride-distance").textContent = distance;
  $("#ride-average-speed").textContent = speed;
  $("#ride-normalized-power").textContent = power;
  $("#ride-elapsed-time").textContent = elapsed;
  loadedRide = Boolean(ride);
  if (!ride?.laps) {
    $("#laps").textContent = ""; $("#time").textContent = ""; $("#speed").textContent = "";
    draw();
    rideMessage("No completed High Park laps on this ride, so there’s nothing to add.");
    return;
  }
  $("#laps").textContent = String(ride.laps);
  $("#time").textContent = ride.fastestLap?.time || "";
  $("#speed").textContent = ride.fastestLap?.speedKmh || "";
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
function download(blob, filename = "lapped-ride-overlay.png") {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
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
if (designPreview) {
  $("#recent-ride").replaceChildren(new Option("design preview · example ride", ""));
  $("#recent-ride").disabled = $("#ride-link").disabled = $("#load-link").disabled = true;
  showRide({ title: "design preview · example ride", laps: 14, fastestLap: { time: "2:38", speedKmh: 42.3 }, distanceMeters: 42800, averageSpeedMps: 7.65, normalizedPowerWatts: 246, elapsedSeconds: 6138 });
  const previewStyle = previewParams.get("style");
  const availableStyles = ["original", "studio", "stack", "ledger"];
  document.querySelector(`[data-style="${availableStyles.includes(previewStyle) ? previewStyle : availableStyles[0]}"]`).click();
} else {
  loadRecentRides();
}
if (document.fonts) {
  document.fonts.load('400 24px "Geist Mono"').then(draw);
}
