import { beforeAll, describe, expect, it } from 'vitest';
import { VendingStore } from '../src/vending/store.js';
import { toVendingMachines } from '../src/vending/decode.js';
import { loadItems, findItem, itemName } from '../src/vending/items.js';
import { describeVendingEvent, isAnnounceableVendingEvent, joinCapped } from '../src/vending/format.js';
import { ALIAS_DISPLAY } from '../src/vending/aliases.js';
import type { VendingEvent } from '../src/vending/types.js';
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

/**
 * Fitting a busy map onto a 128-character chat line.
 *
 * The limit was previously set to 240, so the bot built a reply the game then
 * cut off at 128 — losing the tail, including the "+N more" that said anything
 * was missing. With thirty shops selling one item that looked like a broken
 * command rather than a truncated one.
 */
describe('!vend on a busy map', () => {
  const AK = 1545779598;

  /** Thirty shops selling the same item at rising prices. */
  function busyStore(count = 30): VendingStore {
    const grids = Array.from({ length: count }, (_, i) => `${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i % 26]}${i + 1}`);
    const store = new VendingStore();
    store.update(
      grids.map((grid, i) =>
        machine({
          id: i + 1,
          grid,
          orders: [order({ itemId: AK, costPerItem: 100 + i * 3, amountInStock: (i % 7) + 1 })],
        }),
      ),
    );
    return store;
  }

  it('never exceeds what Rust will actually send', () => {
    const store = busyStore();
    for (const page of ['ak', 'ak 2', 'ak 3', 'ak 4']) {
      const reply = resolveVendingCommand('vend', page, deps(store))!;
      expect(reply.length).toBeLessThanOrEqual(128);
    }
  });

  it('leads with the summary a shopper needs', () => {
    const reply = resolveVendingCommand('vend', 'ak', deps(busyStore()))!;

    // How many listings, the price range, and the currency — before any of them.
    expect(reply).toContain('30 listings');
    expect(reply).toContain('100-187');
    expect(reply).toContain('Scrap');
    // The nickname, not "Assault Rifle": eleven characters back on every reply.
    expect(reply.startsWith('AK:')).toBe(true);
  });

  it('fits far more listings than the long form did', () => {
    const reply = resolveVendingCommand('vend', 'ak', deps(busyStore()))!;
    const listings = reply.match(/[A-Z]\d+ \d+/g) ?? [];

    // The old format spent a third of the line repeating "Scrap → Assault
    // Rifle" on every entry, which left room for two.
    expect(listings.length).toBeGreaterThanOrEqual(6);
  });

  it('cheapest first, and pages through the rest', () => {
    const store = busyStore();
    const first = resolveVendingCommand('vend', 'ak', deps(store))!;
    const second = resolveVendingCommand('vend', 'ak 2', deps(store))!;

    expect(first).toContain('100');
    expect(first).toContain('(1/');
    expect(second).toContain('(2/');
    // Later pages must not repeat the cheapest listing.
    expect(second).not.toContain('A1 100');
  });

  it('clamps a page number past the end instead of erroring', () => {
    const reply = resolveVendingCommand('vend', 'ak 99', deps(busyStore()))!;
    expect(reply).toMatch(/\(\d+\/\d+\)/);
  });

  it('omits the page marker when everything fits', () => {
    const reply = resolveVendingCommand('vend', 'ak', deps(busyStore(3)))!;
    expect(reply).not.toContain('/');
    expect(reply.length).toBeLessThanOrEqual(128);
  });

  it('falls back to sold-out shops only when there is nothing else', () => {
    const store = new VendingStore();
    store.update([machine({ orders: [order({ itemId: AK, amountInStock: 0 })] })]);

    expect(resolveVendingCommand('vend', 'ak', deps(store))).toContain('SOLD OUT');
  });
});

describe('!vendhelp', () => {
  const store = new VendingStore();

  it('lists the commands within one chat line', () => {
    const reply = resolveVendingCommand('vendhelp', '', deps(store))!;

    expect(reply).toContain('!vend');
    expect(reply).toContain('!vendtrack');
    expect(reply.length).toBeLessThanOrEqual(128);
  });

  it('explains a single command', () => {
    const reply = resolveVendingCommand('vendhelp', 'vendtrack', deps(store))!;

    expect(reply).toContain('vendtrack');
    expect(reply).toContain('in stock');
    expect(reply.length).toBeLessThanOrEqual(128);
  });

  it('tolerates a leading prefix on the argument', () => {
    expect(resolveVendingCommand('vendhelp', '!price', deps(store))).toContain('price');
  });

  it('says so when the command does not exist', () => {
    expect(resolveVendingCommand('vendhelp', 'nope', deps(store))).toContain('No vending command');
  });
});

