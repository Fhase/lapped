// Workouts, zones, ride stats and TCX: a direct port of the Indoor Trainer Mac app (Rides.swift).
// Pure functions only, so the server tests can import this file too.

/** One block of a workout. `end` makes it a linear ramp from `percent` to `end` (% FTP). */
export const interval = (seconds, percent, end = null) => ({ seconds, percent, end });
export const isRamp = (step) => step.end != null && step.end !== step.percent;
export function percentAt(step, offset) {
  if (step.end == null || step.seconds <= 0) return step.percent;
  const fraction = Math.min(1, Math.max(0, offset / step.seconds));
  return step.percent + (step.end - step.percent) * fraction;
}
export const wattsAt = (step, ftp, offset = 0) => Math.round(ftp * percentAt(step, offset) / 100);
export const averagePercent = (step) => (step.percent + (step.end ?? step.percent)) / 2;
export function meanSquaredIntensity(step) {
  const a = step.percent / 100, b = (step.end ?? step.percent) / 100;
  return (a * a + a * b + b * b) / 3;
}

const at = (seconds, percent) => interval(seconds, percent);
const ramp = (seconds, from, to) => interval(seconds, from, to);
const times = (count, block) => Array.from({ length: count }, () => block).flat();

function steps(id) {
  const warmUp = [ramp(600, 45, 70)];
  // Hard sessions add three short openers after the warm-up.
  const hardWarmUp = [...warmUp, ...times(3, [at(60, 100), at(60, 55)]), at(180, 55)];
  // Cool-down starts exactly where the last block ends (never above 70%), so the edges meet.
  const coolDown = (blocks) => {
    const last = blocks.length ? (blocks.at(-1).end ?? blocks.at(-1).percent) : 65;
    return [...blocks, ramp(480, Math.min(last, 70), 40)];
  };
  let main;
  switch (id) {
    case "free": return [];
    case "recovery": return [ramp(300, 40, 52), at(1200, 52), ramp(300, 52, 40)];
    case "recovery45": return [ramp(300, 40, 50), at(2100, 50), ramp(300, 50, 40)];
    case "recoverySpinUps": return [ramp(300, 40, 50), ...times(6, [at(240, 50), at(60, 58)]), ramp(300, 50, 40)];
    case "endurance45": main = [at(1800, 68)]; break;
    case "endurance120": main = [at(5700, 68)]; break;
    case "endurance180": main = [at(9300, 66)]; break;
    case "enduranceSurges": main = times(6, [at(540, 67), at(60, 90)]); break;
    case "enduranceProgression": main = [at(1200, 62), at(1200, 68), at(1200, 74)]; break;
    case "tempo3x15": main = times(3, [at(900, 80), at(300, 55)]); break;
    case "tempo45": main = [at(2700, 80)]; break;
    case "tempo60": main = [at(3600, 78)]; break;
    case "tempoSurges": main = times(3, [...times(4, [at(150, 80), at(30, 105)]), at(300, 55)]); break;
    case "sweetSpot4x10": main = times(4, [at(600, 90), at(240, 55)]); break;
    case "sweetSpot3x15": main = times(3, [at(900, 89), at(300, 55)]); break;
    case "sweetSpot2x30": main = times(2, [at(1800, 88), at(360, 55)]); break;
    case "sweetSpotOverUnders": main = times(3, [...times(3, [at(180, 88), at(60, 96)]), at(300, 55)]); break;
    case "threshold1x30": main = [at(1800, 96)]; break;
    case "threshold2x15": main = times(2, [at(900, 100), at(420, 55)]); break;
    case "threshold5x6": main = times(5, [at(360, 103), at(180, 55)]); break;
    case "thresholdRamps": main = times(3, [ramp(600, 95, 105), at(300, 55)]); break;
    case "thresholdSurges": main = times(2, [...times(5, [at(150, 95), at(30, 115)]), at(300, 55)]); break;
    case "vo2Max6x2": main = times(6, [at(120, 120), at(120, 50)]); break;
    case "vo2Max3x5": main = times(3, [at(300, 108), at(300, 50)]); break;
    case "fortyTwenty": main = times(3, [...times(10, [at(40, 125), at(20, 50)]), at(300, 55)]); break;
    case "vo2Pyramid": main = [at(60, 120), at(60, 50), at(120, 118), at(120, 50), at(180, 115), at(180, 50), at(120, 118), at(120, 50), at(60, 120), at(60, 50)]; break;
    case "tabata": main = times(2, [...times(8, [at(20, 170), at(10, 50)]), at(600, 55)]); break;
    case "oneMinuteRepeats": main = times(8, [at(60, 135), at(180, 50)]); break;
    case "anaerobic45s": main = times(2, [...times(4, [at(45, 150), at(135, 50)]), at(300, 55)]); break;
    case "standingStarts": main = [at(300, 65), ...times(8, [at(10, 220), at(290, 55)])]; break;
    case "sprintPyramid": main = [at(300, 65), at(10, 200), at(290, 55), at(15, 200), at(285, 55), at(20, 190), at(280, 55), at(15, 200), at(285, 55), at(10, 200), at(290, 55)]; break;
    case "eightMinuteTest": return coolDown([...warmUp, ...times(3, [at(60, 105), at(60, 55)]), at(300, 55), at(480, 105), at(600, 50), at(480, 105)]);
    case "endurance60": main = [at(2700, 68)]; break;
    case "endurance90": main = [at(4500, 68)]; break;
    case "openers": main = [at(900, 65), ...times(3, [at(60, 110), at(120, 55)]), ...times(3, [at(15, 180), at(165, 55)]), at(300, 65)]; break;
    case "tempo2x20": main = [at(1200, 82), at(300, 55), at(1200, 82), at(300, 55)]; break;
    case "tempoBuild": main = [at(720, 76), at(240, 55), at(720, 82), at(240, 55), at(720, 88), at(300, 55)]; break;
    case "sweetSpot3x10": main = times(3, [at(600, 90), at(300, 55)]); break;
    case "sweetSpot2x20": main = times(2, [at(1200, 89), at(300, 55)]); break;
    case "sweetSpotRamps": main = times(3, [ramp(720, 84, 94), at(300, 55)]); break;
    case "threshold2x20": main = times(2, [at(1200, 97), at(480, 55)]); break;
    case "threshold3x12": main = times(3, [at(720, 100), at(360, 55)]); break;
    case "threshold4x8": main = times(4, [at(480, 104), at(240, 55)]); break;
    case "overUnders": main = times(3, [...times(3, [at(120, 95), at(60, 105)]), at(300, 55)]); break;
    case "vo2Max5x3": main = times(5, [at(180, 118), at(180, 50)]); break;
    case "vo2Max4x4": main = times(4, [at(240, 112), at(180, 50)]); break;
    case "thirtyThirty": main = times(2, [...times(10, [at(30, 130), at(30, 50)]), at(300, 55)]); break;
    case "thirtyFifteen": main = times(3, [...times(13, [at(30, 120), at(15, 50)]), at(180, 55)]); break;
    case "sprints": main = [at(300, 65), ...times(6, [at(15, 200), at(285, 55)])]; break;
    case "rampTest": return coolDown([ramp(300, 40, 50), ...Array.from({ length: 20 }, (_, i) => at(60, 50 + 6 * i))]);
    case "ftpTest": return coolDown([...warmUp, ...times(3, [at(60, 105), at(60, 55)]), at(300, 55), at(300, 105), at(600, 50), at(1200, 100)]);
    default: return [];
  }
  // Easy sessions: the warm-up ramp ends exactly at the first block's level (never above 70%).
  const easy = ["openers", "endurance45", "endurance60", "endurance90", "endurance120", "endurance180", "enduranceSurges", "enduranceProgression",
    "tempo2x20", "tempoBuild", "tempo3x15", "tempo45", "tempo60", "tempoSurges"].includes(id);
  const opener = easy ? [ramp(600, 45, Math.min(70, main[0]?.percent ?? 70))] : hardWarmUp;
  return coolDown([...opener, ...main]);
}

