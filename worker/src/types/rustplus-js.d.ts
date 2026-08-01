/**
 * Ambient types for @liamcottle/rustplus.js, which ships no declarations.
 *
 * Only the surface this project uses is described. The library is CommonJS and
 * callback-based; src/rustplus/client.ts wraps it into promises.
 */
declare module '@liamcottle/rustplus.js' {
  import type { EventEmitter } from 'node:events';

  /** A decoded AppMessage. Exactly one of `response` / `broadcast` is set. */
  export interface AppMessage {
    response?: {
      seq: number;
      error?: { error: string };
      info?: unknown;
      map?: unknown;
      mapMarkers?: { markers: unknown[] };
      time?: unknown;
      teamInfo?: unknown;
      success?: Record<string, never>;
    };
    broadcast?: {
      teamMessage?: {
        message: {
          steamId: string | { toString(): string };
          name: string;
          message: string;
          color: string;
          time: number;
        };
      };
      teamChanged?: unknown;
      entityChanged?: unknown;
    };
  }

  /** Returning true marks the message handled and stops further dispatch. */
  export type AppCallback = (message: AppMessage) => boolean | void;

  export default class RustPlus extends EventEmitter {
    constructor(server: string, port: number | string, playerId: string, playerToken: string, useFacepunchProxy?: boolean);

    connect(): void;
    disconnect(): void;
    isConnected(): boolean;

    sendRequest(data: Record<string, unknown>, callback?: AppCallback): void;

    getInfo(callback: AppCallback): void;
    getTime(callback: AppCallback): void;
    getMap(callback: AppCallback): void;
    getMapMarkers(callback: AppCallback): void;
    getTeamInfo(callback: AppCallback): void;
    sendTeamMessage(message: string, callback?: AppCallback): void;
  }
}
