import { beforeAll, describe, expect, it } from 'vitest';
import { VendingStore } from '../src/vending/store.js';
import { toVendingMachines } from '../src/vending/decode.js';
import { loadItems, findItem, itemName } from '../src/vending/items.js';
import { describeVendingEvent, isAnnounceableVendingEvent, joinCapped } from '../src/vending/format.js';
import { resolveVendingCommand } from '../src/vending/commands.js';
import { MarkerType, type RustMapMarker } from '../src/rustplus/types.js';
import type { SellOrder, VendingMachine } from '../src/vending/types.js';

const SCRAP = -932201673;
const MAP_SIZE = 4000;

beforeAll(() => {
  loadItems('../data/items.json');
});

function order(partial: Partial<SellOrder> = {}): SellOrder {
  return {
    itemId: 1,
    quantity: 1,
    currencyId: SCRAP,
    costPerItem: 10,
    amountInStock: 5,
    ...partial,
  };
}

function machine(partial: Partial<VendingMachine> = {}): VendingMachine {
  return {
    id: 1,
    name: 'Shop',
    x: 2000,
    y: 2000,
    grid: 'N13',
    outOfStock: false,
    orders: [order()],
    ...partial,
  };
}

const deps = (store: VendingStore) => ({
  store,
  formatClock: (d: Date) => d.toISOString().slice(11, 16),
});

describe('item lookup', () => {
  it('loads the bundled dataset', () => {
    expect(itemName(SCRAP)).toBe('Scrap');
  });

  it('resolves the names people actually type', () => {
    expect(itemName(findItem('scrap')!)).toBe('Scrap');
    expect(itemName(findItem('Scrap')!)).toBe('Scrap');
  });

  it('falls back to the raw id for unknown items', () => {
    // A game update adding items must not render them as "undefined".
    expect(itemName(123456789)).toBe('item 123456789');
  });

  it('returns null for nonsense rather than a wrong guess', () => {
    expect(findItem('zzzzzznotanitem')).toBeNull();
  });
});

describe('startup synchronisation', () => {
  it('records the baseline without announcing it', () => {
    // 167 shops exist the moment the bot connects. Announcing them would
    // claim every shop on the map was just built.
    const store = new VendingStore();
    const events = store.update([machine({ id: 1 }), machine({ id: 2 })]);

    expect(events).toEqual([]);
    expect(store.machineCount).toBe(2);
    expect(store.isPrimed).toBe(true);
  });

  it('seeds price history at startup so later changes have a baseline', () => {
    const store = new VendingStore();
    store.update([machine({ orders: [order({ itemId: SCRAP })] })]);
    expect(store.historyFor(SCRAP)).toHaveLength(1);
  });

  it('treats an empty snapshot as a glitch, not every shop vanishing', () => {
    const store = new VendingStore();
    store.update([machine({ id: 1 }), machine({ id: 2 })]);
    expect(store.update([])).toEqual([]);
    expect(store.machineCount).toBe(2);
  });
});

describe('change detection', () => {
  it('detects a shop being placed and removed', () => {
    const store = new VendingStore();
    store.update([machine({ id: 1 })]);

    const placed = store.update([machine({ id: 1 }), machine({ id: 2, name: 'New' })]);
    expect(placed.map((e) => e.kind)).toEqual(['machine_placed']);

    const removed = store.update([machine({ id: 1 })]);
    expect(removed.map((e) => e.kind)).toEqual(['machine_removed']);
  });

  it('detects a listing being added and delisted', () => {
    const store = new VendingStore();
    store.update([machine({ orders: [order({ itemId: 1 })] })]);

    const added = store.update([machine({ orders: [order({ itemId: 1 }), order({ itemId: 2 })] })]);
    expect(added.map((e) => e.kind)).toEqual(['item_added']);

    const removed = store.update([machine({ orders: [order({ itemId: 1 })] })]);
    expect(removed.map((e) => e.kind)).toEqual(['item_removed']);
  });

  it('detects a price change', () => {
    const store = new VendingStore();
    store.update([machine({ orders: [order({ costPerItem: 10 })] })]);

    const events = store.update([machine({ orders: [order({ costPerItem: 15 })] })]);
    expect(events[0]).toMatchObject({ kind: 'price_changed' });
    expect(events[0]!.previous!.costPerItem).toBe(10);
    expect(events[0]!.order!.costPerItem).toBe(15);
  });

  it('separates a stock change from going out of stock', () => {
    const store = new VendingStore();
    store.update([machine({ orders: [order({ amountInStock: 5 })] })]);

    expect(store.update([machine({ orders: [order({ amountInStock: 3 })] })])[0]).toMatchObject({
      kind: 'stock_changed',
    });
    expect(store.update([machine({ orders: [order({ amountInStock: 0 })] })])[0]).toMatchObject({
      kind: 'out_of_stock',
    });
  });

  it('reports a price change once, not also as a stock change', () => {
    // Buying something moves price and stock together; two alerts for one
    // event would double up.
    const store = new VendingStore();
    store.update([machine({ orders: [order({ costPerItem: 10, amountInStock: 5 })] })]);

    const events = store.update([machine({ orders: [order({ costPerItem: 12, amountInStock: 4 })] })]);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('price_changed');
  });

  it('says nothing when nothing changed', () => {
    const store = new VendingStore();
    store.update([machine()]);
    expect(store.update([machine()])).toEqual([]);
  });
});

