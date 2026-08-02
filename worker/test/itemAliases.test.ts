/**
 * Community aliases, and the integrity of the item data behind them.
 *
 * Every alias points at a short name. If one is misspelled, or Facepunch
 * removes the item, the alias silently stops working and the search quietly
 * falls back to text ranking — exactly the sort of failure nobody notices
 * until they are mid-raid asking the bot where to buy rockets.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { ITEM_ALIASES } from '../src/vending/aliases.js';
import { findItem, itemName, itemShortName, loadItems } from '../src/vending/items.js';

beforeAll(() => {
  loadItems();
});

describe('item data', () => {
  it('loads the full data set', () => {
    // 517 was the old truncated snapshot; the reference carries 1205.
    expect(loadItems()).toBeGreaterThan(1200);
  });

  it('has the names that were previously wrong', () => {
    expect(itemName(1524187186)).toBe('Workbench Level 1');
    expect(itemName(1426574435)).toBe('Minicopter');
    expect(itemName(-1663759755)).toBe('Homemade Landmine');
    expect(itemName(-1850571427)).toBe('Military Silencer');
    expect(itemName(174866732)).toBe('Variable Zoom Scope');
  });

  it('keeps the two window items distinct', () => {
    // These previously collided: one item carried the other's name.
    expect(itemName(671706427)).toBe('Reinforced Glass Window');
    expect(itemName(-1614955425)).toBe('Strengthened Glass Window');
  });
});

describe('aliases', () => {
  it('every alias resolves to a real item', () => {
    const broken: string[] = [];
    for (const [alias, short] of Object.entries(ITEM_ALIASES)) {
      const id = findItem(alias);
      if (id === null || itemShortName(id) !== short) {
        broken.push(`${alias} -> ${short} (got ${id === null ? 'nothing' : itemShortName(id)})`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('resolves the ones plain search gets wrong', () => {
    // "ak" matches no item name at all without the alias table.
    expect(itemName(findItem('ak')!)).toBe('Assault Rifle');
    expect(itemName(findItem('c4')!)).toBe('Timed Explosive Charge');
    // "semi" would otherwise prefix-match "Semi Automatic Body".
    expect(itemName(findItem('semi')!)).toBe('Semi-Automatic Rifle');
    expect(itemName(findItem('p2')!)).toBe('Semi-Automatic Pistol');
    expect(itemName(findItem('hqm')!)).toBe('High Quality Metal');
    expect(itemName(findItem('tc')!)).toBe('Tool Cupboard');
    expect(itemName(findItem('t3')!)).toBe('Workbench Level 3');
  });

  it('is case and punctuation insensitive', () => {
    for (const q of ['AK', 'ak', 'A.K.', ' Ak ']) {
      expect(itemName(findItem(q)!)).toBe('Assault Rifle');
    }
    expect(itemName(findItem('5.56')!)).toBe('5.56 Rifle Ammo');
  });

  it('separates workbench tiers from blueprint fragment tiers', () => {
    expect(itemName(findItem('t2')!)).toBe('Workbench Level 2');
    expect(itemName(findItem('t2 bp')!)).toBe('Basic Blueprint Fragment');
    expect(itemName(findItem('adv')!)).toBe('Advanced Blueprint Fragment');
  });

  it('leaves ordinary searches alone', () => {
    expect(itemName(findItem('scrap')!)).toBe('Scrap');
    expect(itemName(findItem('sulfur')!)).toBe('Sulfur');
    expect(itemName(findItem('garage door')!)).toBe('Garage Door');
  });
});
