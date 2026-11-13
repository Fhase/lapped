// Web Bluetooth sensors: a trainer (FTMS), a power meter (Cycling Power) and a heart-rate strap.
// Chrome and Edge only. Each role is paired with the browser's device chooser, then reconnects on drops.
import { parseCyclingPower, parseHeartRate, parseIndoorBike } from "./core.js";

export const roles = [
  { id: "trainer", name: "Trainer", service: 0x1826 },
  { id: "power", name: "Power", service: 0x1818 },
  { id: "heart", name: "Heart Rate", service: 0x180d }
];
const stateLabel = { connecting: "Connecting…", waiting: "Waiting for data", live: "Live", reconnecting: "Reconnecting…", unavailable: "Bluetooth unavailable", closed: "Simulator closed" };
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
    if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability())) {
      throw new Error("Bluetooth is off, or this browser isn't allowed to use it. On a Mac, check System Settings › Privacy & Security › Bluetooth for Chrome.");
    }
    // Many trainers advertise only Cycling Power, so the trainer chooser lists both services.
    const services = role === "trainer" ? [0x1826, 0x1818] : [spec.service];
    const device = await navigator.bluetooth.requestDevice({
      filters: services.map((service) => ({ services: [service] })),
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
    link.socket?.close();
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
      link.control = null;
      link.owns = false; link.started = false; link.queue = Promise.resolve();
      let ftms = null;
      try { ftms = await server.getPrimaryService(0x1826); } catch {}
      if (!ftms) return void await notify(0x1818, 0x2a63, parseCyclingPower); // power only, no ERG
      await notify(0x1826, 0x2ad2, parseIndoorBike);
      try {
        const point = await ftms.getCharacteristic(0x2ad9);
        // FTMS answers every command with an indication: 0x80, opcode, result (1 = success).
        point.addEventListener("characteristicvaluechanged", (event) => {
          const v = event.target.value;
          if (v.byteLength >= 3 && v.getUint8(0) === 0x80) link.answer?.(v.getUint8(1), v.getUint8(2));
        });
        await point.startNotifications();   // indications must be on before writes
        link.control = point;
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

  /**
   * Trainer Simulator on this Mac. A Mac can't see its own Bluetooth advertisement, so the simulator
   * serves the same GATT payloads over a WebSocket on 127.0.0.1:47827. The trainer link keeps the FTMS
   * control path, so ERG runs exactly as with a real trainer; the heart link reads its strap.
   */
  /** True when Trainer Simulator is running on this Mac (quick local check, no Bluetooth). */
  simulatorAvailable(url = "ws://127.0.0.1:47827") {
    return new Promise((resolve) => {
      let socket;
      const finish = (found) => { clearTimeout(timer); try { socket?.close(); } catch {} resolve(found); };
      const timer = setTimeout(() => finish(false), 600);
      try { socket = new WebSocket(url); } catch { return finish(false); }
      socket.onopen = () => finish(true);
      socket.onerror = () => finish(false);
    });
  }

  connectSimulator(role, url = "ws://127.0.0.1:47827") {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      const link = { name: "Trainer Sim · This Mac", state: "connecting", reading: {}, time: 0, socket };
      if (role === "trainer") {
        link.owns = false; link.started = false; link.queue = Promise.resolve();
        link.control = { writeValueWithResponse: async (bytes) => socket.send(Uint8Array.of(0xd9, 0x2a, bytes.length, ...bytes)) };
      }
      socket.onopen = () => {
        this.forget(role);
        this.links[role] = link;
        link.state = "waiting";
        this.onChange();
        resolve();
      };
      socket.onerror = () => reject(new Error("Trainer Simulator isn't reachable. Open it on this Mac, press Start, then try again."));
      socket.onclose = () => {
        if (link.forgotten || this.links[role] !== link) return;
        link.state = "closed"; link.control = null;
        this.onChange();
      };
      socket.onmessage = (event) => {
        const bytes = new Uint8Array(event.data);
        for (let at = 0; at + 3 <= bytes.length;) {
          const uuid = bytes[at] | (bytes[at + 1] << 8), length = bytes[at + 2];
          const payload = new DataView(bytes.buffer, at + 3, length);
          at += 3 + length;
          if (role === "trainer" && uuid === 0x2ad2) this.receive(role, link, parseIndoorBike(payload));
          else if (role === "trainer" && uuid === 0x2ad9 && length >= 3 && payload.getUint8(0) === 0x80) link.answer?.(payload.getUint8(1), payload.getUint8(2));
          else if (role === "power" && uuid === 0x2a63) this.receive(role, link, parseCyclingPower(payload));
          else if (role === "heart" && uuid === 0x2a37) this.receive(role, link, parseHeartRate(payload));
        }
      };
    });
  }

  /** Local development only (?simulate on localhost): a fake trainer so the UI can be exercised without hardware. */
  simulate() {
    const link = { name: "Simulated trainer", state: "live", reading: {}, time: 0, control: {} };
    link.owns = false; link.started = false; link.queue = Promise.resolve();
    link.control.writeValueWithResponse = async (bytes) => {
      if (bytes[0] === 0x05) link.target = bytes[1] | (bytes[2] << 8);
      setTimeout(() => link.answer?.(bytes[0], 1), 20);
    };
    this.links.trainer = link;
    setInterval(() => {
      const base = link.target ?? 180;
      this.receive("trainer", link, { power: Math.round(base + (Math.random() - 0.5) * 20), cadence: 88 + Math.round(Math.random() * 4), heart: 138 + Math.round(Math.random() * 6) });
    }, 500);
    this.onChange();
  }

  /** Sends one FTMS control command and waits for the trainer's confirmation (same sequence as the Mac app). */
  async command(link, bytes) {
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Trainer did not confirm ERG command")), 3000);
      link.answer = (opcode, result) => {
        if (opcode !== bytes[0]) return;
        clearTimeout(timer); link.answer = null;
        result === 1 ? resolve() : reject(new Error(`Trainer rejected ERG command (${result})`));
      };
    });
    await link.control.writeValueWithResponse(Uint8Array.from(bytes));
    await answered;
  }

  /** ERG: take control, start, then set the target in watts. Commands run one at a time. */
  setPower(watts) {
    const link = this.links.trainer;
    if (!link?.control) return Promise.resolve(false);
    const value = Math.max(0, Math.min(2000, Math.round(watts)));
    link.queue = link.queue.then(async () => {
      if (!link.owns) { await this.command(link, [0x00]); link.owns = true; }
      if (!link.started) { await this.command(link, [0x07]); link.started = true; }
      await this.command(link, [0x05, value & 0xff, value >> 8]);
      return true;
    }).catch((error) => { link.owns = false; link.started = false; this.onError?.(error.message); return false; });
    return link.queue;
  }

  /** Releases ERG: Stop (0x08 0x01), so the trainer drops the resistance target. */
  stopControl() {
    const link = this.links.trainer;
    if (!link?.control) return Promise.resolve();
    link.queue = link.queue.then(async () => {
      if (link.started) { await this.command(link, [0x08, 0x01]); link.started = false; }
    }).catch((error) => { link.started = false; this.onError?.("Trainer did not confirm release. Resistance may remain active. " + error.message); });
    return link.queue;
  }
}
