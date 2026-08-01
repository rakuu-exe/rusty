/**
 * Checks the assumptions this project makes about third-party packages.
 *
 * Both Rust+ libraries are CommonJS and ship no type declarations, so the .d.ts
 * files in src/types are hand-written guesses. If a package changes shape, the
 * typecheck stays green and only these tests catch it.
 */

import { describe, expect, it } from 'vitest';
import { EventDetector } from '../src/events/detector.js';
import { formatEventLine } from '../src/format/message.js';
import { MonumentIndex } from '../src/rustplus/monuments.js';
import { MarkerType, type RustMapMarker } from '../src/rustplus/types.js';
import { parseFcmCredentials } from '../src/rustplus/pairing.js';

describe('third-party module shapes', () => {
  it('imports rustplus.js as a constructible default export', async () => {
    const module = await import('@liamcottle/rustplus.js');
    const RustPlus = module.default;

    expect(typeof RustPlus).toBe('function');

    // Constructing must not open a socket; connect() does that separately.
    const instance = new RustPlus('127.0.0.1', 28082, '76561190000000000', 'token');
    expect(typeof instance.connect).toBe('function');
    expect(typeof instance.getMapMarkers).toBe('function');
    expect(typeof instance.getMap).toBe('function');
    expect(typeof instance.sendTeamMessage).toBe('function');
    expect(typeof instance.on).toBe('function');
  });

  it('imports the push-receiver client from the path the CLI uses', async () => {
    // The .js extension is required by Node's ESM resolver in the compiled
    // build; omitting it works under tsx but crashes `node dist/index.js`.
    const module = await import('@liamcottle/push-receiver/src/client.js');
    expect(typeof module.default).toBe('function');
  });
});

describe('parseFcmCredentials', () => {
  it('accepts the structure fcm-register writes', () => {
    const config = JSON.stringify({
      fcm_credentials: {
        fcm: { token: 'fcm-token' },
        gcm: { androidId: '1234567890', securityToken: '9876543210' },
        keys: { privateKey: 'x', publicKey: 'y', authSecret: 'z' },
      },
      expo_push_token: 'ExponentPushToken[abc]',
      rustplus_auth_token: 'steam-auth-token',
    });

    const parsed = parseFcmCredentials(config);
    expect(parsed.fcm_credentials.gcm.androidId).toBe('1234567890');
    expect(parsed.expo_push_token).toBe('ExponentPushToken[abc]');
  });

  it('coerces numeric gcm ids, which some versions emit', () => {
    const config = JSON.stringify({
      fcm_credentials: { fcm: { token: 't' }, gcm: { androidId: 1234567890, securityToken: 9876543210 } },
    });

    expect(parseFcmCredentials(config).fcm_credentials.gcm.androidId).toBe('1234567890');
  });

  it('explains itself when given the wrong file', () => {
    expect(() => parseFcmCredentials('{"hello":"world"}')).toThrow(/fcm_credentials/);
    expect(() => parseFcmCredentials('not json')).toThrow(/valid JSON/);
  });
});

describe('end to end: markers in, headline out', () => {
  it('produces the reference oil rig headline from raw marker snapshots', () => {
    // The full v1 path with no network: monument cache -> detector -> formatter.
    const detector = new EventDetector({
      mapSize: 4000,
      monuments: new MonumentIndex([
        { token: 'large_oil_rig', x: 3300, y: 3300 },
        { token: 'oil_rig_small', x: 800, y: 900 },
      ]),
    });

    const t0 = new Date('2026-08-01T14:41:00Z');

    // Priming snapshot: the rig's permanent crate is already on the map.
    detector.update([{ id: 1, type: MarkerType.Crate, x: 3300, y: 3300 } as RustMapMarker], t0);

    // A Chinook arrives at the rig.
    const events = detector.update(
      [
        { id: 1, type: MarkerType.Crate, x: 3300, y: 3300 } as RustMapMarker,
        { id: 2, type: MarkerType.CH47, x: 3320, y: 3280 } as RustMapMarker,
      ],
      t0,
    );

    expect(events).toHaveLength(1);
    expect(formatEventLine(events[0]!, { timezone: 'UTC' })).toBe(
      'LARGE OIL RIG HEAVY SCIENTISTS CALLED 14:41 OPENS 14:56 @ W4',
    );

    // The Chinook arrival is what arms the countdown, and it lands on the
    // correct rig rather than being merged with the other one.
    const rig = detector.state.get('oil_rig_large');
    expect(rig.oilRig?.phase).toBe('triggered');
    expect(rig.oilRig?.unlocksAt?.getTime()).toBe(t0.getTime() + 15 * 60_000);
    expect(detector.state.get('oil_rig_small').oilRig?.phase).toBe('unknown');
  });

  it('synchronises the world at startup without announcing or dating it', () => {
    const detector = new EventDetector({
      mapSize: 4000,
      monuments: new MonumentIndex([{ token: 'large_oil_rig', x: 3300, y: 3300 }]),
    });

    // A cargo ship already sailing when the bot connects.
    const events = detector.update([{ id: 9, type: MarkerType.CargoShip, x: 500, y: 500 } as RustMapMarker]);

    expect(events).toEqual([]);
    const cargo = detector.state.get('cargo_ship');
    expect(cargo.state).toBe('active_at_startup');
    expect(cargo.startedAt).toBeNull();
  });

  it('survives a reconnect without re-announcing a sailing cargo ship', () => {
    const monuments = new MonumentIndex([{ token: 'large_oil_rig', x: 3300, y: 3300 }]);
    const cargo = { id: 9, type: MarkerType.CargoShip, x: 500, y: 500 } as RustMapMarker;

    // A fresh detector after a reconnect primes on whatever is already there.
    const detector = new EventDetector({ mapSize: 4000, monuments });
    expect(detector.update([cargo])).toEqual([]);
    expect(detector.update([cargo])).toEqual([]);
  });
});
