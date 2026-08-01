/**
 * Ambient types for @liamcottle/push-receiver, which ships no declarations.
 *
 * This is the same client @liamcottle/rustplus.js uses internally for
 * `fcm-listen`; we drive it directly so pairing can happen inside the worker
 * instead of in a separate terminal.
 */
declare module '@liamcottle/push-receiver/src/client.js' {
  import type { EventEmitter } from 'node:events';

  /** One key/value pair from the notification payload. */
  export interface AppDataEntry {
    key: string;
    value: string;
  }

  export interface PushNotificationData {
    /** Server-assigned id, used for the persistent-id dedupe list. */
    persistentId?: string;
    appData: AppDataEntry[];
  }

  export default class PushReceiverClient extends EventEmitter {
    constructor(androidId: string, securityToken: string, persistentIds: string[]);
    connect(): Promise<void>;
    destroy(): void;
    on(event: 'ON_DATA_RECEIVED', listener: (data: PushNotificationData) => void): this;
    on(event: 'connect' | 'disconnect', listener: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}
