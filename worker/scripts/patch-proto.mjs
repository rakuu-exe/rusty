/**
 * Relaxes the bundled Rust+ protobuf schema so missing fields do not crash us.
 *
 * @liamcottle/rustplus.js ships a proto2 schema where 125 fields are marked
 * `required`. Facepunch changes the companion API without notice, and when a
 * server stops sending a field that the schema still calls required, protobufjs
 * throws during decode:
 *
 *   ProtocolError: missing required 'queuedPlayers'
 *
 * That throw happens inside the library's WebSocket message handler, so it
 * cannot be caught by application code — it takes the whole process down.
 * This was observed live against Rustafied EU Trio, whose AppInfo response
 * omits both `queuedPlayers` and `salt` while adding `nexus`/`nexusZone`.
 *
 * Rewriting `required` to `optional` makes decoding tolerant: absent fields
 * arrive as undefined instead of raising. We lose schema validation, but the
 * code already treats every Rust+ field as best-effort (see src/rustplus/
 * types.ts), and a bot that silently drops one field beats a bot that dies.
 *
 * Runs on postinstall so it survives `npm install` wiping node_modules.
 * Idempotent.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let protoPath;
try {
  protoPath = require.resolve('@liamcottle/rustplus.js/rustplus.proto');
} catch {
  console.error('patch-proto: could not locate rustplus.proto -- is the package installed?');
  process.exit(0); // Not fatal: npm install may be running before deps exist.
}

const original = readFileSync(protoPath, 'utf8');

// Only touch field declarations, i.e. `required <type> <name> = <n>;`
const patched = original.replace(/(^|\s)required(\s+)/g, '$1optional$2');

const remaining = (patched.match(/\brequired\b/g) ?? []).length;
const changed = (original.match(/\brequired\b/g) ?? []).length - remaining;

if (changed === 0) {
  console.log('patch-proto: already relaxed, nothing to do');
} else {
  writeFileSync(protoPath, patched, 'utf8');
  console.log(`patch-proto: relaxed ${changed} required field(s) in rustplus.proto`);
}
