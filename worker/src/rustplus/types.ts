/**
 * Shapes returned by the Rust+ (Rust Companion) API.
 *
 * The API is unofficial and has no published schema; these types describe the
 * protobuf-decoded objects that @liamcottle/rustplus.js hands back. Treat every
 * field as best-effort — Facepunch can change any of it without notice.
 */

/**
 * Marker types from AppMarkerType. Only a subset matters for event detection:
 * PatrolHelicopter, CargoShip, CH47 and Crate drive alerts, while Explosion is
 * used as corroborating evidence that a helicopter was shot down rather than
 * having flown off the map.
 */
export const MarkerType = {
  Undefined: 0,
  Player: 1,
  Explosion: 2,
  VendingMachine: 3,
  CH47: 4,
  CargoShip: 5,
  Crate: 6,
  GenericRadius: 7,
  PatrolHelicopter: 8,
  /**
   * Observed live but absent from the community-documented set (0-8).
   * Named here so it is not mistaken for a decoding fault; the detector
   * ignores it like any other unhandled type.
   */
  TravellingVendor: 9,
} as const;

export type MarkerTypeValue = (typeof MarkerType)[keyof typeof MarkerType];

export interface RustMapMarker {
  id: number;
  type: MarkerTypeValue;
  x: number;
  y: number;
  steamId?: string;
  rotation?: number;
  radius?: number;
  name?: string;
  outOfStock?: boolean;
  /**
   * Present on vending machines and genuinely populated, unlike crate markers.
   * Verified live: 153 of 167 machines carried orders, 724 in total.
   */
  sellOrders?: {
    itemId?: number;
    quantity?: number;
    currencyId?: number;
    costPerItem?: number;
    amountInStock?: number;
    itemIsBlueprint?: boolean;
    currencyIsBlueprint?: boolean;
  }[];
}

export interface RustMapMonument {
  token: string;
  x: number;
  y: number;
}

export interface RustMapInfo {
  width: number;
  height: number;
  jpgImage?: Buffer;
  oceanMargin: number;
  monuments: RustMapMonument[];
  background?: string;
}

/**
 * Fields here are optional because Facepunch actually drops them.
 *
 * Observed live on Rustafied EU Trio: the AppInfo response omitted both
 * `queuedPlayers` and `salt` while adding `nexus`/`nexusZone`. The bundled
 * proto still called queuedPlayers required, which crashed decoding until
 * scripts/patch-proto.mjs relaxed it. Treat everything past the basics as
 * "may be missing on some servers".
 */
export interface RustServerInfo {
  name: string;
  headerImage?: string;
  url?: string;
  map?: string;
  mapSize: number;
  wipeTime: number;
  players: number;
  maxPlayers: number;
  queuedPlayers?: number;
  seed?: number;
  salt?: number;
  logoImage?: string;
  nexus?: string;
  nexusId?: number;
  nexusZone?: string;
}

export interface RustTime {
  dayLengthMinutes: number;
  timeScale: number;
  sunrise: number;
  sunset: number;
  time: number;
}

export interface RustTeamMessage {
  steamId: string;
  name: string;
  message: string;
  color: string;
  time: number;
}

/** Credentials captured from a Rust+ pairing push notification. */
export interface PairingNotification {
  /** "server" for server pairing, "entity" for a smart device. */
  type: string;
  ip: string;
  port: string;
  playerId: string;
  playerToken: string;
  name: string;
  desc?: string;
  id?: string;
  entityType?: string;
}
