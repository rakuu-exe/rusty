/**
 * Waits for the worker to reconnect after a deploy.
 *
 * connected_at is written on every (re)connection, so a value newer than the
 * push means the new build is live. Exits 0 on success, 1 on timeout.
 */
import { existsSync } from 'node:fs';
if (existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const since = new Date(process.argv[2]);
const deadline = Date.now() + Number(process.argv[3] ?? 600) * 1000;
const headers = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };

while (Date.now() < deadline) {
  const rows = await (await fetch(`${process.env.SUPABASE_URL}/rest/v1/rust_servers?select=name,connected_at&is_active=eq.true`, { headers })).json();
  const at = rows[0]?.connected_at ? new Date(rows[0].connected_at) : null;
  if (at && at > since) {
    console.log(`RECONNECTED at ${at.toISOString()} -- new build is live`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 15_000));
}
console.log('no reconnect within the window -- auto-deploy may be off');
process.exit(1);
