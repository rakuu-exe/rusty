/**
 * Vending team chat commands.
 *
 * Read-only with one deliberate exception: `!vendtrack` and `!vendtrack-clear`
 * manage trackers, which is an explicit request rather than a side effect of
 * asking a question. Everything else only reads the store.
 */

import { findItem, findItems, hasItemData, itemName } from './items.js';
import {
  describeListing,
  describeOrder,
  describePricePoint,
  joinCapped,
  priceSummary,
} from './format.js';
import type { VendingStore } from './store.js';

export interface VendingCommandDeps {
  store: VendingStore;
  formatClock: (date: Date) => string;
}

/** Resolve free text to an item, or explain why it could not be resolved. */
function resolveItem(query: string): { id: number } | { error: string } {
  if (!hasItemData()) {
    return { error: 'Item names are unavailable — data/items.json failed to load.' };
  }

  const id = findItem(query);
  if (id === null) return { error: `No item matching "${query}"` };

  return { id };
}

/** !vend <item> — who is selling it right now. */
function vend(query: string, deps: VendingCommandDeps): string {
  const resolved = resolveItem(query);
  if ('error' in resolved) return resolved.error;

  const listings = deps.store.findListings(resolved.id);
  const name = itemName(resolved.id);

  if (listings.length === 0) return `${name}: not sold anywhere right now`;

  const inStock = listings.filter((l) => l.order.amountInStock > 0);
  const body = joinCapped((inStock.length > 0 ? inStock : listings).map((l) => describeListing(l.machine, l.order)));
  const suffix = inStock.length === 0 ? ' (all out of stock)' : '';

  return `${name} — ${listings.length} listing${listings.length === 1 ? '' : 's'}${suffix}: ${body}`;
}

/**
 * !price <item> — what people pay for it.
 *
 * Reports both directions, because "the price" of an item means one thing to a
 * buyer and another to a seller: shops selling it, and shops accepting it as
 * currency.
 */
function price(query: string, deps: VendingCommandDeps): string {
  const resolved = resolveItem(query);
  if ('error' in resolved) return resolved.error;

  const name = itemName(resolved.id);
  const selling = deps.store.findListings(resolved.id);
  const buying = deps.store.findBuyers(resolved.id);

  const parts: string[] = [];

  const sellStats = priceSummary(selling.map((l) => l.order.costPerItem));
  if (sellStats) {
    const cheapest = selling[0]!;
    parts.push(
      `sold for ${sellStats.min}-${sellStats.max} (median ${sellStats.median}), cheapest ${cheapest.machine.grid}`,
    );
  }

  const buyStats = priceSummary(buying.map((l) => l.order.costPerItem));
  if (buyStats) parts.push(`accepted as payment in ${buying.length} listing${buying.length === 1 ? '' : 's'}`);

  if (parts.length === 0) return `${name}: no listings right now`;
  return `${name} — ${parts.join(' | ')}`;
}

/** !vendstats [item] */
function vendstats(query: string | null, deps: VendingCommandDeps): string {
  if (!query) {
    const s = deps.store.stats();
    return `Vending: ${s.machines} shops (${s.withOrders} stocked), ${s.orders} listings, ${s.distinctItems} distinct items, ${s.changes} changes seen this session`;
  }

  const resolved = resolveItem(query);
  if ('error' in resolved) return resolved.error;

  const listings = deps.store.findListings(resolved.id);
  const name = itemName(resolved.id);
  if (listings.length === 0) return `${name}: not sold anywhere right now`;

  const stats = priceSummary(listings.map((l) => l.order.costPerItem))!;
  const stock = listings.reduce((n, l) => n + l.order.amountInStock, 0);
  const history = deps.store.historyFor(resolved.id).length;

  return `${name}: ${listings.length} listings, ${stock} in stock, price ${stats.min}-${stats.max} (median ${stats.median}), ${history} price points this session`;
}

/** !vendcommon — the five items most shops carry. */
function vendcommon(deps: VendingCommandDeps): string {
  const top = deps.store.itemFrequency().slice(0, 5);
  if (top.length === 0) return 'No vending data yet';

  return `Most listed: ${top.map((t, i) => `${i + 1}. ${itemName(t.itemId)} (${t.listings})`).join(' | ')}`;
}

