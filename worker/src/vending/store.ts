/**
 * Vending session state and change detection.
 *
 * Follows the same rules as the event system:
 *
 *  - **Startup synchronises, it does not announce.** The first snapshot records
 *    167 machines as the baseline and emits nothing. Announcing them would
 *    claim every shop on the map was just built.
 *
 *  - **Only observations mutate state.** Commands read. The one exception is
 *    tracker management, which is an explicit request rather than a side
 *    effect of asking a question.
 *
 *  - **History is session-scoped and in memory.** Restarting clears it, which
 *    is honest: the bot cannot describe changes it was not watching for.
 */

import { itemName } from './items.js';
import {
  orderKey,
  type PricePoint,
  type SellOrder,
  type VendingEvent,
  type VendingMachine,
  type VendingTracker,
} from './types.js';

/**
 * Cap on retained price points per item.
 *
 * A busy server produces a lot of churn, and this lives in memory for the
 * whole session. Recent history is what anyone actually asks about.
 */
export const MAX_HISTORY_PER_ITEM = 50;

/** Cap on the overall event log, for !vendhistory without an item. */
export const MAX_EVENTS = 500;

export class VendingStore {
  private machines = new Map<number, VendingMachine>();
  private primed = false;

  /** itemId -> observed price points, newest last. */
  private readonly history = new Map<number, PricePoint[]>();
  private readonly events: VendingEvent[] = [];
  private readonly trackers = new Map<string, VendingTracker>();

  get isPrimed(): boolean {
    return this.primed;
  }

  get machineCount(): number {
    return this.machines.size;
  }

  allMachines(): VendingMachine[] {
    return [...this.machines.values()];
  }

  /**
   * Feed a snapshot of every vending machine currently on the map.
   *
   * Returns the changes it implies. The first call returns nothing.
   */
  update(snapshot: VendingMachine[], now: Date = new Date()): VendingEvent[] {
    const current = new Map(snapshot.map((m) => [m.id, m]));

    if (!this.primed) {
      this.machines = current;
      this.primed = true;
      // Seed history so a later price change has something to compare against
      // in !vendhistory, without any of it counting as an observed change.
      for (const machine of snapshot) {
        for (const order of machine.orders) this.recordPrice(machine, order, now);
      }
      return [];
    }

    // An empty snapshot is a feed glitch, not every shop being destroyed at
    // once -- a live server always has vending machines.
    if (snapshot.length === 0 && this.machines.size > 0) return [];

    const events: VendingEvent[] = [];

    for (const machine of snapshot) {
      const before = this.machines.get(machine.id);
      if (!before) {
        events.push(this.event('machine_placed', machine, now));
        for (const order of machine.orders) this.recordPrice(machine, order, now);
        continue;
      }
      events.push(...this.diffOrders(before, machine, now));
    }

    for (const [id, machine] of this.machines) {
      if (!current.has(id)) events.push(this.event('machine_removed', machine, now));
    }

    this.machines = current;

    const matched = events.flatMap((e) => this.matchTrackers(e));
    const all = [...events, ...matched];

    for (const event of all) {
      this.events.push(event);
      if (this.events.length > MAX_EVENTS) this.events.shift();
    }

    return all;
  }

  /** Compare one machine's orders between two snapshots. */
  private diffOrders(before: VendingMachine, after: VendingMachine, now: Date): VendingEvent[] {
    const events: VendingEvent[] = [];
    const previous = new Map(before.orders.map((o) => [orderKey(o), o]));
    const seen = new Set<string>();

    for (const order of after.orders) {
      const key = orderKey(order);
      seen.add(key);
      const old = previous.get(key);

      if (!old) {
        events.push(this.event('item_added', after, now, order));
        this.recordPrice(after, order, now);
        continue;
      }

      // Price first: a price change matters more than the stock move that
      // often accompanies it, and reporting both would double up.
      if (old.costPerItem !== order.costPerItem || old.quantity !== order.quantity) {
        events.push(this.event('price_changed', after, now, order, old));
        this.recordPrice(after, order, now);
        continue;
      }

      if (old.amountInStock !== order.amountInStock) {
        const kind = order.amountInStock === 0 ? 'out_of_stock' : 'stock_changed';
        events.push(this.event(kind, after, now, order, old));
        this.recordPrice(after, order, now);
      }
    }

    for (const [key, old] of previous) {
      if (!seen.has(key)) events.push(this.event('item_removed', after, now, old));
    }

    return events;
  }

  private event(
    kind: VendingEvent['kind'],
    machine: VendingMachine,
    at: Date,
    order?: SellOrder,
    previous?: SellOrder,
  ): VendingEvent {
    return {
      kind,
      at,
      machine: { id: machine.id, name: machine.name, grid: machine.grid },
      ...(order ? { order } : {}),
      ...(previous ? { previous } : {}),
    };
  }

