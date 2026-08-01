/**
 * Turn raw map markers into vending machines.
 *
 * Kept separate from the store so the store can be tested with plain objects
 * and never needs to know about marker shapes or grid maths.
 */

import { formatGridPosition } from '../rustplus/grid.js';
import { MarkerType, type RustMapMarker } from '../rustplus/types.js';
import type { SellOrder, VendingMachine } from './types.js';

interface RawSellOrder {
  itemId?: number;
  quantity?: number;
  currencyId?: number;
  costPerItem?: number;
  amountInStock?: number;
  itemIsBlueprint?: boolean;
  currencyIsBlueprint?: boolean;
}

/**
 * Every field on AppMarker.SellOrder is optional in the protobuf, and the
 * schema was relaxed further so a missing field cannot crash decoding. An
 * order without an item or a currency describes nothing, so it is dropped
 * rather than rendered as "item undefined".
 */
function toSellOrder(raw: RawSellOrder): SellOrder | null {
  if (raw.itemId === undefined || raw.currencyId === undefined) return null;

  return {
    itemId: raw.itemId,
    quantity: raw.quantity ?? 1,
    currencyId: raw.currencyId,
    costPerItem: raw.costPerItem ?? 0,
    amountInStock: raw.amountInStock ?? 0,
    ...(raw.itemIsBlueprint ? { itemIsBlueprint: true } : {}),
    ...(raw.currencyIsBlueprint ? { currencyIsBlueprint: true } : {}),
  };
}

export function toVendingMachines(markers: RustMapMarker[], mapSize: number): VendingMachine[] {
  const machines: VendingMachine[] = [];

  for (const marker of markers) {
    if (marker.type !== MarkerType.VendingMachine) continue;

    const raw = (marker as RustMapMarker & { sellOrders?: RawSellOrder[] }).sellOrders ?? [];
    const orders = raw.map(toSellOrder).filter((o): o is SellOrder => o !== null);

    machines.push({
      id: marker.id,
      name: marker.name?.trim() || 'Unnamed shop',
      x: marker.x,
      y: marker.y,
      grid: formatGridPosition(marker.x, marker.y, mapSize),
      outOfStock: marker.outOfStock ?? false,
      orders,
    });
  }

  return machines;
}