const library = [
  ["free", "Free Ride", "Open", "Ride as long as you like. Power, heart rate and cadence are recorded.", "No plan. Ride as you feel."],
  ["recovery", "Recovery Spin", "Recovery", "Easy Z1 spin to promote blood flow without adding fatigue.", "20 min easy spin at 52% FTP."],
  ["recovery45", "Recovery 45", "Recovery", "A longer Z1 spin for the day after a hard block.", "35 min easy at 50% FTP."],
  ["recoverySpinUps", "Recovery Spin-Ups", "Recovery", "Easy spinning with light lifts to loosen the legs.", "6 × 4 min at 50% FTP with 1 min at 58%."],
  ["endurance45", "Endurance 45", "Endurance", "A short Z2 ride for aerobic base on a busy day.", "30 min steady at 68% FTP."],
  ["endurance60", "Endurance 60", "Endurance", "Steady Z2 for aerobic base: fat oxidation and mitochondrial density.", "45 min steady at 68% FTP."],
  ["endurance90", "Endurance 90", "Endurance", "Longer Z2 for aerobic durability.", "75 min steady at 68% FTP."],
  ["endurance120", "Endurance 2h", "Endurance", "Long Z2 for aerobic durability and fat use.", "95 min steady at 68% FTP."],
  ["endurance180", "Endurance 3h", "Endurance", "The long indoor Z2 day.", "155 min steady at 66% FTP."],
  ["enduranceSurges", "Endurance Surges", "Endurance", "Z2 with a short tempo lift every ten minutes to keep the legs awake.", "6 × 9 min at 67% FTP with 1 min at 90%."],
  ["enduranceProgression", "Endurance Progression", "Endurance", "Z2 that builds from easy to the top of the zone.", "20 min each at 62%, 68% and 74% FTP."],
  ["openers", "Pre-Race Openers", "Endurance", "Z2 with short efforts and sprints to sharpen the legs before an event.", "15 min at 65% FTP, 3 × 1 min at 110%, then 3 × 15 s sprints."],
  ["tempo2x20", "Tempo 2×20", "Tempo", "Two 20-minute Z3 blocks for muscular endurance.", "2 × 20 min at 82% FTP with 5 min easy between."],
  ["tempoBuild", "Tempo Builds", "Tempo", "Three tempo blocks, each a step harder.", "3 × 12 min at 76%, 82% and 88% FTP with 4 min easy between."],
  ["tempo3x15", "Tempo 3×15", "Tempo", "Three Z3 blocks for steady muscular endurance.", "3 × 15 min at 80% FTP with 5 min easy between."],
  ["tempo45", "Tempo 45", "Tempo", "One unbroken Z3 effort.", "45 min at 80% FTP."],
  ["tempo60", "Tempo 60", "Tempo", "An hour of steady tempo for long-event pacing.", "60 min at 78% FTP."],
  ["tempoSurges", "Tempo Surges", "Tempo", "Tempo with short surges above threshold, like riding in a group.", "3 sets of 4 × (2.5 min at 80%, 30 s at 105% FTP) with 5 min easy between."],
  ["sweetSpot3x10", "Sweet Spot 3×10", "Sweet Spot", "88–93% FTP: high aerobic stimulus with manageable fatigue.", "3 × 10 min at 90% FTP with 5 min easy between."],
  ["sweetSpot2x20", "Sweet Spot 2×20", "Sweet Spot", "Classic sweet spot blocks to raise FTP.", "2 × 20 min at 89% FTP with 5 min easy between."],
  ["sweetSpotRamps", "Sweet Spot Ramps", "Sweet Spot", "Sweet spot blocks that climb from 84% to 94% FTP.", "3 × 12 min ramping from 84% to 94% FTP with 5 min easy between."],
  ["sweetSpot4x10", "Sweet Spot 4×10", "Sweet Spot", "Four sweet spot blocks with short rests.", "4 × 10 min at 90% FTP with 4 min easy between."],
  ["sweetSpot3x15", "Sweet Spot 3×15", "Sweet Spot", "Longer sweet spot blocks for time at intensity.", "3 × 15 min at 89% FTP with 5 min easy between."],
  ["sweetSpot2x30", "Sweet Spot 2×30", "Sweet Spot", "Two long sweet spot blocks: an hour near FTP.", "2 × 30 min at 88% FTP with 6 min easy between."],
  ["sweetSpotOverUnders", "Sweet Spot Over-Unders", "Sweet Spot", "Sweet spot with lifts just under threshold.", "3 sets of 3 × (3 min at 88%, 1 min at 96% FTP) with 5 min easy between."],
  ["threshold1x30", "Threshold 1×30", "Threshold", "One long threshold effort.", "30 min at 96% FTP."],
  ["threshold2x15", "Threshold 2×15", "Threshold", "Two solid blocks right at FTP.", "2 × 15 min at 100% FTP with 7 min easy between."],
  ["threshold2x20", "Threshold 2×20", "Threshold", "The classic FTP builder at 95–100% FTP.", "2 × 20 min at 97% FTP with 8 min easy between."],
  ["threshold3x12", "Threshold 3×12", "Threshold", "Threshold at 100% FTP in shorter blocks.", "3 × 12 min at 100% FTP with 6 min easy between."],
  ["threshold4x8", "Threshold 4×8", "Threshold", "Slightly above FTP to lift the ceiling.", "4 × 8 min at 104% FTP with 4 min easy between."],
  ["threshold5x6", "Threshold 5×6", "Threshold", "Short blocks above FTP to raise the ceiling.", "5 × 6 min at 103% FTP with 3 min easy between."],
  ["thresholdRamps", "Threshold Ramps", "Threshold", "Blocks that climb through threshold.", "3 × 10 min ramping from 95% to 105% FTP with 5 min easy between."],
  ["thresholdSurges", "Threshold Surges", "Threshold", "Threshold with short surges to practise clearing lactate.", "2 sets of 5 × (2.5 min at 95%, 30 s at 115% FTP) with 5 min easy between."],
  ["overUnders", "Over-Unders", "Threshold", "Alternating 95% and 105% FTP to train lactate clearance.", "3 sets of 9 min alternating 2 min at 95% and 1 min at 105% FTP."],
  ["vo2Max5x3", "VO₂ Max 5×3", "VO₂ Max", "3-minute Z5 efforts at 118% FTP for maximal aerobic power.", "5 × 3 min at 118% FTP with 3 min easy between."],
  ["vo2Max4x4", "VO₂ Max 4×4", "VO₂ Max", "4×4 minutes at about 112% FTP (Helgerud protocol).", "4 × 4 min at 112% FTP with 3 min easy between."],
  ["vo2Max6x2", "VO₂ Max 6×2", "VO₂ Max", "Short, hard Z5 efforts with equal rest.", "6 × 2 min at 120% FTP with 2 min easy between."],
  ["vo2Max3x5", "VO₂ Max 3×5", "VO₂ Max", "Long VO₂ max efforts just above 105% FTP.", "3 × 5 min at 108% FTP with 5 min easy between."],
  ["vo2Pyramid", "VO₂ Pyramid", "VO₂ Max", "1, 2, 3, 2, 1 minutes at VO₂ max with equal rest.", "1-2-3-2-1 min at 115–120% FTP, equal rest between."],
  ["fortyTwenty", "40/20s", "VO₂ Max", "40 s on, 20 s off: more time near VO₂ max than 30/30s.", "3 sets of 10 × 40 s at 125% FTP, 20 s easy between."],
  ["thirtyThirty", "30/30s", "VO₂ Max", "30 s on / 30 s off at 130% FTP to accumulate time near VO₂ max (Billat).", "2 sets of 10 × 30 s at 130% FTP, 30 s easy between."],
  ["thirtyFifteen", "30/15s", "VO₂ Max", "30 s on / 15 s off at 120% FTP (Rønnestad short intervals).", "3 sets of 13 × 30 s at 120% FTP, 15 s easy between."],
  ["tabata", "Tabata", "Anaerobic", "20 s all-out, 10 s easy, eight times. Twice.", "2 sets of 8 × 20 s at 170% FTP, 10 s easy between."],
  ["oneMinuteRepeats", "1-Minute Repeats", "Anaerobic", "Minute-long efforts well above VO₂ max for anaerobic capacity.", "8 × 1 min at 135% FTP with 3 min easy between."],
  ["anaerobic45s", "Anaerobic 45s", "Anaerobic", "45-second efforts at 150% FTP with long recoveries.", "2 sets of 4 × 45 s at 150% FTP, 2¼ min easy between."],
  ["sprints", "Sprints", "Sprint", "Short maximal sprints with full recovery for peak power.", "6 × 15 s sprints at 200% FTP with almost 5 min easy between."],
  ["standingStarts", "Standing Starts", "Sprint", "Ten-second sprints from slow speed for raw power.", "8 × 10 s at 220% FTP with almost 5 min easy between."],
  ["sprintPyramid", "Sprint Pyramid", "Sprint", "Sprints of 10, 15, 20, 15 and 10 seconds with full recovery.", "10-15-20-15-10 s sprints at about 200% FTP, almost 5 min easy between."],
  ["rampTest", "Ramp Test", "Test", "1-minute steps rising 6% FTP each. Ride until you can't hold the target; estimated FTP ≈ 75% of your best minute.", "1 min steps from 50% FTP, up 6% each minute, until you can't hold it."],
  ["eightMinuteTest", "8-Minute FTP Test", "Test", "Two 8-minute efforts. Estimated FTP ≈ 90% of the better 8-minute average.", "2 × 8 min as hard as you can hold evenly, 10 min easy between."],
  ["ftpTest", "20-Minute FTP Test", "Test", "Hold your best 20-minute power. Estimated FTP ≈ 95% of the 20-minute average.", "5 min at 105% FTP, 10 min easy, then 20 min as hard as you can hold evenly."]
];

