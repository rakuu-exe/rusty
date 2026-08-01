/**
 * Diagnostic: what coordinate space are monuments actually in?
 *
 * getInfo().mapSize reports the playable size, but observed monuments fall
 * outside 0..mapSize (oil rigs sit in the ocean margin). This prints the real
 * extent so the grid transform can be checked against ground truth.
 */

import { existsSync } from 'node:fs';

if (existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const headers = { apikey: key, Authorization: `Bearer ${key}` };

const res = await fetch(`${url}/rest/v1/monuments?select=token,x,y`, { headers });
const monuments = await res.json();

const xs = monuments.map((m) => m.x);
const ys = monuments.map((m) => m.y);

const minX = Math.min(...xs);
const maxX = Math.max(...xs);
const minY = Math.min(...ys);
const maxY = Math.max(...ys);

console.log(`monuments      : ${monuments.length}`);
console.log(`x range        : ${minX.toFixed(1)} .. ${maxX.toFixed(1)}`);
console.log(`y range        : ${minY.toFixed(1)} .. ${maxY.toFixed(1)}`);
console.log(`getInfo mapSize: 4000`);
console.log('');
console.log(`implied margin below 0 : x=${(-minX).toFixed(1)}  y=${(-minY).toFixed(1)}`);
console.log(`implied overflow >4000 : x=${(maxX - 4000).toFixed(1)}  y=${(maxY - 4000).toFixed(1)}`);
console.log('');

// How many monuments would my current 0..mapSize grid call "outside"?
const GRID = 146.25;
const corrected = 4000 - (4000 % GRID);
const outside = monuments.filter((m) => m.x < 0 || m.y < 0 || m.x > corrected || m.y > corrected);
console.log(`corrected map size     : ${corrected.toFixed(2)}`);
console.log(`monuments outside grid : ${outside.length} / ${monuments.length}`);
for (const m of outside) console.log(`   ${m.token}  x=${Math.round(m.x)} y=${Math.round(m.y)}`);
