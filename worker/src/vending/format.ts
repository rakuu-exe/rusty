/**
 * Rendering vending data for team chat and Discord.
 *
 * Rust chat lines are short and read mid-game, so everything here truncates
 * rather than wraps, and always says how much was left out — "+12 more" is
 * useful, a silently trimmed list is misleading.
 */

import { itemName } from './items.js';
import type { PricePoint, SellOrder, VendingEvent, VendingMachine } from './types.js';

/** Roughly what fits on a Rust chat line before it becomes unreadable. */
export const MAX_CHAT_LENGTH = 240;

/** "5x Scrap" or just "Scrap" for a single unit. */
export function describeAmount(itemId: number, quantity: number): string {
  return quantity === 1 ? itemName(itemId) : `${quantity}x ${itemName(itemId)}`;
}

/** "10 Scrap for 5x Cloth" — the deal as a shopper reads it. */
export function describeOrder(order: SellOrder): string {
  const cost = describeAmount(order.currencyId, order.costPerItem);
  const item = describeAmount(order.itemId, order.quantity);
  return `${cost} → ${item}`;
}

/** Joins entries up to a length budget, appending "+N more" when truncated. */
export function joinCapped(entries: string[], separator = ' | ', max = MAX_CHAT_LENGTH): string {
  const kept: string[] = [];
  let length = 0;

  for (const entry of entries) {
    const cost = entry.length + (kept.length > 0 ? separator.length : 0);
    // Always keep at least one, however long, so a reply is never empty.
    if (kept.length > 0 && length + cost > max) break;
    kept.push(entry);
    length += cost;
  }

  const omitted = entries.length - kept.length;
  return omitted > 0 ? `${kept.join(separator)} (+${omitted} more)` : kept.join(separator);
}

/** One listing: where it is, and what it costs. */
export function describeListing(machine: VendingMachine, order: SellOrder): string {
  const stock = order.amountInStock === 0 ? ' OUT OF STOCK' : ` x${order.amountInStock}`;
  return `${machine.grid} ${describeOrder(order)}${stock}`;
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
  return `${formatClock(point.at)} ${point.grid} ${point.costPerItem} ${itemName(point.currencyId)}`;
}

/** A change, for announcements. Kept terse enough for in-game chat. */
export function describeVendingEvent(event: VendingEvent): string {
  const where = `${event.machine.grid} "${event.machine.name}"`;
  const order = event.order;

  switch (event.kind) {
    case 'machine_placed':
      return `Shop placed: ${where}`;
    case 'machine_removed':
      return `Shop removed: ${where}`;

    case 'item_added':
      return order ? `New listing ${where}: ${describeOrder(order)}` : `New listing ${where}`;
    case 'item_removed':
      return order ? `Delisted ${where}: ${itemName(order.itemId)}` : `Delisted ${where}`;

    case 'out_of_stock':
      return order ? `OUT OF STOCK ${where}: ${itemName(order.itemId)}` : `Out of stock ${where}`;

    case 'stock_changed':
      return order && event.previous
        ? `Stock ${where}: ${itemName(order.itemId)} ${event.previous.amountInStock} → ${order.amountInStock}`
        : `Stock changed ${where}`;

    case 'price_changed':
      return order && event.previous
        ? `Price ${where}: ${itemName(order.itemId)} ${event.previous.costPerItem} → ${order.costPerItem} ${itemName(order.currencyId)}`
        : `Price changed ${where}`;

    case 'tracked_appeared':
      return order
        ? `TRACKED "${event.trackerLabel}" ${where}: ${describeOrder(order)} x${order.amountInStock}`
        : `TRACKED "${event.trackerLabel}" ${where}`;

    case 'tracked_price_changed':
      return order && event.previous
        ? `TRACKED "${event.trackerLabel}" ${where}: ${itemName(order.itemId)} ${event.previous.costPerItem} → ${order.costPerItem}`
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
