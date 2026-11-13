// Web Bluetooth sensors: a trainer (FTMS), a power meter (Cycling Power) and a heart-rate strap.
// Chrome and Edge only. Each role is paired with the browser's device chooser, then reconnects on drops.
import { parseCyclingPower, parseHeartRate, parseIndoorBike } from "./core.js";

export const roles = [
  { id: "trainer", name: "Trainer", service: 0x1826 },
  { id: "power", name: "Power", service: 0x1818 },
  { id: "heart", name: "Heart Rate", service: 0x180d }
];
const stateLabel = { connecting: "Connecting…", waiting: "Waiting for data", live: "Live", reconnecting: "Reconnecting…", unavailable: "Bluetooth unavailable" };
const fresh = 3000;

export class Devices {
  constructor(onChange) {
    this.onChange = onChange;
    this.links = {};          // role -> { device, name, state, reading, time, control }
    this.supported = Boolean(navigator.bluetooth);
  }

  name(role) { return this.links[role]?.name ?? "Not paired"; }
  label(role) { return stateLabel[this.links[role]?.state] ?? ""; }
  get canControl() { return Boolean(this.links.trainer?.control && this.links.trainer.state === "live"); }

  /** Opens the browser's Bluetooth chooser filtered to the role's service. Must run from a click. */
  async pair(role) {
    const spec = roles.find((r) => r.id === role);
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [spec.service] }],
      optionalServices: [0x1826, 0x1818, 0x180d]
    });
    this.forget(role);
    const link = { device, name: device.name || spec.name, state: "connecting", reading: {}, time: 0 };
    this.links[role] = link;
    device.addEventListener("gattserverdisconnected", () => this.reconnect(role, link));
    this.onChange();
    await this.connect(role, link);
  }

  forget(role) {
    const link = this.links[role];
    if (!link) return;
    link.forgotten = true;
    try { link.device.gatt.connected && link.device.gatt.disconnect(); } catch {}
    delete this.links[role];
    this.onChange();
  }

  async connect(role, link) {
    const server = await link.device.gatt.connect();
    if (link.forgotten) return server.disconnect();
    link.state = "waiting";
    this.onChange();
    const notify = async (service, characteristic, parse) => {
      const c = await (await server.getPrimaryService(service)).getCharacteristic(characteristic);
      c.addEventListener("characteristicvaluechanged", (event) => this.receive(role, link, parse(event.target.value)));
      await c.startNotifications();
      return c;
    };
    if (role === "trainer") {
      await notify(0x1826, 0x2ad2, parseIndoorBike);
      try {
        const point = await (await server.getPrimaryService(0x1826)).getCharacteristic(0x2ad9);
        await point.startNotifications();   // FTMS requires indications on before writes
        link.control = point;
        await point.writeValueWithResponse(Uint8Array.of(0x00)); // request control
        await point.writeValueWithResponse(Uint8Array.of(0x07)); // start or resume
      } catch { link.control = null; }
    } else if (role === "power") {
      await notify(0x1818, 0x2a63, parseCyclingPower);
    } else {
      await notify(0x180d, 0x2a37, parseHeartRate);
    }
  }

  async reconnect(role, link) {
    if (link.forgotten || this.links[role] !== link) return;
    link.state = "reconnecting";
    link.control = null;
    this.onChange();
    for (let attempt = 0; attempt < 20 && !link.forgotten; attempt++) {
      try { await this.connect(role, link); return; } catch { await new Promise((r) => setTimeout(r, Math.min(10000, 1000 * (attempt + 1)))); }
    }
  }

  receive(role, link, reading) {
    if (role === "power" && reading.crankRevolutions != null) {
      const previous = link.crank;
      if (previous) {
        const revs = (reading.crankRevolutions - previous.revs + 65536) % 65536;
        const ticks = (reading.crankEventTime - previous.time + 65536) % 65536;
        if (ticks > 0) link.cadence = { value: Math.round(revs * 60 * 1024 / ticks), time: performance.now() };
        else if (performance.now() - (link.cadence?.time ?? 0) > fresh) link.cadence = { value: 0, time: performance.now() };
      }
      link.crank = { revs: reading.crankRevolutions, time: reading.crankEventTime };
    }
    link.reading = reading;
    link.time = performance.now();
    if (link.state !== "live") { link.state = "live"; this.onChange(); }
    this.onReading?.();
  }

  value(role, key) {
    const link = this.links[role];
    if (!link || performance.now() - link.time > fresh) return null;
    return link.reading[key] ?? null;
  }
  /** A paired power meter wins over the trainer's own power reading. */
  power() { return this.value("power", "power") ?? this.value("trainer", "power"); }
  heart() { return this.value("heart", "heart") ?? this.value("trainer", "heart"); }
  cadence() {
    const meter = this.links.power?.cadence;
    if (meter && performance.now() - meter.time < fresh) return meter.value;
    const trainer = this.value("trainer", "cadence");
    return trainer == null ? null : Math.round(trainer);
  }

  /** Local development only (?simulate on localhost): a fake trainer so the UI can be exercised without hardware. */
  simulate() {
    const link = { name: "Simulated trainer", state: "live", reading: {}, time: 0, control: { writeValueWithResponse: async (bytes) => { if (bytes[0] === 0x05) link.target = bytes[1] | (bytes[2] << 8); } } };
    this.links.trainer = link;
    setInterval(() => {
      const base = link.target ?? 180;
      this.receive("trainer", link, { power: Math.round(base + (Math.random() - 0.5) * 20), cadence: 88 + Math.round(Math.random() * 4), heart: 138 + Math.round(Math.random() * 6) });
    }, 500);
    this.onChange();
  }

  /** ERG: ask the trainer to hold a target in watts. */
  async setPower(watts) {
    const control = this.links.trainer?.control;
    if (!control) return false;
    const value = Math.max(0, Math.min(2000, Math.round(watts)));
    try { await control.writeValueWithResponse(Uint8Array.of(0x05, value & 0xff, value >> 8)); return true; } catch { return false; }
  }
  async stopControl() {
    const control = this.links.trainer?.control;
    if (!control) return;
    try { await control.writeValueWithResponse(Uint8Array.of(0x08, 0x02)); } catch {} // pause, releases the resistance target
  }
}
