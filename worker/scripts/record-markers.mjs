/**
 * Records the live marker feed to disk for offline replay.
 *
 * Detection bugs in this project have all had the same shape: the logic looked
 * right, and only real data showed it was not. Recording snapshots lets the
 * detector be replayed against what the server actually sent, instead of
 * against what it was assumed to send.
 *
 * Output is JSON Lines: one {t, markers} object per poll.
 * Usage: node scripts/record-markers.mjs [minutes]
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

if (existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const require = createRequire(import.meta.url);
const RustPlus = require('@liamcottle/rustplus.js');
const { createDecipheriv } = require('node:crypto');

const minutes = Number(process.argv[2] ?? 30);
const POLL_MS = 5000;

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const encKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
const headers = { apikey: key, Authorization: `Bearer ${key}` };

function decrypt(payload) {
  const buf = Buffer.from(payload, 'base64');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(encKey, 'hex'), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

const servers = await (await fetch(`${url}/rest/v1/rust_servers?select=*&is_active=eq.true`, { headers })).json();
const server = servers[0];
if (!server) { console.error('no active server'); process.exit(1); }

mkdirSync('test/fixtures', { recursive: true });
const out = `test/fixtures/markers-${new Date().toISOString().replace(/[:.]/g, '-')}.live.jsonl`;

console.log(`recording ${minutes}m from ${server.name} -> ${out}`);
console.log(`mapSize=${server.map_size}`);

const rustplus = new RustPlus(server.server_ip, server.app_port, server.player_id, decrypt(server.player_token));
const stopAt = Date.now() + minutes * 60_000;
let polls = 0;
const seenTypes = new Set();

function poll() {
  if (Date.now() > stopAt) {
    console.log(`\ndone: ${polls} polls, marker types seen: ${[...seenTypes].sort((a, b) => a - b).join(', ')}`);
    rustplus.disconnect();
    process.exit(0);
  }

  rustplus.getMapMarkers((message) => {
    const markers = message.response?.mapMarkers?.markers ?? [];
    // Players and vending machines dominate the feed and are never announced;
    // dropping them keeps the recording small enough to commit if needed.
    const kept = markers.filter((m) => m.type !== 1 && m.type !== 3);
    for (const m of kept) seenTypes.add(m.type);

    appendFileSync(
      out,
      JSON.stringify({
        t: new Date().toISOString(),
        markers: kept.map((m) => ({ id: m.id, type: m.type, x: m.x, y: m.y })),
      }) + '\n',
    );

    polls++;
    if (polls % 12 === 0) {
      process.stdout.write(`\r${polls} polls, types seen: ${[...seenTypes].sort((a, b) => a - b).join(',') || 'none'}   `);
    }

    setTimeout(poll, POLL_MS);
    return true;
  });
}

rustplus.on('connected', () => { console.log('connected, recording...'); poll(); });
rustplus.on('error', (e) => { console.error('socket error:', e.message); process.exit(1); });
rustplus.connect();
