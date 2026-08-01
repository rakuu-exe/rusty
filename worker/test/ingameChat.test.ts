import { describe, expect, it, vi } from 'vitest';
import { InGameChatHandler, SelfMessageTracker, resolveInGameCommand } from '../src/ingame/chat.js';
import { EventStateStore, EventSubject } from '../src/events/state.js';
import type { RustPlusClient } from '../src/rustplus/client.js';

function fakeClient(): RustPlusClient & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    sendTeamMessage: vi.fn(async (message: string) => {
      sent.push(message);
    }),
    getInfo: vi.fn(async () => ({
      name: 'Test Server',
      mapSize: 4000,
      wipeTime: Math.floor(Date.now() / 1000) - 3600,
      players: 100,
      maxPlayers: 200,
    })),
  } as unknown as RustPlusClient & { sent: string[] };
}

function deps(state = new EventStateStore()) {
  return { serverId: 's1', client: fakeClient(), prefix: '!', state };
}

const PAIRED_STEAM_ID = '76561190000000000';

describe('commands are read-only', () => {
  it('leaves session state untouched', async () => {
    // The core architectural guarantee: asking a question must never create
    // state. A command that writes in order to answer is inventing the answer.
    const state = new EventStateStore();
    const before = JSON.stringify(state.all());

    for (const c of ['heli', 'cargo', 'large', 'small', 'oil', 'chinook', 'vendor', 'crate', 'deepsea', 'events']) {
      await resolveInGameCommand(`!${c}`, deps(state));
    }

    expect(JSON.stringify(state.all())).toBe(before);
  });

  it('reports honestly when nothing has been observed', async () => {
    for (const [command, label] of [
      ['heli', 'Patrol Helicopter'],
      ['cargo', 'Cargo Ship'],
      ['chinook', 'Chinook'],
      ['vendor', 'Travelling Vendor'],
    ] as const) {
      const reply = await resolveInGameCommand(`!${command}`, deps());
      expect(reply, command).toBe(`${label}: not observed this session`);
    }
  });

  it('says what it can actually watch for on the oil rigs', async () => {
    // Rust+ publishes no marker for the crate on a rig -- verified against a
    // live server whose feed contained zero Crate markers while crates were
    // visible in game. Only the Heavy Scientist Chinook is observable, so the
    // reply must not imply the bot is watching for a crate it cannot see.
    for (const [command, label] of [
      ['large', 'Large Oil Rig'],
      ['small', 'Small Oil Rig'],
    ] as const) {
      const reply = await resolveInGameCommand(`!${command}`, deps());
      expect(reply, command).toBe(`${label}: no Heavy Scientists called this session`);
    }
  });

  it('says Deep Sea is unobserved when no anchor exists', async () => {
    expect(await resolveInGameCommand('!deepsea', deps())).toBe('Deep Sea: not observed this session');
  });
});

describe('all !when-* commands are gone', () => {
  it('does not answer any of them', async () => {
    for (const c of [
      'when-cargo',
      'when-crate',
      'when-deepsea',
      'when-heli',
      'when-loil',
      'when-oil',
      'when-smoil',
      'when-vendor',
    ]) {
      expect(await resolveInGameCommand(`!${c}`, deps()), c).toBeNull();
    }
  });

  it('does not answer the old deep sea anchoring command', async () => {
    // Anchoring moved to an admin Discord command so status stays read-only.
    expect(await resolveInGameCommand('!deepsea-open', deps())).toBeNull();
    expect(await resolveInGameCommand('!deepsea-opened', deps())).toBeNull();
  });
});

