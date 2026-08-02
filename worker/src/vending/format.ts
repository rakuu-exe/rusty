/**
 * Rendering vending data for team chat and Discord.
 *
 * Rust chat lines are short and read mid-game, so everything here truncates
 * rather than wraps, and always says how much was left out — "+12 more" is
 * useful, a silently trimmed list is misleading.
 */

import { chatItemName, itemName } from './items.js';
import type { PricePoint, SellOrder, VendingEvent, VendingMachine } from './types.js';

/**
 * How a line names things.
 *
 * Discord embeds have room for "Assault Rifle" and read better with it. Rust
 * team chat is capped at 128 characters, so the same line there uses what
 * players call it — "AK" — and drops the shop's own name, which is decoration
 * next to the grid reference.
 */
export interface NamingOptions {
  short?: boolean;
}

function namerFor(options: NamingOptions): (id: number) => string {
  return options.short ? chatItemName : itemName;
}

/**
 * Rust cuts a team chat message off at 128 characters.
 *
 * This was 240, which is not a style choice but a bug: the bot built a reply
 * up to 240 characters, the game silently discarded everything past 128, and
 * what got discarded was the tail — including the "+N more" that said anything
 * had been left out. A busy map made that look like the command was broken.
 */
export const MAX_CHAT_LENGTH = 128;

/** "5x Scrap" or just "Scrap" for a single unit. */
export function describeAmount(itemId: number, quantity: number, options: NamingOptions = {}): string {
  const name = namerFor(options);
  return quantity === 1 ? name(itemId) : `${quantity}x ${name(itemId)}`;
}

/** "10 Scrap for 5x Cloth" — the deal as a shopper reads it. */
export function describeOrder(order: SellOrder, options: NamingOptions = {}): string {
  const cost = describeAmount(order.currencyId, order.costPerItem, options);
  const item = describeAmount(order.itemId, order.quantity, options);
  return `${cost} → ${item}`;
}

/**
 * Joins entries up to a length budget, appending "+N more" when truncated.
 *
 * `reserved` is for whatever the caller wraps around the result — a header
 * like "Assault Rifle 14 shops: " is part of the message the game measures,
 * and ignoring it was how replies still overshot the limit even after the
 * limit itself was corrected.
 */
export function joinCapped(
  entries: string[],
  separator = ' | ',
  max = MAX_CHAT_LENGTH,
  reserved = 0,
): string {
  const budget = Math.max(max - reserved, 0);

  const fill = (limit: number): string[] => {
    const kept: string[] = [];
    let length = 0;

    for (const entry of entries) {
      const cost = entry.length + (kept.length > 0 ? separator.length : 0);
      // Always keep at least one, however long, so a reply is never empty.
      if (kept.length > 0 && length + cost > limit) break;
      kept.push(entry);
      length += cost;
    }
    return kept;
  };

  if (fill(budget).length === entries.length) return entries.join(separator);

  /**
   * Truncating costs a "+N more" tail, and that tail is part of the message
   * the game measures. Filling the budget and appending afterwards overshot by
   * its whole length — which is how replies still ran over even once every
   * caller was reserving space for its own header.
   *
   * The reservation uses the total count as an upper bound on N, so it can
   * never be too small.
   */
  const kept = fill(Math.max(budget - ` (+${entries.length} more)`.length, 0));
  const omitted = entries.length - kept.length;

  return omitted > 0 ? `${kept.join(separator)} (+${omitted} more)` : kept.join(separator);
}

/** One listing: where it is, and what it costs. */
export function describeListing(machine: VendingMachine, order: SellOrder): string {
  const stock = order.amountInStock === 0 ? ' OUT OF STOCK' : ` x${order.amountInStock}`;
  return `${machine.grid} ${describeOrder(order)}${stock}`;
}

/**
 * A listing stripped to what differs between them: grid, price, stock.
 *
 * The long form repeats the item name and the currency in every entry, so a
 * single listing eats a third of the line and three of them fill it. Those
 * two facts are identical across the whole reply, so they belong in the header
 * once. "D12 100x2" against "D12 100 Scrap → Assault Rifle x2" is the
 * difference between eight listings on a line and two.
 */
export function describeListingCompact(machine: VendingMachine, order: SellOrder): string {
  // "D12 100 x2" — where, how much, how many left. The item and the currency
  // are stated once in the header, so they are not repeated here.
  const stock = order.amountInStock === 0 ? 'OUT' : `x${order.amountInStock}`;

  // Bundles are the exception, so they are the only thing that needs marking:
  // "100/5" is 100 for a pack of five.
  const bundle = order.quantity === 1 ? '' : `/${order.quantity}`;

  return `${machine.grid} ${order.costPerItem}${bundle} ${stock}`;
}