/** !vendhistory <item> — what the bot watched change this session. */
function vendhistory(query: string, deps: VendingCommandDeps): string {
  const resolved = resolveItem(query);
  if ('error' in resolved) return resolved.error;

  const name = itemName(resolved.id);
  const points = deps.store.historyFor(resolved.id);

  if (points.length === 0) return `${name}: no history this session`;

  // Newest first, since the recent past is what gets asked about.
  const recent = [...points].reverse().slice(0, 6);
  const stats = priceSummary(points.map((p) => p.costPerItem))!;

  return `${name} this session — ${points.length} points, ${stats.min}-${stats.max}: ${joinCapped(
    recent.map((p) => describePricePoint(p, deps.formatClock)),
  )}`;
}

/**
 * !vendtrack [grid] <item> — manage trackers.
 *
 * With no argument it lists. The grid form is detected by a leading token that
 * looks like a map cell, so "!vendtrack D12 ak" narrows to one shop area while
 * "!vendtrack assault rifle" watches the whole map.
 */
function vendtrack(args: string, deps: VendingCommandDeps): string {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    const trackers = deps.store.listTrackers();
    if (trackers.length === 0) return 'No trackers. Use !vendtrack <item> or !vendtrack <grid> <item>';
    return `Tracking: ${trackers.map((t) => (t.grid ? `${t.query} in ${t.grid}` : t.query)).join(' | ')}`;
  }

  // A leading map cell like "D12" or "AA26" narrows the tracker.
  const gridMatch = trimmed.match(/^([A-Za-z]{1,2}\d{1,2})\s+(.+)$/);
  const grid = gridMatch ? gridMatch[1]!.toUpperCase() : null;
  const query = gridMatch ? gridMatch[2]! : trimmed;

  const id = hasItemData() ? findItem(query) : null;
  const tracker = deps.store.addTracker(query, id, grid);

  const resolvedName = id !== null ? itemName(id) : `"${query}" (no exact item match, matching by name)`;
  const where = tracker.grid ? ` in ${tracker.grid}` : ' anywhere';

  // Tell them what is already out there, so a tracker is useful immediately
  // rather than only when something next changes.
  const existing = id !== null ? deps.store.findListings(id) : [];
  const now =
    existing.length > 0
      ? ` — currently ${existing.length} listing${existing.length === 1 ? '' : 's'}: ${joinCapped(
          existing.slice(0, 3).map((l) => describeListing(l.machine, l.order)),
          ' | ',
          120,
        )}`
      : ' — none listed right now';

  return `Tracking ${resolvedName}${where}${now}`;
}

/** !vendtrack-clear [item] */
function vendtrackClear(args: string, deps: VendingCommandDeps): string {
  const query = args.trim();

  if (query.length === 0) {
    const count = deps.store.clearTrackers();
    return count === 0 ? 'No trackers to clear' : `Cleared ${count} tracker${count === 1 ? '' : 's'}`;
  }

  return deps.store.removeTracker(query)
    ? `Stopped tracking "${query}"`
    : `No tracker matching "${query}"`;
}

/**
 * Dispatch a vending command.
 *
 * Returns null when the command is not a vending one, so the caller can carry
 * on to its own commands.
 */
export function resolveVendingCommand(
  command: string,
  args: string,
  deps: VendingCommandDeps,
): string | null {
  switch (command) {
    case 'vend':
      return args.trim() ? vend(args, deps) : 'Usage: !vend <item>';

    case 'price':
      return args.trim() ? price(args, deps) : 'Usage: !price <item>';

    case 'vendstats':
      return vendstats(args.trim() || null, deps);

    case 'vendcommon':
      return vendcommon(deps);

    case 'vendhistory':
      return args.trim() ? vendhistory(args, deps) : 'Usage: !vendhistory <item>';

    case 'vendtrack':
      return vendtrack(args, deps);

    case 'vendtrack-clear':
      return vendtrackClear(args, deps);

    case 'vendsearch': {
      // Helper for when a name does not resolve: shows what would match.
      const matches = findItems(args.trim(), 6);
      if (matches.length === 0) return `No item matching "${args.trim()}"`;
      return `Matches: ${matches.map((id) => itemName(id)).join(' | ')}`;
    }

    default:
      return null;
  }
}
