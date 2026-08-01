/** Reports exactly why the Rust+ connection fails, rather than timing out silently. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
if (existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const require = createRequire(import.meta.url);
const RustPlus = require('@liamcottle/rustplus.js');
const { createDecipheriv } = require('node:crypto');

const headers = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
function decrypt(p) {
  const b = Buffer.from(p, 'base64');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY, 'hex'), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

const s = (await (await fetch(`${process.env.SUPABASE_URL}/rest/v1/rust_servers?select=*&is_active=eq.true`, { headers })).json())[0];
const token = decrypt(s.player_token);
console.log(`server    : ${s.server_ip}:${s.app_port}`);
console.log(`playerId  : ${s.player_id}`);
console.log(`token     : ${token.slice(0, 6)}... (${token.length} chars)`);
console.log(`paired at : ${s.connected_at}`);

// 1. Is the Rust+ port even reachable?
await new Promise((resolve) => {
  const sock = net.createConnection({ host: s.server_ip, port: Number(s.app_port), timeout: 8000 });
  sock.on('connect', () => { console.log('\nTCP        : port is OPEN'); sock.destroy(); resolve(); });
  sock.on('timeout', () => { console.log('\nTCP        : TIMEOUT -- server down or port closed'); sock.destroy(); resolve(); });
  sock.on('error', (e) => { console.log(`\nTCP        : ${e.code} -- ${e.message}`); resolve(); });
});

// 2. Does the websocket handshake + auth succeed?
const rp = new RustPlus(s.server_ip, s.app_port, s.player_id, token);
const done = new Promise((resolve) => {
  const t = setTimeout(() => { console.log('WEBSOCKET  : no response within 20s'); resolve(); }, 20_000);
  rp.on('connected', () => {
    clearTimeout(t);
    console.log('WEBSOCKET  : CONNECTED -- token is valid');
    rp.getInfo((m) => {
      console.log('getInfo    :', m.response?.info?.name ?? JSON.stringify(m.response?.error ?? m));
      resolve();
      return true;
    });
  });
  rp.on('error', (e) => { clearTimeout(t); console.log(`WEBSOCKET  : ${e.code ?? ''} ${e.message}`); resolve(); });
});
rp.connect();
await done;
try { rp.disconnect(); } catch {}
process.exit(0);