/** Fifty structured sessions (% FTP, Coggan zones) plus Free Ride, in the Mac app's order. */
export const workouts = library.map(([id, name, category, summary, structure]) => {
  const plan = steps(id);
  return { id, name, category, summary, structure, steps: plan, minutes: Math.floor(plan.reduce((s, x) => s + x.seconds, 0) / 60) };
});
export const workoutNamed = (name) => workouts.find((w) => w.name === name);

/** Training Stress Score of the plan: Σ seconds × IF² / 3600 × 100. */
export const trainingStress = (plan) => Math.round(plan.reduce((t, s) => t + s.seconds * meanSquaredIntensity(s), 0) / 36);
export const peakTarget = (plan, ftp) => Math.max(0, ...plan.map((s) => Math.max(wattsAt(s, ftp), wattsAt(s, ftp, s.seconds))));
export function averageTarget(plan, ftp) {
  const seconds = plan.reduce((t, s) => t + s.seconds, 0);
  if (!seconds) return 0;
  return Math.round(ftp * plan.reduce((t, s) => t + averagePercent(s) * s.seconds, 0) / 100 / seconds);
}

/** Coggan zones: upper bounds of zones 1–5 in % FTP; above 120% is zone 6. */
export const zoneBounds = [55, 75, 90, 105, 120];
export const zoneForPercent = (percent) => (zoneBounds.findIndex((b) => percent <= b) + 1) || 6;
export const zoneForWatts = (watts, ftp) => (watts == null || ftp <= 0 ? null : zoneForPercent(watts * 100 / ftp));

