/**
 * One-shot dump of the live marker feed.
 *
 * Answers "what does Rust+ actually send?" rather than what we assume it
 * sends. Uses monuments cached in Supabase so it costs 1 rate-limit token
 * (getMapMarkers) rather than 6, and disconnects immediately.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

if (existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const require = createRequire(import.meta.url);
const RustPlus = require('@liamcottle/rustplus.js');
const { createDecipheriv } = require('node:crypto');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const encKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
const headers = { apikey: key, Authorization: `Bearer ${key}` };

function decrypt(payload) {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const d = createDecipheriv('aes-256-gcm', Buffer.from(encKey, 'hex'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

const MARKER_NAMES = {
  0: 'Undefined', 1: 'Player', 2: 'Explosion', 3: 'VendingMachine', 4: 'CH47',
  5: 'CargoShip', 6: 'Crate', 7: 'GenericRadius', 8: 'PatrolHelicopter', 9: 'TravellingVendor',
};

const GRID = 146.25;
function corrected(mapSize) {
  const r = mapSize % GRID;
  return r < 120 ? mapSize - r : mapSize + (GRID - r);
}
function gridLabel(x, y, mapSize) {
  const c = corrected(mapSize);
  if (x < 0 || y < 0 || x > c || y > c) return 'OFF-GRID';
  const count = Math.floor(c / GRID);
  const col = Math.min(Math.floor(x / GRID), count - 1);
  const row = count - 1 - Math.min(Math.floor(y / GRID), count - 1);
  const letters = col < 26 ? String.fromCharCode(65 + col) : 'A' + String.fromCharCode(65 + (col % 26));
  return `${letters}${row}`;
}

const servers = await (await fetch(`${url}/rest/v1/rust_servers?select=*&is_active=eq.true`, { headers })).json();
const server = servers[0];
if (!server) { console.error('no active server'); process.exit(1); }

const monuments = await (await fetch(`${url}/rest/v1/monuments?select=token,x,y&server_id=eq.${server.id}`, { headers })).json();
const rigs = monuments.filter((m) => m.token === 'large_oil_rig' || m.token === 'oil_rig_small');

console.log(`server   : ${server.name}  mapSize=${server.map_size}`);
console.log(`oil rigs :`);
for (const r of rigs) console.log(`   ${r.token}  x=${Math.round(r.x)} y=${Math.round(r.y)}`);
console.log('');

const rustplus = new RustPlus(server.server_ip, server.app_port, server.player_id, decrypt(server.player_token));

const timeout = setTimeout(() => { console.error('timed out'); process.exit(1); }, 30_000);

rustplus.on('connected', () => {
  rustplus.getMapMarkers((message) => {
    clearTimeout(timeout);
    const markers = message.response?.mapMarkers?.markers ?? [];

    const counts = {};
    for (const m of markers) counts[MARKER_NAMES[m.type] ?? m.type] = (counts[MARKER_NAMES[m.type] ?? m.type] ?? 0) + 1;
    console.log('marker counts:', counts);
    console.log('');

    // Everything except players and vending machines, which are just noise.
    const interesting = markers.filter((m) => m.type !== 1 && m.type !== 3);
    console.log(`non-player/vending markers (${interesting.length}):`);
    for (const m of interesting) {
      const name = MARKER_NAMES[m.type] ?? `type ${m.type}`;
      const g = gridLabel(m.x, m.y, server.map_size);
      let near = '';
      for (const r of rigs) {
        const d = Math.hypot(m.x - r.x, m.y - r.y);
        if (d < 600) near += `  [${d.toFixed(0)}u from ${r.token}]`;
      }
      console.log(`  ${name.padEnd(17)} id=${String(m.id).padEnd(12)} x=${m.x.toFixed(0).padStart(6)} y=${m.y.toFixed(0).padStart(6)}  ${g}${near}`);
    }

    rustplus.disconnect();
    process.exit(0);
    return true;
  });
});

rustplus.on('error', (e) => { console.error('socket error:', e.message); process.exit(1); });
rustplus.connect();
