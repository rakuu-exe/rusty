/**
 * Speed profile of every Chinook in a recorded feed.
 *
 * The crate-drop inference assumes a Chinook cruises fast and then hovers to
 * lower the crate. That assumption is reasoned, not measured — this prints the
 * actual numbers so the thresholds in detector.ts can be calibrated against a
 * real flight instead of an estimate.
 *
 * Usage: node scripts/analyse-chinooks.mjs test/fixtures/markers-*.live.jsonl
 */

import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/analyse-chinooks.mjs <recording.jsonl> [...]');
  process.exit(1);
}

const CH47 = 4;

/** id -> [{t, x, y}] across every file, in order. */
const tracks = new Map();
let snapshots = 0;
const typeCounts = new Map();

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    const snap = JSON.parse(line);
    snapshots++;
    for (const m of snap.markers) {
      typeCounts.set(m.type, (typeCounts.get(m.type) ?? 0) + 1);
      if (m.type !== CH47) continue;
      if (!tracks.has(m.id)) tracks.set(m.id, []);
      tracks.get(m.id).push({ t: new Date(snap.t), x: m.x, y: m.y });
    }
  }
}

console.log(`snapshots : ${snapshots}`);
console.log(`marker types seen: ${[...typeCounts.entries()].map(([t, n]) => `${t}(x${n})`).join(' ') || 'none'}`);
console.log(`chinooks  : ${tracks.size}`);

if (tracks.size === 0) {
  console.log('\nNo Chinooks in this recording, so the thresholds remain uncalibrated.');
  process.exit(0);
}

for (const [id, points] of tracks) {
  console.log(`\n=== Chinook ${id} — ${points.length} samples ===`);

  const speeds = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seconds = (b.t - a.t) / 1000;
    if (seconds <= 0) continue;
    const speed = Math.hypot(b.x - a.x, b.y - a.y) / seconds;
    speeds.push({ speed, at: b.t, x: b.x, y: b.y });
  }

  if (speeds.length === 0) continue;

  const values = speeds.map((s) => s.speed).sort((a, b) => a - b);
  const pct = (p) => values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))];

  console.log(`  speed u/s: min=${values[0].toFixed(1)} p25=${pct(0.25).toFixed(1)} median=${pct(0.5).toFixed(1)} p75=${pct(0.75).toFixed(1)} max=${values.at(-1).toFixed(1)}`);

  // The signature the inference relies on: a run of near-zero speed.
  let longestStill = 0;
  let run = 0;
  for (const s of speeds) {
    if (s.speed <= 5) { run++; longestStill = Math.max(longestStill, run); }
    else run = 0;
  }
  console.log(`  longest run under 5 u/s: ${longestStill} samples`);
  console.log(`  ${longestStill >= 2 ? 'HOVER DETECTED -> would infer a drop' : 'no hover -> no drop inferred'}`);

  // Full trace, so a hover can be eyeballed against where it happened.
  for (const s of speeds) {
    const bar = s.speed <= 5 ? 'HOVER' : '';
    console.log(`    ${s.at.toISOString().slice(11, 19)}  ${s.speed.toFixed(1).padStart(6)} u/s  x=${s.x.toFixed(0).padStart(6)} y=${s.y.toFixed(0).padStart(6)}  ${bar}`);
  }
}
