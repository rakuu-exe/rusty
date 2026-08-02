/**
 * Vending team chat commands.
 *
 * Read-only with one deliberate exception: `!vendtrack` and `!vendtrack-clear`
 * manage trackers, which is an explicit request rather than a side effect of
 * asking a question. Everything else only reads the store.
 */

import { chatItemName, findItem, findItems, hasItemData, itemName } from './items.js';
import {
  MAX_CHAT_LENGTH,
  describeListing,
  describeListingCompact,
  describeOrder,
  describePricePoint,
  joinCapped,
  paginate,
  priceSummary,
  sharedCurrency,
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

/**
 * Pull a trailing page number off a query: "ak 2" -> { text: "ak", page: 2 }.
 *
 * Item names never end in a bare number, so this is unambiguous in practice.
 * Page numbers are 1-based because that is how the reply displays them.
 */
function splitPage(query: string): { text: string; page: number } {
  const match = query.trim().match(/^(.*?)\s+(\d{1,3})$/);
  if (!match) return { text: query.trim(), page: 1 };

  return { text: match[1]!.trim(), page: Math.max(1, Number(match[2])) };
}

/**
 * !vend item [page] — who is selling it right now.
 *
 * A popular item on a busy map has thirty-odd listings and the line holds
 * about eight, so the reply leads with the summary a shopper actually wants —
 * how many shops, and the price range — then the cheapest listings, since
 * they are sorted by price. The rest are reachable by page rather than simply
 * dropped.
 */
function vend(query: string, deps: VendingCommandDeps): string {
  const { text, page } = splitPage(query);
  const resolved = resolveItem(text);
  if ('error' in resolved) return resolved.error;

  const all = deps.store.findListings(resolved.id);
  const name = chatItemName(resolved.id);

  if (all.length === 0) return `${name}: not sold anywhere right now`;

  // Out-of-stock shops are worse than useless to a shopper, so they only show
  // when there is nothing else to show.
  const inStock = all.filter((l) => l.order.amountInStock > 0);
  const listings = inStock.length > 0 ? inStock : all;
  const soldOut = inStock.length === 0 ? ' ALL SOLD OUT' : '';

  const currency = sharedCurrency(listings.map((l) => l.order.currencyId));

  /**
   * A price range only means anything within one currency.
   *
   * Sixteen listings priced in a mix produced "1-400", which reads as a range
   * but is arithmetic across unrelated units — one shop wanting 1 of something
   * and another wanting 400 of something else. When currencies differ the
   * range is dropped and each listing names its own instead.
   */
  const costs = listings.map((l) => l.order.costPerItem);
  const span = Math.min(...costs) === Math.max(...costs)
    ? `${costs[0]}`
    : `${Math.min(...costs)}-${Math.max(...costs)}`;

  const plural = listings.length === 1 ? '' : 's';
  const summary =
    currency === null
      ? `${listings.length} listing${plural}, mixed currency`
      : `${listings.length} listing${plural}, ${span} ${chatItemName(currency)}`;

  const entries = listings.map((l) =>
    describeListingCompact(l.machine, l.order, { withCurrency: currency === null }),
  );

  // Reserve the header and the page marker so the whole line fits, not just
  // the listings inside it.
  const header = `${name}: ${summary}${soldOut}${LISTING_SEPARATOR}`;
  const pages = paginate(
    entries,
    MAX_CHAT_LENGTH - header.length - PAGE_MARKER_BUDGET,
    LISTING_SEPARATOR,
  );

  const index = Math.min(page, pages.length) - 1;
  const marker = pages.length > 1 ? ` (${index + 1}/${pages.length})` : '';

  return `${header}${pages[index]!.join(LISTING_SEPARATOR)}${marker}`;
}

/**
 * Listings run together without this.
 *
 * "S6 1 x2 C6 1 x4 D18 4 x1" is a wall of numbers with no way to see where one
 * shop ends and the next begins; the three characters this costs buy back far
 * more than they take.
 */
const LISTING_SEPARATOR = ' | ';

/** Room kept for a trailing "(2/4)" so it never pushes the line over. */
const PAGE_MARKER_BUDGET = 8;

/**
 * !vendhelp [command] — the vending commands, and what they do.
 *
 * The general !help lists every command the bot has and has no room to explain
 * any of them at 128 characters. This trades breadth for depth.
 */
function vendhelp(query: string): string {
  const asked = query.trim().toLowerCase().replace(/^!/, '');

  if (asked) {
    const help = VENDING_HELP.find((h) => h.name === asked);
    return help ? `!${help.usage} — ${help.detail}` : `No vending command "${asked}". Try !vendhelp`;
  }

  // Budgeted rather than hand-counted: adding a command must not silently
  // push this over the line the game will cut.
  const head = 'Vending: ';
  const hint = ' — !vendhelp cmd';
  const names = VENDING_HELP.filter((h) => h.name !== 'vendhelp').map((h) => `!${h.name}`);

  return head + joinCapped(names, ' ', MAX_CHAT_LENGTH, head.length + hint.length) + hint;
}

/**
 * !price item — what people pay for it.
 *
 * Reports both directions, because "the price" of an item means one thing to a
 * buyer and another to a seller: shops selling it, and shops accepting it as
 * currency.
 */
function price(query: string, deps: VendingCommandDeps): string {
  const resolved = resolveItem(query);
  if ('error' in resolved) return resolved.error;

  const name = chatItemName(resolved.id);
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
  const name = chatItemName(resolved.id);
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

  return `Most listed: ${top.map((t, i) => `${i + 1}. ${chatItemName(t.itemId)} (${t.listings})`).join(' | ')}`;
}

/** !vendhistory item — what the bot watched change this session. */
function vendhistory(query: string, deps: VendingCommandDeps): string {
  const resolved = resolveItem(query);
  if ('error' in resolved) return resolved.error;

  const name = chatItemName(resolved.id);
  const points = deps.store.historyFor(resolved.id);

  if (points.length === 0) return `${name}: no history this session`;

  // Newest first, since the recent past is what gets asked about.
  const recent = [...points].reverse().slice(0, 6);
  const stats = priceSummary(points.map((p) => p.costPerItem))!;

  const head = `${name} this session — ${points.length} points, ${stats.min}-${stats.max}: `;

  return (
    head +
    joinCapped(
      recent.map((p) => describePricePoint(p, deps.formatClock)),
      ' | ',
      MAX_CHAT_LENGTH,
      head.length,
    )
  );
}

/**
 * !vendtrack [grid] item — manage trackers.
 *
 * With no argument it lists. The grid form is detected by a leading token that
 * looks like a map cell, so "!vendtrack D12 ak" narrows to one shop area while
 * "!vendtrack assault rifle" watches the whole map.
 */
function vendtrack(args: string, deps: VendingCommandDeps): string {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    const trackers = deps.store.listTrackers();
    if (trackers.length === 0) return 'No trackers. Use !vendtrack item or !vendtrack grid item';
    return `Tracking: ${trackers.map((t) => (t.grid ? `${t.query} in ${t.grid}` : t.query)).join(' | ')}`;
  }

  // A leading map cell like "D12" or "AA26" narrows the tracker.
  const gridMatch = trimmed.match(/^([A-Za-z]{1,2}\d{1,2})\s+(.+)$/);
  const grid = gridMatch ? gridMatch[1]!.toUpperCase() : null;
  const query = gridMatch ? gridMatch[2]! : trimmed;

  const id = hasItemData() ? findItem(query) : null;
  const tracker = deps.store.addTracker(query, id, grid);

  const resolvedName = id !== null ? chatItemName(id) : `"${query}" (no exact item match, matching by name)`;
  const where = tracker.grid ? ` in ${tracker.grid}` : ' anywhere';

  // Tell them what is already out there, so a tracker is useful immediately
  // rather than only when something next changes.
  const existing = id !== null ? deps.store.findListings(id) : [];
  if (existing.length === 0) return `Tracking ${resolvedName}${where} — none listed right now`;

  const head = `Tracking ${resolvedName}${where} — ${existing.length} now: `;

  return (
    head +
    joinCapped(
      existing.map((l) => describeListingCompact(l.machine, l.order)),
      ' ',
      MAX_CHAT_LENGTH,
      head.length,
    )
  );
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
 * Every vending command, its usage, and what it does.
 *
 * Single source of truth: `!help` takes the usage strings, `!vendhelp` takes
 * the details, and the dispatch below matches the names. The chat module used
 * to hard-code its own copy of this list, which had already fallen behind —
 * `vendsearch` worked but appeared nowhere.
 */
const VENDING_HELP: readonly { name: string; usage: string; detail: string }[] = [
  { name: 'vend', usage: 'vend item [page]', detail: 'cheapest first. Reads: grid, price, x = stock' },
  { name: 'price', usage: 'price item', detail: 'what it sells for, and what shops pay for it' },
  { name: 'vendstats', usage: 'vendstats [item]', detail: 'price range seen this session' },
  { name: 'vendcommon', usage: 'vendcommon', detail: 'the most widely stocked items right now' },
  { name: 'vendhistory', usage: 'vendhistory item', detail: 'how its price moved this session' },
  { name: 'vendtrack', usage: 'vendtrack [grid] item', detail: 'alert when it comes in stock' },
  { name: 'vendtrack-clear', usage: 'vendtrack-clear [item]', detail: 'stop tracking; no item clears all' },
  { name: 'vendsearch', usage: 'vendsearch item', detail: 'what item names your text matches' },
  { name: 'vendhelp', usage: 'vendhelp [command]', detail: 'this list, or detail on one command' },
];

/** Usage strings for the general `!help`. */
export const VENDING_COMMAND_USAGE: readonly string[] = VENDING_HELP.map((h) => h.usage);

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
      return args.trim() ? vend(args, deps) : 'Usage: !vend item';

    case 'price':
      return args.trim() ? price(args, deps) : 'Usage: !price item';

    case 'vendstats':
      return vendstats(args.trim() || null, deps);

    case 'vendcommon':
      return vendcommon(deps);

    case 'vendhistory':
      return args.trim() ? vendhistory(args, deps) : 'Usage: !vendhistory item';

    case 'vendtrack':
      return vendtrack(args, deps);

    case 'vendtrack-clear':
      return vendtrackClear(args, deps);

    case 'vendhelp':
      return vendhelp(args);

    case 'vendsearch': {
      // Helper for when a name does not resolve: shows what would match.
      const matches = findItems(args.trim(), 6);
      if (matches.length === 0) return `No item matching "${args.trim()}"`;
      // Full names here: this command exists to disambiguate, so a nickname
      // would defeat the point.
      return `Matches: ${matches.map((id) => itemName(id)).join(' | ')}`;
    }

    default:
      return null;
  }
}
