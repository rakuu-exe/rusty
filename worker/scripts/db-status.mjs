/**
 * Read-only snapshot of what the worker has actually persisted.
 *
 * Useful when the log is buffered or the process is silent: this shows whether
 * the server connected, whether monuments were cached, and what events have
 * been recorded, straight from Supabase.
 */

import { existsSync } from 'node:fs';

if (existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  process.exit(1);
}

const headers = { apikey: key, Authorization: `Bearer ${key}` };

async function get(path) {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const servers = await get('rust_servers?select=id,name,server_ip,app_port,map_size,seed,salt,wipe_time,is_active,connected_at');
console.log('=== rust_servers ===');
for (const s of servers) {
  console.log(`  ${s.name}  ${s.server_ip}:${s.app_port}`);
  console.log(`    mapSize=${s.map_size}  seed=${s.seed}  salt=${s.salt}`);
  console.log(`    wipe=${s.wipe_time}  connectedAt=${s.connected_at}  active=${s.is_active}`);
}

const monuments = await get('monuments?select=token,x,y');
console.log(`\n=== monuments (${monuments.length}) ===`);
const rigs = monuments.filter((m) => m.token === 'large_oil_rig' || m.token === 'oil_rig_small');
for (const m of rigs) console.log(`  ${m.token}  x=${Math.round(m.x)} y=${Math.round(m.y)}`);
if (monuments.length > 0 && rigs.length === 0) console.log('  (no oil rigs on this map)');

const events = await get('event_log?select=event_type,phase,grid,created_at&order=created_at.desc&limit=15');
console.log(`\n=== event_log (${events.length} most recent) ===`);
for (const e of events) console.log(`  ${e.created_at}  ${e.event_type}/${e.phase}  @ ${e.grid}`);
if (events.length === 0) console.log('  (none yet)');

const timers = await get('active_timers?select=kind,expires_at,fired_at');
console.log(`\n=== active_timers (${timers.length}) ===`);
for (const t of timers) console.log(`  ${t.kind}  expires=${t.expires_at}  fired=${t.fired_at ?? 'pending'}`);
if (timers.length === 0) console.log('  (none)');

const cfg = await get('discord_config?select=*');
console.log(`\n=== discord_config ===`);
console.log(cfg.length === 0 ? '  NOT CONFIGURED -- run /setup' : JSON.stringify(cfg[0], null, 2));
