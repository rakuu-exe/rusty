/**
 * Refresh data/items.json from an upstream Rust item list.
 *
 * Vending sell orders carry only numeric item ids, so every vending feature
 * depends on this map being right. It goes stale on every game update, and
 * stale here is not obvious: an unknown id renders as "item -12345", and a
 * *renamed* item renders as the wrong name with no warning at all. That
 * happened — the first snapshot had 'Work Bench Level 1' for what the game
 * calls 'Workbench Level 1', and worse, one window item carried another's
 * name entirely.
 *
 * Ids that exist locally but not upstream are preserved rather than dropped:
 * losing a working id would be a regression, and old cosmetics cost nothing.
 *
 * Usage: node scripts/fetch-items.mjs [--dry-run]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SOURCE =
  'https://raw.githubusercontent.com/alexemanuelol/rustplusplus/master/src/staticFiles/items.json';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../../data/items.json');
const dryRun = process.argv.includes('--dry-run');

const response = await fetch(SOURCE);
if (!response.ok) {
  console.error(`fetch failed: HTTP ${response.status} from ${SOURCE}`);
  process.exit(1);
}

const reference = await response.json();
const refCount = Object.keys(reference).length;

// A truncated or restructured upstream would silently gut the data set, so
// refuse anything that does not look like the full list.
if (refCount < 1000) {
  console.error(`refusing to write: upstream returned only ${refCount} items`);
  process.exit(1);
}

let existing = {};
try {
  existing = JSON.parse(readFileSync(target, 'utf8'));
} catch {
  console.log('no existing items.json; writing a fresh one');
}

const next = {};
for (const [id, item] of Object.entries(reference)) {
  next[id] = { name: item.name, short: item.shortname };
}

const renamed = [];
const added = [];
let preserved = 0;

for (const [id, item] of Object.entries(existing)) {
  if (!next[id]) {
    next[id] = item;
    preserved += 1;
  } else if (next[id].name !== item.name) {
    renamed.push(`  ${id}: '${item.name}' -> '${next[id].name}'`);
  }
}
for (const id of Object.keys(next)) if (!existing[id]) added.push(id);

// Numeric key order keeps regenerated files diffable against each other.
const sorted = Object.fromEntries(
  Object.keys(next)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => [k, next[k]]),
);

console.log(`upstream: ${refCount}   added: ${added.length}   renamed: ${renamed.length}   preserved locally: ${preserved}`);
if (renamed.length > 0) {
  console.log('renames:');
  for (const line of renamed) console.log(line);
}

if (dryRun) {
  console.log('\n--dry-run: nothing written');
  process.exit(0);
}

writeFileSync(target, JSON.stringify(sorted));
console.log(`\nwrote ${Object.keys(sorted).length} items to ${target}`);