/** Current interval of a ride: index and seconds remaining, or null once the plan is done. */
export function currentStep(plan, elapsed) {
  let offset = elapsed;
  for (let index = 0; index < plan.length; index++) {
    if (offset < plan[index].seconds) return { index, remaining: plan[index].seconds - offset };
    offset -= plan[index].seconds;
  }
  return null;
}

export const clockText = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  const two = (n) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
};

export const virtualSpeed = (watts) => 32 * Math.cbrt(Math.max(0, watts) / 200);

/** Averages of every full `seconds`-long window, one per second. */
export function rollingAverages(values, seconds) {
  if (seconds <= 0 || values.length < seconds) return [];
  let window = values.slice(0, seconds).reduce((a, b) => a + b, 0);
  const result = [window / seconds];
  for (let i = seconds; i < values.length; i++) {
    window += values[i] - values[i - seconds];
    result.push(window / seconds);
  }
  return result;
}

/** Ride stats from recorded samples. NP: 4th-power mean of the 30 s rolling average; TSS = hours × IF² × 100. */
export function rideStats(ride, samples) {
  const stats = {};
  const powers = samples.map((s) => s.power).filter((p) => p != null);
  const hearts = samples.map((s) => s.heart).filter((h) => h != null);
  if (powers.length) {
    let meters = 0;
    for (const p of powers) meters += virtualSpeed(p) / 3.6;
    stats.distanceKm = meters / 1000;
    stats.speed = ride.elapsed > 0 ? meters / ride.elapsed * 3.6 : null;
    const sum = powers.reduce((a, b) => a + b, 0);
    stats.averagePower = Math.floor(sum / powers.length);
    stats.maxPower = Math.max(...powers);
    stats.kilojoules = Math.floor(sum / 1000);
    const rolling = rollingAverages(powers, 30);
    if (rolling.length) {
      stats.normalizedPower = Math.round((rolling.reduce((t, v) => t + v ** 4, 0) / rolling.length) ** 0.25);
      if (ride.ftp > 0) {
        stats.intensity = stats.normalizedPower / ride.ftp;
        stats.stress = Math.round(ride.elapsed / 3600 * stats.intensity ** 2 * 100);
      }
    }
  }
  if (hearts.length) {
    stats.averageHeart = Math.floor(hearts.reduce((a, b) => a + b, 0) / hearts.length);
    stats.maxHeart = Math.max(...hearts);
  }
  const planned = ride.steps.reduce((t, s) => t + s.seconds, 0);
  if (planned > 0) stats.completion = Math.min(100, Math.floor(ride.elapsed * 100 / planned));
  // Dropouts count as 0 W so a test can't be inflated by missing data.
  const timeline = samples.map((s) => s.power ?? 0);
  const best = (seconds) => Math.max(...rollingAverages(timeline, seconds));
  // A test only scores once its effort is ridden (the FTP is then set automatically): the ramp after 8 minutes,
  // the 8- and 20-minute tests once they reach the cool-down. Ending a test in its warm-up changes nothing.
  const effortDone = ride.elapsed >= planned - (ride.steps.at(-1)?.seconds ?? 0);
  if (ride.name === "Ramp Test" && ride.elapsed >= 480 && timeline.length >= 60) stats.ftpEstimate = Math.round(best(60) * 0.75);
  if (ride.name === "20-Minute FTP Test" && effortDone && timeline.length >= 1200) stats.ftpEstimate = Math.round(best(1200) * 0.95);
  if (ride.name === "8-Minute FTP Test" && effortDone && timeline.length >= 480) stats.ftpEstimate = Math.round(best(480) * 0.9);
  return stats;
}

