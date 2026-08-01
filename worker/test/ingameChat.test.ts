import { describe, expect, it, vi } from 'vitest';
import { InGameChatHandler, resolveInGameCommand } from '../src/ingame/chat.js';
import type { RustPlusClient } from '../src/rustplus/client.js';

vi.mock('../src/db.js', () => ({
  getLastEvent: vi.fn(async () => null),
  getLastOilRigEvent: vi.fn(async () => null),
}));

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

const PAIRED_STEAM_ID = '76561190000000000';

describe('resolveInGameCommand', () => {
  const deps = { serverId: 's1', client: fakeClient(), prefix: '!' };

  it('ignores ordinary chat', async () => {
    expect(await resolveInGameCommand('hello team', deps)).toBeNull();
    expect(await resolveInGameCommand('going to large', deps)).toBeNull();
  });

  it('ignores an unknown command so normal "!" chatter draws no reply', async () => {
    expect(await resolveInGameCommand('!banana', deps)).toBeNull();
  });

  it('answers a known command even with no history recorded', async () => {
    expect(await resolveInGameCommand('!large', deps)).toBe('Large Oil Rig: no crate called this wipe');
    expect(await resolveInGameCommand('!heli', deps)).toBe('Heli: nothing recorded this wipe');
  });

  it('is case insensitive and tolerates surrounding whitespace', async () => {
    expect(await resolveInGameCommand('  !LARGE  ', deps)).toBe('Large Oil Rig: no crate called this wipe');
  });

  it('answers live-state commands from the server', async () => {
    expect(await resolveInGameCommand('!pop', deps)).toBe('Population: 100/200');
  });
});

describe('InGameChatHandler', () => {
  it('answers the paired player rather than ignoring them', async () => {
    // Regression: sendTeamMessage posts as the paired player, so an earlier
    // loop guard keyed on that Steam ID silently dropped every command the
    // owner typed -- "!large" did nothing at all.
    const client = fakeClient();
    const handler = new InGameChatHandler({ serverId: 's1', client, prefix: '!' });

    await handler.handle(PAIRED_STEAM_ID, '!large');

    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toContain('Large Oil Rig');
  });

  it('does not answer its own reply echoing back', async () => {
    const client = fakeClient();
    const handler = new InGameChatHandler({ serverId: 's1', client, prefix: '!' });

    await handler.handle(PAIRED_STEAM_ID, '!large');
    const reply = client.sent[0]!;

    // The reply arrives back over team chat carrying the same Steam ID.
    await handler.handle(PAIRED_STEAM_ID, reply);

    expect(client.sent).toHaveLength(1);
  });

  it('rate limits bursts', async () => {
    const client = fakeClient();
    const handler = new InGameChatHandler({ serverId: 's1', client, prefix: '!' });

    await handler.handle(PAIRED_STEAM_ID, '!large');
    await handler.handle(PAIRED_STEAM_ID, '!small');
    await handler.handle(PAIRED_STEAM_ID, '!heli');

    // Team chat costs 2 rate-limit tokens per reply and shares the bucket with
    // the marker poller, so a spamming teammate must not starve polling.
    expect(client.sent).toHaveLength(1);
  });

  it('stays silent for non-commands', async () => {
    const client = fakeClient();
    const handler = new InGameChatHandler({ serverId: 's1', client, prefix: '!' });

    await handler.handle(PAIRED_STEAM_ID, 'anyone got scrap');

    expect(client.sent).toHaveLength(0);
  });
});
