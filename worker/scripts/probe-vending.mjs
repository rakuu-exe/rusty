/**
 * What do vending machine markers actually carry?
 *
 * The protobuf declares sellOrders on AppMarker, but declaring a field and
 * populating it are different things — crate markers are declared too and are
 * never sent. This checks before any vending feature is built on the
 * assumption that the data exists.
 *
 * As of 6 August 2026 the answer is no, on every server: Facepunch removed all
 * non-player map markers from the Rust+ API (commits.facepunch.com/612220).
 * This script is now the way to notice if that is ever reverted — a non-zero
 * count here means vending can come back.
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
  const d = createDecipheriv('aes-256-gcm', Buffer.from(encKey, 'hex'), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

/**
 * Optional argument names a server to probe instead of the active one, matched
 * on any part of its name. "Does this server publish shop markers at all?" is
 * only answerable by comparing servers, and the paired credentials for the
 * inactive ones are still on file.
 */
const wanted = process.argv[2]?.toLowerCase();
const query = wanted ? 'select=*' : 'select=*&is_active=eq.true';

const servers = await (await fetch(`${url}/rest/v1/rust_servers?${query}`, { headers })).json();
const server = wanted ? servers.find((s) => s.name.toLowerCase().includes(wanted)) : servers[0];

if (!server) {
  console.error(`no server matching "${process.argv[2]}" -- known: ${servers.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

console.log(`server: ${server.name}\n`);

const rustplus = new RustPlus(server.server_ip, server.app_port, server.player_id, decrypt(server.player_token));
const timeout = setTimeout(() => { console.error('timed out'); process.exit(1); }, 30_000);

rustplus.on('connected', () => {
  rustplus.getMapMarkers((message) => {
    clearTimeout(timeout);
    const markers = message.response?.mapMarkers?.markers ?? [];
    const vending = markers.filter((m) => m.type === 3);

    console.log(`vending machines : ${vending.length}`);

    const withOrders = vending.filter((m) => (m.sellOrders ?? []).length > 0);
    console.log(`with sellOrders  : ${withOrders.length}`);

    const totalOrders = vending.reduce((n, m) => n + (m.sellOrders ?? []).length, 0);
    console.log(`total sell orders: ${totalOrders}`);

    if (totalOrders === 0) {
      console.log('\nsellOrders is declared but never populated -- same as crate markers.');
      console.log('A vending feature cannot be built on this.');
      rustplus.disconnect();
      process.exit(0);
    }

    // Item ids are numeric; names need a separate dataset.
    const itemIds = new Set();
    const currencyIds = new Set();
    for (const m of vending) {
      for (const o of m.sellOrders ?? []) {
        itemIds.add(o.itemId);
        currencyIds.add(o.currencyId);
      }
    }
    console.log(`distinct itemIds : ${itemIds.size}`);
    console.log(`distinct currencyIds: ${[...currencyIds].join(', ')}`);

    console.log('\n=== sample machines ===');
    for (const m of withOrders.slice(0, 3)) {
      console.log(`\n  "${m.name ?? '(unnamed)'}"  id=${m.id}  x=${m.x.toFixed(0)} y=${m.y.toFixed(0)}  outOfStock=${m.outOfStock}`);
      for (const o of m.sellOrders ?? []) {
        console.log(
          `     item=${String(o.itemId).padStart(12)} qty=${String(o.quantity).padStart(4)}` +
            ` cost=${String(o.costPerItem).padStart(6)} currency=${String(o.currencyId).padStart(12)}` +
            ` stock=${String(o.amountInStock).padStart(4)}` +
            `${o.itemIsBlueprint ? ' [BP]' : ''}`,
        );
      }
    }

    console.log('\n=== raw shape of one sell order ===');
    console.log(JSON.stringify(withOrders[0]?.sellOrders?.[0], null, 2));

    rustplus.disconnect();
    process.exit(0);
    return true;
  });
});

rustplus.on('error', (e) => { console.error('socket error:', e.message); process.exit(1); });
rustplus.connect();