/** Strava description: workout name, what it is, time and how much was completed. */
/** Strava description in lapped's receipt style: lowercase, dot-separated, link last. */
export function rideSummary(ride, samples) {
  const stats = rideStats(ride, samples);
  // The workout name is the activity title only. np and tss are always listed: "–" when the ride
  // had under 30 s of power (np) or no FTP when it started (tss).
  return [
    `np · ${stats.normalizedPower != null ? `${stats.normalizedPower} w` : "–"}`,
    `tss · ${stats.stress ?? "–"}`,
    clockText(ride.elapsed) + (stats.completion != null ? ` · ${stats.completion}% done` : ""),
    "lapped.fit/trainer"
  ].filter(Boolean).join("\n");
}

/** Garmin TCX with a continuous active-time track, so pauses do not inflate the duration. */
export function tcx(ride, samples) {
  const start = new Date(ride.started).toISOString().replace(/\.\d{3}Z$/, "Z");
  let meters = 0, hasPower = false;
  const points = samples.map((sample, index) => {
    const time = new Date(ride.started + (index + 1) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    let speed = null;
    if (sample.power != null) { speed = virtualSpeed(sample.power) / 3.6; meters += speed; hasPower = true; }
    const distance = hasPower ? `<DistanceMeters>${meters}</DistanceMeters>` : "";
    const heart = sample.heart != null && sample.heart >= 0 && sample.heart <= 255 ? `<HeartRateBpm><Value>${sample.heart}</Value></HeartRateBpm>` : "";
    const power = speed != null ? `<Extensions><ae:TPX><ae:Speed>${speed}</ae:Speed><ae:Watts>${Math.max(0, sample.power)}</ae:Watts></ae:TPX></Extensions>` : "";
    return `<Trackpoint><Time>${time}</Time><AltitudeMeters>0</AltitudeMeters>${distance}${heart}${power}</Trackpoint>`;
  }).join("\n");
  const track = points ? `<Track>${points}</Track>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ae="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
<Activities><Activity Sport="Biking"><Id>${start}</Id>
<Lap StartTime="${start}"><TotalTimeSeconds>${ride.elapsed}</TotalTimeSeconds><DistanceMeters>${meters}</DistanceMeters>
<Calories>0</Calories><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>${track}</Lap>
</Activity></Activities></TrainingCenterDatabase>`;
}

// Bluetooth packet parsers (FTMS Indoor Bike Data, Cycling Power Measurement, Heart Rate Measurement).

/** FTMS Indoor Bike Data (0x2AD2): instantaneous power and cadence when present. */
export function parseIndoorBike(view) {
  const flags = view.getUint16(0, true);
  let o = 2;
  const out = {};
  if (!(flags & 0x0001)) o += 2;            // instantaneous speed present when "more data" is 0
  if (flags & 0x0002) o += 2;               // average speed
  if (flags & 0x0004) { if (view.byteLength >= o + 2) out.cadence = view.getUint16(o, true) / 2; o += 2; }
  if (flags & 0x0008) o += 2;               // average cadence
  if (flags & 0x0010) o += 3;               // total distance
  if (flags & 0x0020) o += 2;               // resistance level
  if (flags & 0x0040) { if (view.byteLength >= o + 2) out.power = view.getInt16(o, true); o += 2; }
  if (flags & 0x0080) o += 2;               // average power
  if (flags & 0x0100) o += 5;               // expended energy
  if (flags & 0x0200) { if (view.byteLength >= o + 1) out.heart = view.getUint8(o); o += 1; }
  return out;
}

/** Cycling Power Measurement (0x2A63): power, plus crank data for cadence. */
export function parseCyclingPower(view) {
  const flags = view.getUint16(0, true);
  const out = { power: view.getInt16(2, true) };
  let o = 4;
  if (flags & 0x0001) o += 1;               // pedal power balance
  if (flags & 0x0004) o += 2;               // accumulated torque
  if (flags & 0x0010) o += 6;               // wheel revolutions
  if (flags & 0x0020 && view.byteLength >= o + 4) {
    out.crankRevolutions = view.getUint16(o, true);
    out.crankEventTime = view.getUint16(o + 2, true);
  }
  return out;
}

/** Heart Rate Measurement (0x2A37). */
export function parseHeartRate(view) {
  const flags = view.getUint8(0);
  return { heart: flags & 0x01 ? view.getUint16(1, true) : view.getUint8(1) };
}
