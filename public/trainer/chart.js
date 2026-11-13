// Workout profile chart: zone-colored interval blocks (ramps as trapezoids), smoothed power and
// heart-rate traces, FTP line, a gliding cursor while riding and a hover readout. Port of TrainingChart.swift.
import { averagePercent, clockText, isRamp, percentAt, wattsAt, zoneForPercent } from "./core.js";

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const zoneColor = (zone) => css(`--z${zone}`);
const alpha = (color, a) => {
  const m = color.match(/\d+(\.\d+)?/g);
  return m ? `rgba(${m[0]},${m[1]},${m[2]},${a})` : color;
};

export class Chart {
  constructor(host, options = {}) {
    this.o = { steps: [], ftp: 0, samples: [], cursor: null, live: false, miniature: false, recordedOnly: false, showPower: true, showHeart: true, ...options };
    this.host = host;
    host.classList.add("chart", this.o.miniature ? "mini" : "full");
    host.innerHTML = `<div class="plot"><canvas></canvas>${this.o.miniature ? "" : '<canvas class="hover"></canvas><div class="tip" hidden></div>'}</div>${this.o.miniature ? "" : '<div class="axis"><span>0:00</span><span class="mid"></span><span class="end"></span></div>'}`;
    this.canvas = host.querySelector("canvas");
    this.hoverCanvas = host.querySelector("canvas.hover");
    this.tip = host.querySelector(".tip");
    this.tick = performance.now();
    this.hovered = null;
    if (!this.o.miniature) {
      const plot = host.querySelector(".plot");
      plot.addEventListener("mousemove", (event) => {
        const rect = plot.getBoundingClientRect();
        this.hovered = Math.min(this.duration, Math.max(0, Math.round((event.clientX - rect.left) / Math.max(1, rect.width) * this.duration)));
        this.drawHover();
      });
      plot.addEventListener("mouseleave", () => { this.hovered = null; this.drawHover(); });
    }
    this.resize = new ResizeObserver(() => this.draw());
    this.resize.observe(host);
    this.draw();
  }

  set(changes) {
    if ("cursor" in changes && changes.cursor !== this.o.cursor) this.tick = performance.now();
    Object.assign(this.o, changes);
    this.draw();
    this.animate();
  }

  destroy() { this.resize.disconnect(); cancelAnimationFrame(this.frame); }

