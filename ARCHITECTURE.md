# Where things live

A map for making changes without hunting. The README covers setup and what the
bot does; this covers where to type when you want it to do something else.

## The one-line version

A poller asks Rust+ for map markers every 5s → a detector turns snapshot
differences into events → a runtime announces them and writes them down.

```
index.ts          starts everything
  app.ts          one App per Discord guild; owns pairing and server lifecycle
    serverRuntime.ts   one per Rust server: wires client + poller + detector + chat
      rustplus/client.ts   the socket: reconnects, rate limits, times out
      events/poller.ts     getMapMarkers on a loop
      events/detector.ts   snapshots in, events out. Pure and synchronous.
      ingame/chat.ts       in-game commands
      discord/bot.ts       Discord output
```

## Where to add what

| I want to… | Edit | Notes |
|---|---|---|
| Add an **in-game command** (`!foo`) | `ingame/chat.ts` → `COMMANDS` | One table entry. `!help` updates itself. |
| Add a **vending command** | `vending/commands.ts` → switch **and** `VENDING_COMMAND_USAGE` | Both are in that file, next to each other. |
| Add a **slash command** | `discord/commands.ts`, then run `npm run register-commands` | Discord caches definitions; unregistered commands never appear. |
| Detect a **new event** | `events/detector.ts` → `onAppeared` / `onDisappeared` | Add the type to `events/types.ts` first. |
| Change **how an event reads** | `format/message.ts` | Discord and in-game wording both live here. |
| Change **event state / status replies** | `events/state.ts` → `describeState` | What `!heli` and friends print. |
| Add a **timed follow-up** (e.g. crate unlock) | `events/timers.ts` | Timers persist in the database and survive restarts. |
| Change **tuning numbers** | `events/detector.ts` top, `events/constants.ts` | Radii, speeds, thresholds — all exported and all tested. |
| Add a **database table or query** | `db.ts` | Every query lives here. Nothing else imports Supabase. |
| Change **grid or region naming** | `rustplus/grid.ts` | Grid cells for the mainland, regions for anything off-grid. |
| Refresh **item names** | `npm run fetch-items` | After a game update. Vending shows raw ids for unknown items. |
| Add an **item alias** (`ak` → Assault Rifle) | `vending/aliases.ts` | Values are **short names**, not display names — display names move. |

## Rules the code follows

Break these and the tests will tell you, but the reasoning is not obvious from
the code alone.

**Commands never write state.** `!heli` reports; it does not start timers or
record anything. All state changes come from observed markers, so the bot can
never be talked into believing something that did not happen.

**The detector is pure and synchronous.** No network, no database, no clock of
its own — `update(markers, now)` in, events out. That is what makes recorded
feeds replayable, and it is why every detection rule is testable without a live
server.

**Startup synchronises without announcing.** Whatever is on the map when the
bot connects is recorded as active with *no* start time. It did not see those
spawn and must not imply it did. The visible cost: a restart swallows anything
already in flight.

**Three things are inferred, not reported.** The API does not say them, so each
is a documented guess in `detector.ts`: whether a helicopter was shot down or
flew away (by *where* it vanished), whether a Chinook delivered to an oil rig
(by proximity), and whether it dropped a crate (by hovering on the mainland
beside a monument).

**Some things are genuinely invisible.** Crate and explosion markers were
removed from the companion API in 2023, and the Deep Sea zone has never had a
marker. Code handling those marker types is kept and tested in case they
return, but it does not run today — see "What the Rust+ API can and cannot see"
in the README.

## Testing

`npm test` — 228 tests, no network, no database.

Detection tests drive synthetic marker snapshots through the detector.
Recorded real feeds live in `test/fixtures/*.live.jsonl`; `scripts/`
has tools for recording new ones and for printing Chinook speed profiles when
tuning the hover thresholds.