describe('status reflects the state store', () => {
  it('distinguishes something found at startup from something seen spawning', async () => {
    const startup = new EventStateStore();
    startup.markPresentAtStartup(EventSubject.CargoShip, new Date(), 'BOTTOM RIGHT');
    const startupReply = await resolveInGameCommand('!cargo', deps(startup));
    expect(startupReply).toContain('ACTIVE');
    expect(startupReply).toContain('detected after startup');
    expect(startupReply).toContain('spawn time unknown');

    const observed = new EventStateStore();
    observed.markSpawned(EventSubject.CargoShip, new Date(Date.now() - 5 * 60_000), 'P14');
    const observedReply = await resolveInGameCommand('!cargo', deps(observed));
    expect(observedReply).toContain('ACTIVE');
    expect(observedReply).not.toContain('startup');
    expect(observedReply).toContain('5m ago');
  });

  it('reports completion once something has ended', async () => {
    const state = new EventStateStore();
    state.markSpawned(EventSubject.PatrolHelicopter, new Date(Date.now() - 20 * 60_000), 'D18');
    state.markEnded(EventSubject.PatrolHelicopter, new Date(Date.now() - 2 * 60_000));

    expect(await resolveInGameCommand('!heli', deps(state))).toContain('ended 2m ago');
  });

  it('tracks the two oil rigs independently', async () => {
    const state = new EventStateStore();
    state.markSpawned(EventSubject.LargeOilRig, new Date(), 'TOP RIGHT');

    expect(await resolveInGameCommand('!large', deps(state))).toContain('crate AVAILABLE');
    expect(await resolveInGameCommand('!small', deps(state))).toBe('Small Oil Rig: no Heavy Scientists called this session');
  });

  it('shows the crate countdown after Heavy Scientists are called', async () => {
    const state = new EventStateStore();
    const now = new Date();
    state.markOilRigTriggered(
      EventSubject.LargeOilRig,
      now,
      new Date(now.getTime() + 15 * 60_000),
      'TOP RIGHT',
    );

    const reply = await resolveInGameCommand('!large', deps(state));
    expect(reply).toContain('Heavy Scientists called');
    expect(reply).toContain('unlocks in 15m');
  });

  it('!oil covers both rigs in one line', async () => {
    const reply = await resolveInGameCommand('!oil', deps());
    expect(reply).toContain('Large Oil Rig');
    expect(reply).toContain('Small Oil Rig');
  });
});

describe('InGameChatHandler', () => {
  it('answers the paired player rather than ignoring them', async () => {
    // Regression: sendTeamMessage posts as the paired player, so an earlier
    // loop guard keyed on that Steam ID dropped every command the owner typed.
    const d = deps();
    const handler = new InGameChatHandler(d, new SelfMessageTracker());

    await handler.handle(PAIRED_STEAM_ID, '!large');

    expect(d.client.sent).toHaveLength(1);
    expect(d.client.sent[0]).toContain('Large Oil Rig');
  });

  it('does not answer its own reply echoing back', async () => {
    const d = deps();
    const handler = new InGameChatHandler(d, new SelfMessageTracker());

    await handler.handle(PAIRED_STEAM_ID, '!large');
    await handler.handle(PAIRED_STEAM_ID, d.client.sent[0]!);

    expect(d.client.sent).toHaveLength(1);
  });

  it('rate limits bursts', async () => {
    const d = deps();
    const handler = new InGameChatHandler(d, new SelfMessageTracker());

    await handler.handle(PAIRED_STEAM_ID, '!large');
    await handler.handle(PAIRED_STEAM_ID, '!small');

    expect(d.client.sent).toHaveLength(1);
  });

  it('stays silent for ordinary chat and unknown commands', async () => {
    const d = deps();
    const handler = new InGameChatHandler(d, new SelfMessageTracker());

    await handler.handle(PAIRED_STEAM_ID, 'anyone got scrap');
    await handler.handle(PAIRED_STEAM_ID, '!banana');

    expect(d.client.sent).toHaveLength(0);
  });
});

describe('live server queries', () => {
  it('still work and are also read-only', async () => {
    const state = new EventStateStore();
    const before = JSON.stringify(state.all());

    expect(await resolveInGameCommand('!pop', deps(state))).toBe('Population: 100/200');
    expect(JSON.stringify(state.all())).toBe(before);
  });
});