/**
 * Split entries into pages that each fit the budget.
 *
 * Entries vary in width, so pages are filled greedily rather than by a fixed
 * count. That keeps every page as full as it can be, which matters when the
 * line is 128 characters and a busy map has thirty shops selling one item.
 */
export function paginate(entries: string[], budget: number, separator = ' '): string[][] {
  if (entries.length === 0) return [];

  const pages: string[][] = [];
  let page: string[] = [];
  let length = 0;

  for (const entry of entries) {
    const cost = entry.length + (page.length > 0 ? separator.length : 0);
    if (page.length > 0 && length + cost > budget) {
      pages.push(page);
      page = [];
      length = 0;
    }
    page.push(entry);
    length += entry.length + (page.length > 1 ? separator.length : 0);
  }

  if (page.length > 0) pages.push(page);
  return pages;
}

/** The currency every listing shares, or null when they differ. */
export function sharedCurrency(currencyIds: number[]): number | null {
  if (currencyIds.length === 0) return null;
  const first = currencyIds[0]!;
  return currencyIds.every((id) => id === first) ? first : null;
}

/** Min / median / max of a set of prices, for !price and !vendstats. */
export function priceSummary(costs: number[]): { min: number; median: number; max: number } | null {
  if (costs.length === 0) return null;

  const sorted = [...costs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return {
    min: sorted[0]!,
    median: sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!,
    max: sorted.at(-1)!,
  };
}

/** A history entry, for !vendhistory. */
export function describePricePoint(
  point: PricePoint,
  formatClock: (d: Date) => string,
): string {
  // Chat only, so the community name always applies here.
  return `${formatClock(point.at)} ${point.grid} ${point.costPerItem} ${chatItemName(point.currencyId)}`;
}

/**
 * A change, for announcements.
 *
 * `short` renders the team chat version: community item names, and the grid
 * alone rather than the grid plus the shop's own name. Shop names are often
 * long and occasionally deliberately silly, which is fine in a Discord embed
 * and ruinous on a 128-character line where the price is what matters.
 */
export function describeVendingEvent(event: VendingEvent, options: NamingOptions = {}): string {
  const name = namerFor(options);
  const where = options.short ? event.machine.grid : `${event.machine.grid} "${event.machine.name}"`;
  const order = event.order;

  switch (event.kind) {
    case 'machine_placed':
      return `Shop placed: ${where}`;
    case 'machine_removed':
      return `Shop removed: ${where}`;

    case 'item_added':
      return order ? `New listing ${where}: ${describeOrder(order, options)}` : `New listing ${where}`;
    case 'item_removed':
      return order ? `Delisted ${where}: ${name(order.itemId)}` : `Delisted ${where}`;

    case 'out_of_stock':
      return order ? `OUT OF STOCK ${where}: ${name(order.itemId)}` : `Out of stock ${where}`;

    case 'stock_changed':
      return order && event.previous
        ? `Stock ${where}: ${name(order.itemId)} ${event.previous.amountInStock} → ${order.amountInStock}`
        : `Stock changed ${where}`;

    case 'price_changed':
      return order && event.previous
        ? `Price ${where}: ${name(order.itemId)} ${event.previous.costPerItem} → ${order.costPerItem} ${name(order.currencyId)}`
        : `Price changed ${where}`;

    case 'tracked_appeared':
      return order
        ? `TRACKED "${event.trackerLabel}" ${where}: ${describeOrder(order, options)} x${order.amountInStock}`
        : `TRACKED "${event.trackerLabel}" ${where}`;

    case 'tracked_price_changed':
      return order && event.previous
        ? `TRACKED "${event.trackerLabel}" ${where}: ${name(order.itemId)} ${event.previous.costPerItem} → ${order.costPerItem}`
        : `TRACKED "${event.trackerLabel}" ${where}`;
  }
}

/**
 * Which changes are worth announcing unprompted.
 *
 * A busy server churns stock constantly; announcing every tick would bury the
 * channel. Tracked items always get through, because someone asked for them.
 */
export function isAnnounceableVendingEvent(kind: VendingEvent['kind']): boolean {
  return kind === 'tracked_appeared' || kind === 'tracked_price_changed';
}