/**
 * The limit applies to every reply, not just the ones anyone thought to check.
 *
 * Three commands budgeted only the entries they joined and ignored their own
 * headers, so each still overshot 128 after the limit itself was fixed. A
 * blanket assertion catches the next one without anyone remembering to.
 */
describe('every vending reply fits a Rust chat line', () => {
  const AK = 1545779598;

  function loadedStore(): VendingStore {
    const store = new VendingStore();
    const machines = Array.from({ length: 30 }, (_, i) =>
      machine({
        id: i + 1,
        grid: `${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i % 26]}${i + 1}`,
        orders: [
          order({ itemId: AK, costPerItem: 100 + i * 3, amountInStock: (i % 7) + 1 }),
          order({ itemId: SCRAP, costPerItem: 40 + i, currencyId: AK }),
        ],
      }),
    );
    // Two rounds so price history exists for !vendhistory.
    store.update(machines);
    store.update(machines.map((m) => ({ ...m, orders: m.orders.map((o) => ({ ...o, costPerItem: o.costPerItem + 5 })) })));
    return store;
  }

  const cases: [string, string][] = [
    ['vend', 'assault rifle'],
    ['vend', 'ak 2'],
    ['price', 'assault rifle'],
    ['vendstats', ''],
    ['vendstats', 'assault rifle'],
    ['vendcommon', ''],
    ['vendhistory', 'assault rifle'],
    ['vendtrack', 'assault rifle'],
    ['vendtrack', ''],
    ['vendsearch', 'rifle'],
    ['vendhelp', ''],
    ['vendhelp', 'vend'],
  ];

  for (const [command, args] of cases) {
    it(`!${command} ${args}`.trim(), () => {
      const reply = resolveVendingCommand(command, args, deps(loadedStore()));
      expect(reply).not.toBeNull();
      expect(reply!.length).toBeLessThanOrEqual(128);
    });
  }
});

/**
 * Rust chat renders rich-text markup, so it escapes angle brackets: a reply
 * containing "<item>" reaches the player as "&#60;item&#62;". Usage hints are
 * the obvious place this bites, since they are the one thing that naturally
 * wants placeholder syntax.
 */
describe('replies survive Rust chat encoding', () => {
  const store = new VendingStore();

  const everyReply = [
    resolveVendingCommand('vend', '', deps(store)),
    resolveVendingCommand('price', '', deps(store)),
    resolveVendingCommand('vendhistory', '', deps(store)),
    resolveVendingCommand('vendhelp', '', deps(store)),
    resolveVendingCommand('vendhelp', 'vend', deps(store)),
    resolveVendingCommand('vendhelp', 'vendtrack', deps(store)),
    resolveVendingCommand('vendtrack', '', deps(store)),
    resolveVendingCommand('vendcommon', '', deps(store)),
  ];

  it('never contain angle brackets', () => {
    for (const reply of everyReply) {
      expect(reply, `reply: ${reply}`).not.toMatch(/[<>]/);
    }
  });

  it('still show usage hints, just without markup characters', () => {
    expect(resolveVendingCommand('vend', '', deps(store))).toContain('!vend item');
  });
});

describe('nicknames in replies', () => {
  const AK = 1545779598;
  const HQM = 317398316;

  function storeWith(itemId: number, currencyId: number): VendingStore {
    const store = new VendingStore();
    store.update([machine({ orders: [order({ itemId, currencyId, costPerItem: 50 })] })]);
    return store;
  }

  it('names the item the way players do', () => {
    expect(resolveVendingCommand('vend', 'ak', deps(storeWith(AK, SCRAP)))).toContain('AK');
  });

  it('names the currency the same way', () => {
    // "HQM", not "High Quality Metal" — and not "hqm" either.
    const reply = resolveVendingCommand('vend', 'ak', deps(storeWith(AK, HQM)))!;
    expect(reply).toContain('HQM');
    expect(reply).not.toContain('High Quality Metal');
  });

  it('keeps full names where the nickname would lose information', () => {
    // !vendsearch exists to disambiguate, so it must not abbreviate.
    expect(resolveVendingCommand('vendsearch', 'assault rifle', deps(new VendingStore()))).toContain(
      'Assault Rifle',
    );
  });

  it('leaves items without a nickname alone', () => {
    expect(resolveVendingCommand('vend', 'scrap', deps(storeWith(SCRAP, AK)))).toContain('Scrap');
  });
});

/**
 * Announcements are rendered twice: once for Discord, once for team chat.
 *
 * Discord has no length limit and reads better with full names and the shop's
 * own name. Team chat is capped at 128 characters, so the same change has to
 * arrive as something a teammate can read at a glance mid-fight.
 */
