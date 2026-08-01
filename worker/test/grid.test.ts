import { describe, expect, it } from 'vitest';
import {
  GRID_DIAMETER,
  columnToLetters,
  formatGridPosition,

  getCorrectedMapSize,
  getGridCell,
  getGridCount,
  getMapRegion,
  isOutsideGridSystem,
} from '../src/rustplus/grid.js';

// A 4000 map is the common case and gives a 27x27 grid (A0 .. AA26),
// which is enough to exercise the two-letter column path.
const MAP_4000 = 4000;

describe('getCorrectedMapSize', () => {
  it('rounds a 4000 map down to whole cells', () => {
    // 146.25 * 27 = 3948.75, remainder 51.25 which is under the 120 threshold.
    expect(getCorrectedMapSize(MAP_4000)).toBeCloseTo(3948.75, 5);
  });

  it('rounds up when the remainder is at least 120', () => {
    // 146.25 * 24 = 3510, so 3640 leaves a remainder of 130.
    expect(getCorrectedMapSize(3640)).toBeCloseTo(3656.25, 5);
  });

  it('leaves exact multiples untouched', () => {
    expect(getCorrectedMapSize(GRID_DIAMETER * 20)).toBeCloseTo(GRID_DIAMETER * 20, 5);
  });
});

describe('getGridCount', () => {
  it('gives 27 cells per axis on a 4000 map', () => {
    expect(getGridCount(MAP_4000)).toBe(27);
  });
});

describe('columnToLetters', () => {
  it('maps the single-letter range', () => {
    expect(columnToLetters(0)).toBe('A');
    expect(columnToLetters(22)).toBe('W');
    expect(columnToLetters(25)).toBe('Z');
  });

  it('maps the two-letter range the way the game does', () => {
    expect(columnToLetters(26)).toBe('AA');
    expect(columnToLetters(27)).toBe('AB');
    // 6000 is the largest map size, giving 41 columns; index 40 is the last.
    expect(columnToLetters(40)).toBe('AO');
  });
});

describe('getGridCell', () => {
  it('puts the north-west corner at A0', () => {
    // Row 0 is the northern edge, so y must be near the top of the map.
    const cell = getGridCell(10, 3940, MAP_4000);
    expect(cell?.label).toBe('A0');
  });

  it('puts the south-east corner at the last cell', () => {
    const cell = getGridCell(3940, 10, MAP_4000);
    expect(cell?.label).toBe('AA26');
  });

  it('resolves a mid-map position to W4', () => {
    // Column W is index 22 -> x in [3217.5, 3363.75).
    // Row 4 counts from the north, so y is in the same band from the south:
    // rowFromSouth = 27 - 1 - 4 = 22.
    const cell = getGridCell(3300, 3300, MAP_4000);
    expect(cell).toMatchObject({ column: 22, row: 4, label: 'W4' });
  });

  it('inverts the y axis rather than reusing it directly', () => {
    // The same coordinate value on each axis must not produce a matching
    // column and row -- this is the regression that catches a missing flip.
    const cell = getGridCell(1000, 1000, MAP_4000);
    expect(cell?.column).not.toBe(cell?.row);
  });

  it('clamps a position exactly on the far edge into the last cell', () => {
    const corrected = getCorrectedMapSize(MAP_4000);
    const cell = getGridCell(corrected, corrected, MAP_4000);
    expect(cell?.column).toBe(26);
    expect(cell?.row).toBe(0);
  });

  it('returns null outside the grid', () => {
    expect(getGridCell(-500, 2000, MAP_4000)).toBeNull();
  });
});

describe('isOutsideGridSystem', () => {
  it('accepts in-grid positions', () => {
    expect(isOutsideGridSystem(2000, 2000, MAP_4000)).toBe(false);
  });

  it('rejects ocean-margin positions on every side', () => {
    expect(isOutsideGridSystem(-500, 2000, MAP_4000)).toBe(true);
    expect(isOutsideGridSystem(2000, -500, MAP_4000)).toBe(true);
    expect(isOutsideGridSystem(4500, 2000, MAP_4000)).toBe(true);
    expect(isOutsideGridSystem(2000, 4500, MAP_4000)).toBe(true);
  });
});

describe('getMapRegion', () => {
  // Real coordinates from Rustafied EU Trio, a 4000 map. Both rigs sit in the
  // ocean past the grid edge, which is exactly why regions exist.
  const LARGE_RIG = { x: 3275, y: 4329 };
  const SMALL_RIG = { x: -324, y: 4334 };

  it('places the real oil rigs where a player would say they are', () => {
    expect(getMapRegion(LARGE_RIG.x, LARGE_RIG.y, MAP_4000)).toBe('TOP RIGHT');
    expect(getMapRegion(SMALL_RIG.x, SMALL_RIG.y, MAP_4000)).toBe('TOP LEFT');
  });

  it('covers every edge and corner', () => {
    expect(getMapRegion(2000, 4500, MAP_4000)).toBe('TOP MIDDLE');
    expect(getMapRegion(-500, 2000, MAP_4000)).toBe('LEFT MIDDLE');
    expect(getMapRegion(4500, 2000, MAP_4000)).toBe('RIGHT MIDDLE');
    expect(getMapRegion(-500, -500, MAP_4000)).toBe('BOTTOM LEFT');
    expect(getMapRegion(2000, -500, MAP_4000)).toBe('BOTTOM MIDDLE');
    expect(getMapRegion(4500, -200, MAP_4000)).toBe('BOTTOM RIGHT');
  });

  it('splits the map into even thirds', () => {
    // A 3948.75 grid gives 1316.25 per band.
    expect(getMapRegion(100, 4500, MAP_4000)).toBe('TOP LEFT');
    expect(getMapRegion(1400, 4500, MAP_4000)).toBe('TOP MIDDLE');
    expect(getMapRegion(3900, 4500, MAP_4000)).toBe('TOP RIGHT');
  });
});

describe('formatGridPosition', () => {
  it('renders an in-grid cell', () => {
    expect(formatGridPosition(3300, 3300, MAP_4000)).toBe('W4');
  });

  it('falls back to a region rather than inventing a cell', () => {
    // The grid covers the whole playable map, so only things that spawn
    // beyond its edge take this path.
    expect(formatGridPosition(3275, 4329, MAP_4000)).toBe('TOP RIGHT');
    expect(formatGridPosition(-324, 4334, MAP_4000)).toBe('TOP LEFT');
    expect(formatGridPosition(-500, 2000, MAP_4000)).toBe('LEFT MIDDLE');
  });
});