  // While live, redraw at most 30 times a second so the ridden region and cursor glide between samples.
  animate() {
    cancelAnimationFrame(this.frame);
    if (!this.o.live || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let last = 0;
    const loop = (time) => {
      if (time - last >= 1000 / 30) { last = time; this.draw(); }
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  get duration() {
    const { steps, samples, cursor, recordedOnly } = this.o;
    if (recordedOnly) return Math.max(1, samples.length);
    if (!steps.length && cursor != null) return Math.max(60, Math.ceil((cursor + 1) / 15) * 15);
    return Math.max(1, steps.reduce((t, s) => t + s.seconds, 0), samples.length);
  }
  scaled(percent) { return this.o.ftp > 0 ? this.o.ftp * percent / 100 : percent; }
  target(step) { return this.scaled(Math.max(step.percent, step.end ?? step.percent)); }
  get visibleSteps() {
    let seconds = 0;
    const out = [];
    for (const step of this.o.steps) { if (seconds >= this.duration) break; out.push(step); seconds += step.seconds; }
    return out;
  }
  get ceiling() {
    const { samples, ftp, miniature } = this.o;
    let peak = 0;
    for (const s of samples) if (s.power != null && s.power > peak) peak = s.power;
    const raw = Math.max(1, Math.max(0, ...this.visibleSteps.map((s) => this.target(s))) * 1.16, peak * 1.15,
      ftp > 0 ? ftp * 1.08 : samples.length ? 200 : 1);
    return miniature ? raw : Math.ceil(raw / 40) * 40;
  }
  block(second) {
    let start = 0;
    const { ftp } = this.o;
    for (const step of this.o.steps) {
      if (second < start + step.seconds || (second === this.duration && start + step.seconds >= this.duration)) {
        const from = ftp > 0 ? wattsAt(step, ftp) : step.percent;
        const to = ftp > 0 ? wattsAt(step, ftp, step.seconds) : (step.end ?? step.percent);
        return { start, seconds: step.seconds, label: (isRamp(step) ? `${from}–${to}` : `${from}`) + (ftp > 0 ? " W" : "%"), value: this.target(step) };
      }
      start += step.seconds;
    }
    return null;
  }

  sized(canvas) {
    const rect = canvas.parentElement.getBoundingClientRect();
    const ratio = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * ratio)), h = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    return { ctx, width: rect.width, height: rect.height };
  }

  draw() {
    if (!this.host.isConnected) return;
    const { ctx, width, height } = this.sized(this.canvas);
    const { steps, ftp, samples, miniature, recordedOnly, showPower, showHeart, live, cursor } = this.o;
    const duration = this.duration, ceiling = this.ceiling;
    const x = (second) => width * second / duration;
    const y = (value) => height * (1 - Math.min(1, Math.max(0, value / ceiling)));
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const position = cursor == null ? null : (!live || reduce ? cursor : cursor + Math.min(1, Math.max(0, (performance.now() - this.tick) / 1000)));
    const split = recordedOnly || position == null ? null : x(Math.min(duration, position));
    const border = css("--border"), ink = css("--ink"), muted = css("--muted");

    if (!miniature) {
      ctx.strokeStyle = border; ctx.lineWidth = 1;
      for (let row = 1; row <= 4; row++) {
        ctx.beginPath(); ctx.moveTo(0, height * row / 4); ctx.lineTo(width, height * row / 4); ctx.stroke();
      }
    }

    let start = 0;
    for (const step of this.visibleSteps) {
      const end = Math.min(duration, start + step.seconds);
      const color = zoneColor(zoneForPercent(averagePercent(step)));
      const top = y(this.target(step));
      const left = x(start), right = left + Math.max(0, x(end) - x(start) - (miniature ? 1 : 1.5));
      const startTop = y(this.scaled(step.percent)), endTop = y(this.scaled(percentAt(step, end - start)));
      const path = new Path2D();
      if (isRamp(step)) {
        path.moveTo(left, height); path.lineTo(left, startTop); path.lineTo(right, endTop); path.lineTo(right, height); path.closePath();
      } else {
        path.roundRect(left, top, Math.max(0, right - left), height - top, miniature ? 1 : 2.5);
      }
      const fill = (a, b) => {
        const g = ctx.createLinearGradient(0, top, 0, height);
        g.addColorStop(0, alpha(color, a)); g.addColorStop(1, alpha(color, b));
        return g;
      };
      if (miniature) {
        ctx.fillStyle = alpha(color, split == null ? 0.9 : 0.28); ctx.fill(path);
        if (split != null && split > left) {
          ctx.save(); ctx.beginPath(); ctx.rect(left, 0, split - left, height); ctx.clip();
          ctx.fillStyle = alpha(color, 0.95); ctx.fill(path); ctx.restore();
        }
      } else {
        // Strong zone color like the Home list; the ridden part goes near-solid.
        const base = recordedOnly ? 0.75 : 0.62;
        ctx.fillStyle = fill(base + 0.18, base * 0.55); ctx.fill(path);
        if (split != null && split > left) {
          ctx.save(); ctx.beginPath(); ctx.rect(left, 0, split - left, height); ctx.clip();
          ctx.fillStyle = fill(1, 0.7); ctx.fill(path); ctx.restore();
        }
        const active = split != null && split >= left && split < right + 1.5;
        ctx.beginPath(); ctx.moveTo(left, startTop); ctx.lineTo(right, endTop);
        ctx.strokeStyle = alpha(color, active || recordedOnly ? 1 : 0.6); ctx.lineWidth = active ? 2.5 : 1.5; ctx.lineCap = "round"; ctx.stroke();
      }
      start = end;
    }

    if (!miniature && ftp > 0 && steps.length) {
      const py = y(ftp);
      ctx.save(); ctx.setLineDash([2, 4]); ctx.strokeStyle = alpha(ink, 0.35); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(width, py); ctx.stroke(); ctx.restore();
      ctx.font = `10px ${css("--number-font")}`; ctx.fillStyle = muted; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText("FTP", width - 4, Math.max(9, py - 8));
    }

    // Gaps (missing readings) break a trace into segments.
    const segments = (key, scale) => {
      const result = []; let current = [];
      const stride = Math.max(1, Math.floor(samples.length / Math.max(1, Math.floor(width / 2))));
      samples.forEach((sample, index) => {
        const value = sample[key];
        if (value == null) { if (current.length) { result.push(current); current = []; } return; }
        if (index % stride !== 0 && index !== samples.length - 1) return;
        current.push([x(index + 1), y(value * scale)]);
      });
      if (current.length) result.push(current);
      return result;
    };
    const smooth = (points) => {
      const path = new Path2D();
      path.moveTo(...points[0]);
      if (points.length === 1) { path.lineTo(points[0][0] + 0.5, points[0][1]); return path; }
      for (let i = 1; i < points.length; i++) {
        const [px, py] = points[i - 1];
        path.quadraticCurveTo(px, py, (px + points[i][0]) / 2, (py + points[i][1]) / 2);
      }
      path.lineTo(...points.at(-1));
      return path;
    };
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (showHeart) {
      ctx.strokeStyle = css("--heart"); ctx.lineWidth = 1.3;
      for (const points of segments("heart", ceiling / 220)) ctx.stroke(smooth(points));
    }
    if (showPower) {
      for (const points of segments("power", 1)) {
        const line = smooth(points);
        if (!miniature) {
          const area = new Path2D(line);
          area.lineTo(points.at(-1)[0], height); area.lineTo(points[0][0], height); area.closePath();
          const g = ctx.createLinearGradient(0, 0, 0, height);
          g.addColorStop(0, alpha(ink, 0.16)); g.addColorStop(1, alpha(ink, 0));
          ctx.fillStyle = g; ctx.fill(area);
        }
        ctx.strokeStyle = ink; ctx.lineWidth = 1.7; ctx.stroke(line);
      }
    }

    if (split != null) {
      if (!miniature) { ctx.strokeStyle = alpha(ink, 0.14); ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(split, 0); ctx.lineTo(split, height); ctx.stroke(); }
      ctx.strokeStyle = alpha(ink, 0.9); ctx.lineWidth = miniature ? 1 : 1.5; ctx.lineCap = "butt";
      ctx.beginPath(); ctx.moveTo(split, 0); ctx.lineTo(split, height); ctx.stroke();
    }

    if (!miniature && (this.visibleSteps.length || samples.length)) {
      const suffix = ftp === 0 && this.visibleSteps.length ? "%" : " W";
      ctx.font = `10px ${css("--number-font")}`; ctx.fillStyle = muted; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      for (let row = 1; row <= 3; row++) ctx.fillText(`${Math.floor(ceiling * (4 - row) / 4)}${suffix}`, 3, height * row / 4 - 8);
    }
    if (!miniature) this.drawHover();
  }

  drawHover() {
    if (!this.hoverCanvas) return;
    const { ctx, width, height } = this.sized(this.hoverCanvas);
    const duration = this.duration, hovered = this.hovered, ink = css("--ink");
    const mid = this.host.querySelector(".axis .mid"), end = this.host.querySelector(".axis .end");
    end.textContent = clockText(duration);
    this.tip.hidden = true;
    if (hovered == null) { mid.textContent = duration > 1 ? clockText(Math.floor(duration / 2)) : ""; return; }
    const hx = width * hovered / duration;
    ctx.fillStyle = alpha(ink, 0.5); ctx.fillRect(hx, 0, 1, height);
    const block = this.block(hovered);
    if (block) {
      mid.textContent = `${clockText(hovered)}   ·   ${block.label}`;
      if (block.start < duration) {
        const x0 = width * block.start / duration, x1 = width * Math.min(duration, block.start + block.seconds) / duration;
        const top = height * (1 - Math.min(1, Math.max(0, block.value / this.ceiling)));
        const r = new Path2D(); r.roundRect(x0 + 0.5, top + 0.5, Math.max(1, x1 - x0 - 1), Math.max(1, height - top - 1), 2.5);
        ctx.fillStyle = alpha(ink, 0.08); ctx.fill(r); ctx.strokeStyle = alpha(ink, 0.45); ctx.lineWidth = 1; ctx.stroke(r);
        this.tip.textContent = `${clockText(block.seconds)}   ${block.label}`;
        this.tip.hidden = false;
        this.tip.style.left = `${Math.min(Math.max((x0 + x1) / 2, 60), width - 60)}px`;
      }
    } else {
      const sample = this.o.samples[hovered - 1];
      mid.textContent = `${clockText(hovered)}   ·   ${sample?.power ?? "–"} W`;
    }
  }
}