describe('announcements in team chat', () => {
  const AK = 1545779598;
  const SULFUR = -1581843485;

  function priceChange(itemId: number, currencyId: number): VendingEvent {
    const store = new VendingStore();
    const shopName = 'Bobs Discount Emporium And Sons Ltd';
    store.update([machine({ name: shopName, orders: [order({ itemId, currencyId, costPerItem: 100 })] })]);
    return store.update([
      machine({ name: shopName, orders: [order({ itemId, currencyId, costPerItem: 120 })] }),
    ])[0]!;
  }

  it('uses the names players use', () => {
    const event = priceChange(AK, SCRAP);

    expect(describeVendingEvent(event, { short: true })).toContain('AK');
    expect(describeVendingEvent(event, { short: true })).not.toContain('Assault Rifle');
  });

  it('shortens the currency as well as the item', () => {
    const event = priceChange(AK, SULFUR);
    const short = describeVendingEvent(event, { short: true });

    expect(short).toContain('Sulf');
    expect(short).not.toContain('Sulfur ');
  });

  it('drops the shop name, keeping the grid', () => {
    const event = priceChange(AK, SCRAP);
    const short = describeVendingEvent(event, { short: true });

    expect(short).toContain('N13');
    expect(short).not.toContain('Emporium');
  });

  it('fits a chat line where the Discord version would not', () => {
    const event = priceChange(AK, SCRAP);

    expect(describeVendingEvent(event, { short: true }).length).toBeLessThanOrEqual(128);
  });

  it('leaves the Discord rendering long and explicit', () => {
    const long = describeVendingEvent(priceChange(AK, SCRAP));

    expect(long).toContain('Assault Rifle');
    expect(long).toContain('Emporium');
  });
});

describe('nickname table', () => {
  it('prefers the recognisable form over the shortest one', () => {
    // "basic" is the shortest alias for a Basic Blueprint Fragment and tells
    // you nothing; "T2 BP" is shorter than the full name and unambiguous.
    expect(ALIAS_DISPLAY['basicblueprintfragment']).toBe('T2 BP');
    expect(ALIAS_DISPLAY['advancedblueprintfragment']).toBe('T3 BP');
    expect(ALIAS_DISPLAY['sulfur']).toBe('Sulf');
    expect(ALIAS_DISPLAY['rifle.ak']).toBe('AK');
    expect(ALIAS_DISPLAY['pistol.semiauto']).toBe('P2');
    expect(ALIAS_DISPLAY['workbench2']).toBe('T2');
  });

  it('can type back everything it prints', () => {
    // A nickname the bot shows but cannot parse would be a dead end.
    for (const display of Object.values(ALIAS_DISPLAY)) {
      expect(findItem(display), `typing "${display}" back`).not.toBeNull();
    }
  });
});

/**
 * Mixed currencies.
 *
 * A live reply read "P2 16 shops 1-400: S6 1 x2 C6 1 x4 ... W7 100 x1". Two
 * separate failures: listings ran together with no separator, and the range
 * was computed across different currencies, so "1-400" was arithmetic on
 * unrelated units. A shop wanting 1 HQM and one wanting 400 scrap are not
 * two ends of a price range.
 */
describe('!vend with mixed currencies', () => {
  const P2 = 818877484;
  const HQM = 317398316;

  function mixedStore(): VendingStore {
    const store = new VendingStore();
    store.update([
      machine({ id: 1, grid: 'S6', orders: [order({ itemId: P2, currencyId: HQM, costPerItem: 1 })] }),
      machine({ id: 2, grid: 'W7', orders: [order({ itemId: P2, currencyId: SCRAP, costPerItem: 100 })] }),
    ]);
    return store;
  }

  it('does not invent a range across currencies', () => {
    const reply = resolveVendingCommand('vend', 'p2', deps(mixedStore()))!;

    expect(reply).toContain('mixed currency');
    expect(reply).not.toContain('1-100');
  });

  it('names the currency on each listing instead', () => {
    const reply = resolveVendingCommand('vend', 'p2', deps(mixedStore()))!;

    expect(reply).toContain('S6 1 HQM');
    expect(reply).toContain('W7 100 Scrap');
  });

  it('separates listings so they can be told apart', () => {
    const reply = resolveVendingCommand('vend', 'p2', deps(mixedStore()))!;
    expect(reply).toContain(' | ');
  });

  it('still names the currency once when they all agree', () => {
    const store = new VendingStore();
    store.update([
      machine({ id: 1, grid: 'S6', orders: [order({ itemId: P2, currencyId: SCRAP, costPerItem: 10 })] }),
      machine({ id: 2, grid: 'W7', orders: [order({ itemId: P2, currencyId: SCRAP, costPerItem: 40 })] }),
    ]);

    const reply = resolveVendingCommand('vend', 'p2', deps(store))!;

    expect(reply).toContain('10-40 Scrap');
    // Not repeated on every entry once the header has said it.
    expect(reply).toContain('S6 10 x5');
  });
});
