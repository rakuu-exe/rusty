/** Vending domain types, decoded from AppMarker.SellOrder. */

export interface SellOrder {
  itemId: number;
  quantity: number;
  currencyId: number;
  costPerItem: number;
  amountInStock: number;
  itemIsBlueprint?: boolean;
  currencyIsBlueprint?: boolean;
}

export interface VendingMachine {
  id: number;
  name: string;
  x: number;
  y: number;
  grid: string;
  outOfStock: boolean;
  orders: SellOrder[];
}

/**
 * What changed about a vending machine.
 *
 * Split finely so notifications can be selective: someone watching for a
 * restock does not want every price tweak on the map.
 */
export type VendingEventKind =
  | 'machine_placed'
  | 'machine_removed'
  | 'item_added'
  | 'item_removed'
  | 'out_of_stock'
  | 'stock_changed'
  | 'price_changed'
  | 'tracked_appeared'
  | 'tracked_price_changed';

export interface VendingEvent {
  kind: VendingEventKind;
  at: Date;
  machine: { id: number; name: string; grid: string };
  /** The order this concerns. Absent for whole-machine events. */
  order?: SellOrder;
  /** Previous state, for change events. */
  previous?: SellOrder;
  /** Which tracker matched, for tracked_* events. */
  trackerLabel?: string;
}

/**
 * A standing request to be told about an item.
 *
 * `grid` narrows it to one map cell, which is how you watch a specific shop
 * rather than the whole server.
 */
export interface VendingTracker {
  /** Normalised search phrase as typed. */
  query: string;
  /** Resolved item id, when the phrase matched the item data. */
  itemId: number | null;
  /** Optional grid restriction, uppercased. */
  grid: string | null;
  createdAt: Date;
}

/**
 * An order seen at a point in time, for price and stock history.
 *
 * Session-scoped by design: history describes what the bot watched change,
 * not what happened before it was looking.
 */
export interface PricePoint {
  at: Date;
  machineId: number;
  machineName: string;
  grid: string;
  costPerItem: number;
  quantity: number;
  currencyId: number;
  amountInStock: number;
}

/** Identity of an order within a machine. */
export function orderKey(order: SellOrder): string {
  return `${order.itemId}:${order.currencyId}`;
}
