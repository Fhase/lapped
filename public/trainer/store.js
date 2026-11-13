// Ride storage in the browser (IndexedDB). Every recorded second is committed before the next one,
// so a closed tab, crash or reload keeps the ride up to its last second and it comes back paused.

const open = () => new Promise((resolve, reject) => {
  const request = indexedDB.open("indoor-trainer", 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("rides", { keyPath: "id" });
    db.createObjectStore("samples", { keyPath: ["ride", "second"] });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error || new Error("Could not save to browser storage."));
});
const result = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export class RideStore {
  static async open() {
    const store = new RideStore();
    store.db = await open();
    // Ask the browser not to evict ride data under storage pressure.
    navigator.storage?.persist?.().catch(() => {});
    return store;
  }

  async rides() {
    return result(this.db.transaction("rides").objectStore("rides").getAll());
  }

  async begin(workout, ftp, athlete) {
    const ride = { id: crypto.randomUUID(), name: workout.name, started: Date.now(), ftp, steps: workout.steps, elapsed: 0, state: "running", athlete };
    const tx = this.db.transaction("rides", "readwrite");
    tx.objectStore("rides").put(ride);
    await done(tx);
    return ride;
  }

  /** Writes the sample for second `ride.elapsed + 1` and the advanced ride in one transaction. */
  async append(ride, sample, finish) {
    const tx = this.db.transaction(["rides", "samples"], "readwrite");
    tx.objectStore("samples").put({ ride: ride.id, second: ride.elapsed + 1, time: sample.time, power: sample.power, heart: sample.heart });
    tx.objectStore("rides").put({ ...ride, elapsed: ride.elapsed + 1, state: finish ? "finished" : ride.state, ...(finish ? summary([], ride) : {}) });
    await done(tx);
  }

  async update(ride) {
    const tx = this.db.transaction("rides", "readwrite");
    tx.objectStore("rides").put(ride);
    await done(tx);
  }

  async samples(ride) {
    const range = IDBKeyRange.bound([ride.id, 0], [ride.id, Infinity]);
    const rows = await result(this.db.transaction("samples").objectStore("samples").getAll(range));
    return rows.map(({ time, power, heart }) => ({ time, power, heart }));
  }

  /** Stores a ride saved on lapped (from another browser) with its samples, numbered from second 1. */
  async put(ride, samples) {
    const tx = this.db.transaction(["rides", "samples"], "readwrite");
    tx.objectStore("rides").put(ride);
    samples.forEach(({ time, power, heart }, i) => tx.objectStore("samples").put({ ride: ride.id, second: i + 1, time, power, heart }));
    await done(tx);
  }

  /** Saves a ride as finished, with its averages for the History list. */
  async finish(ride) {
    const samples = await this.samples(ride);
    const finished = { ...ride, state: "finished", ...summary(samples, ride) };
    await this.update(finished);
    return finished;
  }

  /** Permanently removes a ride and its samples. */
  async remove(ride) {
    const tx = this.db.transaction(["rides", "samples"], "readwrite");
    tx.objectStore("rides").delete(ride.id);
    tx.objectStore("samples").delete(IDBKeyRange.bound([ride.id, 0], [ride.id, Infinity]));
    await done(tx);
  }
}

function summary(samples, ride) {
  const mean = (key) => {
    const values = samples.map((s) => s[key]).filter((v) => v != null);
    return values.length ? Math.floor(values.reduce((a, b) => a + b, 0) / values.length) : (ride[key === "power" ? "avgPower" : "avgHeart"] ?? null);
  };
  return { avgPower: mean("power"), avgHeart: mean("heart") };
}
