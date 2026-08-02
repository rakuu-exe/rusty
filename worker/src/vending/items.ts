/**
 * Rust item id to name lookup.
 *
 * Vending sell orders carry only numeric item ids (-932201673 is Scrap), so
 * every vending feature depends on this map. The data is a static snapshot in
 * data/items.json; new items added by a game update will show as their raw id
 * until it is refreshed, which is honest and better than hiding them.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { logger } from '../logger.js';
import { ITEM_ALIASES, resolveAlias } from './aliases.js';

export interface ItemInfo {
  name: string;
  short: string;
}

let items: Record<string, ItemInfo> = {};

/**
 * Short name to item id, rebuilt whenever the data set is loaded.
 *
 * Alias lookup happens on every vending command, and scanning 1200 entries
 * each time is wasted work for something answerable by a hash.
 */
let byShortName = new Map<string, number>();

function reindex(): void {
  byShortName = new Map();
  for (const [id, info] of Object.entries(items)) {
    if (info.short) byShortName.set(info.short, Number(id));
  }
}

/**
 * Load the item map.
 *
 * A missing file is not fatal: vending still works, items just render as ids.
 * Failing to start the whole bot over a cosmetic dataset would be worse.
 */
export function loadItems(path?: string): number {
  const here = dirname(fileURLToPath(import.meta.url));

  /**
   * The layout differs between running from source and running the image, so
   * candidates are tried rather than assuming one. Getting this wrong is
   * silent — every item would render as a raw id — which is exactly the kind
   * of thing that only shows up in production.
   */
  const candidates = path
    ? [path]
    : [
        resolve(here, '../../../data/items.json'), // worker/dist/vending -> repo/data
        resolve(here, '../../data/items.json'), // /app/dist/vending -> /app/data
        resolve(process.cwd(), 'data/items.json'),
        resolve(process.cwd(), '../data/items.json'),
      ];

  for (const file of candidates) {
    try {
      items = JSON.parse(readFileSync(file, 'utf8')) as Record<string, ItemInfo>;
      reindex();
      logger.info({ count: Object.keys(items).length, file }, 'item names loaded');
      return Object.keys(items).length;
    } catch {
      // Try the next layout.
    }
  }

  logger.warn({ candidates }, 'item names unavailable; vending will show raw item ids');
  items = {};
  reindex();
  return 0;
}

/** Display name for an item id, falling back to the id itself. */
export function itemName(id: number): string {
  return items[String(id)]?.name ?? `item ${id}`;
}

export function itemShortName(id: number): string | null {
  return items[String(id)]?.short ?? null;
}

/** True once a real dataset is loaded. */
export function hasItemData(): boolean {
  return Object.keys(items).length > 0;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Find item ids matching a search phrase.
 *
 * Ranked so an exact name wins over a prefix, and a prefix over a substring —
 * searching "rifle" should not bury "Assault Rifle" under "Rifle Body".
 * Matches both display and short names, since people type either.
 */
export function findItems(query: string, limit = 8): number[] {
  const q = normalise(query);
  if (q.length === 0) return [];

  /**
   * A community alias outranks everything.
   *
   * Text ranking alone gets these wrong in ways that look arbitrary: "semi"
   * matches "Semi Automatic Body" as a prefix before either weapon, and "ak"
   * matches nothing at all. Other matches still follow, so "bow" leads with
   * Hunting Bow without hiding Compound Bow.
   */
  const aliasId = aliasMatch(q);

  // When only the best match is wanted, an alias settles it and the scan over
  // every item is pure waste. findItem() takes this path on every command.
  if (aliasId !== null && limit === 1) return [aliasId];

  const exact: number[] = [];
  const prefix: number[] = [];
  const contains: number[] = [];

  for (const [id, info] of Object.entries(items)) {
    const name = normalise(info.name);
    const short = normalise(info.short ?? '');

    if (name === q || short === q) exact.push(Number(id));
    else if (name.startsWith(q) || short.startsWith(q)) prefix.push(Number(id));
    else if (name.includes(q) || short.includes(q)) contains.push(Number(id));
  }

  const ranked = [...exact, ...prefix, ...contains];
  if (aliasId === null) return ranked.slice(0, limit);

  return [aliasId, ...ranked.filter((id) => id !== aliasId)].slice(0, limit);
}

/**
 * Item id an alias points at, or null.
 *
 * Aliases store short names rather than ids, so the id is looked up here. A
 * short name that no longer exists returns null and the search simply falls
 * back to text ranking, which is the right behaviour after a game update
 * renames something out from under the table.
 */
function aliasMatch(normalisedQuery: string): number | null {
  const short = resolveAlias(normalisedQuery);
  if (short === null) return null;

  return byShortName.get(short) ?? null;
}

/**
 * The single best match for a search phrase, or null.
 *
 * Commands take a free-text item name, so this is what turns "ak" or
 * "assault rifle" into an id.
 */
export function findItem(query: string): number | null {
  return findItems(query, 1)[0] ?? null;
}