describe('trackers', () => {
  it('fires when a tracked item appears', () => {
    const store = new VendingStore();
    store.update([machine({ orders: [] })]);
    store.addTracker('scrap', SCRAP, null);

    const events = store.update([machine({ orders: [order({ itemId: SCRAP })] })]);
    expect(events.map((e) => e.kind)).toContain('tracked_appeared');
  });

  it('fires when a tracked item changes price', () => {
    const store = new VendingStore();
    store.update([machine({ orders: [order({ itemId: SCRAP, costPerItem: 10 })] })]);
    store.addTracker('scrap', SCRAP, null);

    const events = store.update([machine({ orders: [order({ itemId: SCRAP, costPerItem: 20 })] })]);
    expect(events.map((e) => e.kind)).toContain('tracked_price_changed');
  });

  it('respects a grid restriction', () => {
    const store = new VendingStore();
    store.update([machine({ id: 1, grid: 'D12', orders: [] }), machine({ id: 2, grid: 'N13', orders: [] })]);
    store.addTracker('scrap', SCRAP, 'D12');

    const events = store.update([
      machine({ id: 1, grid: 'D12', orders: [] }),
      machine({ id: 2, grid: 'N13', orders: [order({ itemId: SCRAP })] }),
    ]);

    // The item appeared, but in the wrong grid for this tracker.
    expect(events.map((e) => e.kind)).toContain('item_added');
    expect(events.map((e) => e.kind)).not.toContain('tracked_appeared');
  });

  it('clears trackers individually and wholesale', () => {
    const store = new VendingStore();
    store.addTracker('scrap', SCRAP, null);
    store.addTracker('wood', 1, 'D12');

    expect(store.listTrackers()).toHaveLength(2);
    expect(store.removeTracker('scrap')).toBe(true);
    expect(store.listTrackers()).toHaveLength(1);
    expect(store.clearTrackers()).toBe(1);
    expect(store.listTrackers()).toHaveLength(0);
  });

  it('removes a grid tracker by item name alone', () => {
    // People remember the item, not the grid they typed with it.
    const store = new VendingStore();
    store.addTracker('scrap', SCRAP, 'D12');
    expect(store.removeTracker('scrap')).toBe(true);
    expect(store.listTrackers()).toHaveLength(0);
  });
});

describe('announcement filtering', () => {
  it('announces only tracked hits', () => {
    // A busy server churns hundreds of stock changes an hour.
    expect(isAnnounceableVendingEvent('tracked_appeared')).toBe(true);
    expect(isAnnounceableVendingEvent('tracked_price_changed')).toBe(true);
    expect(isAnnounceableVendingEvent('stock_changed')).toBe(false);
    expect(isAnnounceableVendingEvent('price_changed')).toBe(false);
    expect(isAnnounceableVendingEvent('machine_placed')).toBe(false);
  });
});

describe('decoding markers', () => {
  it('reads sell orders off a vending marker', () => {
    const markers: RustMapMarker[] = [
      {
        id: 5,
        type: MarkerType.VendingMachine,
        x: 2000,
        y: 2000,
        name: 'Food',
        outOfStock: false,
        sellOrders: [{ itemId: SCRAP, quantity: 5, currencyId: 1, costPerItem: 10, amountInStock: 3 }],
      } as RustMapMarker,
    ];

    const machines = toVendingMachines(markers, MAP_SIZE);
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({ name: 'Food', grid: 'N13' });
    expect(machines[0]!.orders[0]).toMatchObject({ itemId: SCRAP, quantity: 5 });
  });

  it('drops an order with no item or currency rather than rendering undefined', () => {
    const markers = [
      {
        id: 5,
        type: MarkerType.VendingMachine,
        x: 2000,
        y: 2000,
        sellOrders: [{ quantity: 5 }, { itemId: SCRAP, currencyId: 1 }],
      } as RustMapMarker,
    ];

    expect(toVendingMachines(markers, MAP_SIZE)[0]!.orders).toHaveLength(1);
  });

  it('ignores non-vending markers', () => {
    const markers = [{ id: 1, type: MarkerType.CargoShip, x: 0, y: 0 } as RustMapMarker];
    expect(toVendingMachines(markers, MAP_SIZE)).toHaveLength(0);
  });
});

