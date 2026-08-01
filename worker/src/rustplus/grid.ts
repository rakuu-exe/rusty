/**
 * Conversion from Rust world coordinates to map grid labels ("W4").
 *
 * Rust+ marker coordinates share the map image's coordinate space: (0, 0) is
 * the south-west corner, and x/y run to roughly `mapSize`. Grid columns are
 * lettered west-to-east starting at A; grid rows are numbered north-to-south
 * starting at 0, matching the in-game map. That row inversion is why `y` is
 * flipped below and not simply divided.
 *
 * Cargo Ship and the Patrol Helicopter both spawn in the ocean margin
 * *outside* the grid system, so callers must be able to render a position that
 * has no valid cell. Those return a compass description instead of a cell.
 */

/** Width/height of one grid cell in world units. */
export const GRID_DIAMETER = 146.25;

/**
 * Rust snaps the playable area to whole grid cells. A map's nominal size is
 * not necessarily a multiple of GRID_DIAMETER, so round it to the nearest cell
 * boundary before deriving the grid. The 120 threshold reproduces the game's
 * own rounding: a remainder that large is treated as a cell worth keeping.
 */
export function getCorrectedMapSize(mapSize: number): number {
  const remainder = mapSize % GRID_DIAMETER;
  return remainder < 120 ? mapSize - remainder : mapSize + (GRID_DIAMETER - remainder);
}

/** Number of grid cells per axis for a given map size. */
export function getGridCount(mapSize: number): number {
  return Math.floor(getCorrectedMapSize(mapSize) / GRID_DIAMETER);
}

/**
 * Column index to letter, reproducing Rust's own NumberToLetter.
 *
 * 0..25 -> A..Z, 26 -> AA, 27 -> AB, 52 -> ABA. The last one looks wrong but
 * is what the game does, and matching it matters more than being sensible:
 * players read these off the in-game map. Map sizes cap at 6000, giving 41
 * columns, so in practice this never goes past the two-letter range.
 */
export function columnToLetters(index: number): string {
  const repeats = Math.floor(index / 26);
  const remainder = index % 26;
  let prefix = '';
  for (let i = 0; i < repeats; i++) {
    prefix += String.fromCharCode(65 + i);
  }
  return prefix + String.fromCharCode(65 + remainder);
}

export interface GridCell {
  /** 0-based column index, west to east. */
  column: number;
  /** 0-based row index, north to south. */
  row: number;
  /** Rendered label, e.g. "W4". */
  label: string;
}

/** True when the position falls outside the playable grid (e.g. open ocean). */
export function isOutsideGridSystem(x: number, y: number, mapSize: number, margin = 0): boolean {
  const corrected = getCorrectedMapSize(mapSize);
  return x < -margin || y < -margin || x > corrected + margin || y > corrected + margin;
}

/**
 * Plain-language regions for positions with no grid cell.
 *
 * The grid already covers the whole playable map, so these are only ever
 * needed for the handful of things that spawn outside it: both Oil Rigs, the
 * Underwater Labs, Cargo Ship and the Patrol Helicopter. That is why there is
 * no centre region — anything mid-map is inside the grid and gets a cell.
 */
export type MapRegion =
  | 'TOP LEFT'
  | 'TOP MIDDLE'
  | 'TOP RIGHT'
  | 'LEFT MIDDLE'
  | 'RIGHT MIDDLE'
  | 'BOTTOM LEFT'
  | 'BOTTOM MIDDLE'
  | 'BOTTOM RIGHT'
  | 'MID MAP';

const REGION_GRID: readonly (readonly MapRegion[])[] = [
  // row 0 = southernmost band, matching world y running south to north.
  ['BOTTOM LEFT', 'BOTTOM MIDDLE', 'BOTTOM RIGHT'],
  ['LEFT MIDDLE', 'MID MAP', 'RIGHT MIDDLE'],
  ['TOP LEFT', 'TOP MIDDLE', 'TOP RIGHT'],
];

/**
 * Which third-of-the-map a position sits in, as a 3x3 split.
 *
 * Positions beyond the map edge clamp into the outer bands, which is what
 * makes this work for the ocean: Large Oil Rig at (3275, 4329) on a 4000 map
 * is past the north edge and 82% across, giving "TOP RIGHT".
 *
 * "MID MAP" is only returned for in-grid positions, which normally use a cell
 * instead; it exists so the type is total rather than as a real outcome.
 */
export function getMapRegion(x: number, y: number, mapSize: number): MapRegion {
  const corrected = getCorrectedMapSize(mapSize);
  const third = corrected / 3;

  const clampBand = (value: number) => Math.min(Math.max(Math.floor(value / third), 0), 2);

  return REGION_GRID[clampBand(y)]![clampBand(x)]!;
}

/**
 * Grid cell for an in-grid position, or null if it lies outside the map.
 *
 * Positions exactly on the far edge are clamped into the last cell rather than
 * overflowing into a column that does not exist.
 */
export function getGridCell(x: number, y: number, mapSize: number): GridCell | null {
  if (isOutsideGridSystem(x, y, mapSize)) return null;

  const gridCount = getGridCount(mapSize);
  const column = Math.min(Math.floor(x / GRID_DIAMETER), gridCount - 1);
  // Rows run north-to-south while world y runs south-to-north, hence the flip.
  const rowFromSouth = Math.min(Math.floor(y / GRID_DIAMETER), gridCount - 1);
  const row = gridCount - 1 - rowFromSouth;

  return { column, row, label: `${columnToLetters(column)}${row}` };
}

/**
 * How a position is described in an alert.
 *
 * The grid covers the entire playable map, so anything on it gets a precise
 * cell. Only what spawns beyond the edge — both Oil Rigs, Underwater Labs,
 * Cargo Ship, Patrol Helicopter — falls back to a region, because a clamped
 * edge cell there would be a precise-looking lie.
 *
 * In-grid   -> "D18"
 * Off-grid  -> "TOP RIGHT"
 */
export function formatGridPosition(x: number, y: number, mapSize: number): string {
  return getGridCell(x, y, mapSize)?.label ?? getMapRegion(x, y, mapSize);
}


/** Straight-line distance between two world positions. */
export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}
