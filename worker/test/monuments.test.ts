import { describe, expect, it } from 'vitest';
import { MonumentIndex, monumentDisplayName } from '../src/rustplus/monuments.js';

const monuments = [
  { token: 'large_oil_rig', x: 3300, y: 3300 },
  { token: 'oil_rig_small', x: 800, y: 900 },
  { token: 'launchsite', x: 2000, y: 2000 },
];

describe('monumentDisplayName', () => {
  it('uses known names', () => {
    expect(monumentDisplayName('large_oil_rig')).toBe('Large Oil Rig');
    expect(monumentDisplayName('oil_rig_small')).toBe('Small Oil Rig');
  });

  it('falls back to a tidied token', () => {
    expect(monumentDisplayName('some_new_monument_display_name')).toBe('Some New Monument');
  });
});

describe('MonumentIndex.oilRigAt', () => {
  const index = new MonumentIndex(monuments);

  it('identifies a Chinook sitting on Large Oil Rig', () => {
    expect(index.oilRigAt(3310, 3290)?.kind).toBe('large');
  });

  it('identifies Small Oil Rig', () => {
    expect(index.oilRigAt(810, 890)?.kind).toBe('small');
  });

  it('returns null for a Chinook merely crossing the map', () => {
    // This is the branch that decides "crate called" vs "chinook entered map",
    // so a false positive here produces a bogus oil rig alert every crossing.
    expect(index.oilRigAt(2000, 2000)).toBeNull();
  });

  it('picks the closer rig when both are in range', () => {
    const tight = new MonumentIndex([
      { token: 'large_oil_rig', x: 1000, y: 1000 },
      { token: 'oil_rig_small', x: 1100, y: 1000 },
    ]);
    expect(tight.oilRigAt(1090, 1000)?.kind).toBe('small');
  });

  it('respects the radius boundary', () => {
    expect(index.oilRigAt(3300 + 199, 3300)).not.toBeNull();
    expect(index.oilRigAt(3300 + 201, 3300)).toBeNull();
  });
});

describe('MonumentIndex.byToken', () => {
  it('returns every instance of a duplicated monument', () => {
    const index = new MonumentIndex([
      { token: 'harbor_display_name', x: 100, y: 100 },
      { token: 'harbor_display_name', x: 900, y: 900 },
    ]);
    expect(index.byToken('harbor_display_name')).toHaveLength(2);
  });
});