describe('commands', () => {
  function stocked(): VendingStore {
    const store = new VendingStore();
    store.update([
      machine({ id: 1, name: 'Cheap', grid: 'D12', orders: [order({ itemId: SCRAP, costPerItem: 5 })] }),
      machine({ id: 2, name: 'Pricey', grid: 'N13', orders: [order({ itemId: SCRAP, costPerItem: 25 })] }),
    ]);
    return store;
  }

  it('!vend lists current sellers cheapest first', () => {
    const reply = resolveVendingCommand('vend', 'scrap', deps(stocked()))!;
    expect(reply).toContain('Scrap');
    expect(reply).toContain('D12');
    expect(reply.indexOf('D12')).toBeLessThan(reply.indexOf('N13'));
  });

  it('!vend says so when nothing is listed', () => {
    expect(resolveVendingCommand('vend', 'wood', deps(new VendingStore()))).toContain('not sold anywhere');
  });

  it('!price summarises the spread', () => {
    const reply = resolveVendingCommand('price', 'scrap', deps(stocked()))!;
    expect(reply).toContain('5-25');
  });

  it('!vendstats reports totals and per item', () => {
    const store = stocked();
    expect(resolveVendingCommand('vendstats', '', deps(store))).toContain('2 shops');
    expect(resolveVendingCommand('vendstats', 'scrap', deps(store))).toContain('2 listings');
  });

  it('!vendcommon ranks by listing count', () => {
    expect(resolveVendingCommand('vendcommon', '', deps(stocked()))).toContain('Scrap');
  });

  it('!vendhistory reports session history only', () => {
    const empty = resolveVendingCommand('vendhistory', 'scrap', deps(new VendingStore()))!;
    expect(empty).toContain('no history this session');
  });

  it('!vendtrack lists, adds and clears', () => {
    const store = stocked();
    const d = deps(store);

    expect(resolveVendingCommand('vendtrack', '', d)).toContain('No trackers');
    expect(resolveVendingCommand('vendtrack', 'scrap', d)).toContain('Tracking Scrap');
    expect(store.listTrackers()).toHaveLength(1);

    expect(resolveVendingCommand('vendtrack', '', d)).toContain('scrap');
    expect(resolveVendingCommand('vendtrack-clear', 'scrap', d)).toContain('Stopped tracking');
    expect(store.listTrackers()).toHaveLength(0);
  });

  it('!vendtrack accepts a leading grid', () => {
    const store = stocked();
    resolveVendingCommand('vendtrack', 'D12 scrap', deps(store));

    const tracker = store.listTrackers()[0]!;
    expect(tracker.grid).toBe('D12');
    expect(tracker.query).toBe('scrap');
  });

  it('read-only commands never create trackers', () => {
    // The architectural rule: only !vendtrack manages trackers.
    const store = stocked();
    const d = deps(store);

    for (const c of ['vend', 'price', 'vendstats', 'vendcommon', 'vendhistory']) {
      resolveVendingCommand(c, 'scrap', d);
    }

    expect(store.listTrackers()).toHaveLength(0);
  });

  it('returns null for commands it does not own', () => {
    // So the caller can fall through to the event commands.
    expect(resolveVendingCommand('heli', '', deps(new VendingStore()))).toBeNull();
    expect(resolveVendingCommand('vendor', '', deps(new VendingStore()))).toBeNull();
  });
});

describe('formatting', () => {
  it('caps long lists and says how many were dropped', () => {
    const entries = Array.from({ length: 40 }, (_, i) => `D${i} 10 Scrap`);
    const out = joinCapped(entries);
    expect(out).toMatch(/\+\d+ more/);
    expect(out.length).toBeLessThan(300);
  });

  it('always keeps at least one entry however long', () => {
    const out = joinCapped(['x'.repeat(500)]);
    expect(out).toHaveLength(500);
  });

  it('renders each change readably', () => {
    const base = { at: new Date(), machine: { id: 1, name: 'Shop', grid: 'D12' } };
    expect(describeVendingEvent({ ...base, kind: 'machine_placed' })).toContain('Shop placed');
    expect(
      describeVendingEvent({
        ...base,
        kind: 'price_changed',
        order: order({ itemId: SCRAP, costPerItem: 20 }),
        previous: order({ itemId: SCRAP, costPerItem: 10 }),
      }),
    ).toContain('10 → 20');
  });
});