  private recordPrice(machine: VendingMachine, order: SellOrder, at: Date): void {
    const points = this.history.get(order.itemId) ?? [];
    points.push({
      at,
      machineId: machine.id,
      machineName: machine.name,
      grid: machine.grid,
      costPerItem: order.costPerItem,
      quantity: order.quantity,
      currencyId: order.currencyId,
      amountInStock: order.amountInStock,
    });
    if (points.length > MAX_HISTORY_PER_ITEM) points.shift();
    this.history.set(order.itemId, points);
  }

  // -------------------------------------------------------------------------
  // Trackers
  // -------------------------------------------------------------------------

  /** Turn an event into tracked_* events for any tracker that matches it. */
  private matchTrackers(event: VendingEvent): VendingEvent[] {
    if (!event.order) return [];
    if (event.kind !== 'item_added' && event.kind !== 'price_changed') return [];

    const matches: VendingEvent[] = [];

    for (const tracker of this.trackers.values()) {
      if (tracker.itemId !== null && tracker.itemId !== event.order.itemId) continue;
      if (tracker.itemId === null) {
        const name = itemName(event.order.itemId).toLowerCase();
        if (!name.includes(tracker.query.toLowerCase())) continue;
      }
      if (tracker.grid && tracker.grid !== event.machine.grid.toUpperCase()) continue;

      matches.push({
        ...event,
        kind: event.kind === 'item_added' ? 'tracked_appeared' : 'tracked_price_changed',
        trackerLabel: tracker.grid ? `${tracker.query} in ${tracker.grid}` : tracker.query,
      });
    }

    return matches;
  }

  addTracker(query: string, itemId: number | null, grid: string | null): VendingTracker {
    const tracker: VendingTracker = {
      query: query.trim(),
      itemId,
      grid: grid ? grid.toUpperCase() : null,
      createdAt: new Date(),
    };
    this.trackers.set(this.trackerKey(tracker.query, tracker.grid), tracker);
    return tracker;
  }

  removeTracker(query: string, grid: string | null = null): boolean {
    const key = this.trackerKey(query.trim(), grid ? grid.toUpperCase() : null);
    if (this.trackers.delete(key)) return true;

    // Convenience: "!vendtrack-clear ak" should drop an "ak in D12" tracker
    // too, since people remember the item rather than the grid they typed.
    let removed = false;
    for (const [k, tracker] of [...this.trackers]) {
      if (tracker.query.toLowerCase() === query.trim().toLowerCase()) {
        this.trackers.delete(k);
        removed = true;
      }
    }
    return removed;
  }

  clearTrackers(): number {
    const count = this.trackers.size;
    this.trackers.clear();
    return count;
  }

  listTrackers(): VendingTracker[] {
    return [...this.trackers.values()];
  }

  private trackerKey(query: string, grid: string | null): string {
    return `${query.toLowerCase()}::${grid ?? ''}`;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Every current listing of an item, cheapest first. */
  findListings(itemId: number): { machine: VendingMachine; order: SellOrder }[] {
    const listings: { machine: VendingMachine; order: SellOrder }[] = [];

    for (const machine of this.machines.values()) {
      for (const order of machine.orders) {
        if (order.itemId === itemId) listings.push({ machine, order });
      }
    }

    return listings.sort((a, b) => a.order.costPerItem - b.order.costPerItem);
  }

  /** Listings where an item is the *currency*, i.e. someone buying it. */
  findBuyers(itemId: number): { machine: VendingMachine; order: SellOrder }[] {
    const listings: { machine: VendingMachine; order: SellOrder }[] = [];

    for (const machine of this.machines.values()) {
      for (const order of machine.orders) {
        if (order.currencyId === itemId) listings.push({ machine, order });
      }
    }

    return listings.sort((a, b) => b.order.costPerItem - a.order.costPerItem);
  }

  historyFor(itemId: number): PricePoint[] {
    return this.history.get(itemId) ?? [];
  }

  recentEvents(limit = 10): VendingEvent[] {
    return this.events.slice(-limit).reverse();
  }

  /** How often each item appears across all machines. */
  itemFrequency(): { itemId: number; listings: number }[] {
    const counts = new Map<number, number>();

    for (const machine of this.machines.values()) {
      for (const order of machine.orders) {
        counts.set(order.itemId, (counts.get(order.itemId) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([itemId, listings]) => ({ itemId, listings }))
      .sort((a, b) => b.listings - a.listings);
  }

  stats(): { machines: number; withOrders: number; orders: number; distinctItems: number; changes: number } {
    let orders = 0;
    let withOrders = 0;
    const distinct = new Set<number>();

    for (const machine of this.machines.values()) {
      if (machine.orders.length > 0) withOrders++;
      orders += machine.orders.length;
      for (const order of machine.orders) distinct.add(order.itemId);
    }

    return {
      machines: this.machines.size,
      withOrders,
      orders,
      distinctItems: distinct.size,
      changes: this.events.length,
    };
  }
}
