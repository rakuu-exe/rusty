# Rust Event Bot

A private Discord bot for Rust servers: live event alerts with grid coordinates, in the style of RUST ON TOP / RustPlusBot.

```
LARGE OIL RIG CRATE CALLED 14:41 OPENS 14:56 @ W4
PATROL HELICOPTER ENTERED MAP 09:12 @ D18
CARGO SHIP ENTERED MAP 21:03 @ outside grid, SE
```

## What v1 does

- **Event alerts** — Patrol Helicopter (entered / downed / left), Cargo Ship (entered / egress / left), Chinook 47, Small and Large Oil Rig crate calls with the 15-minute unlock timer, and locked crate drops. All with grid coordinates.
- **Rust+ pairing** — `/connect` walks you through linking a server via Steam + FCM.
- **In-game commands** — `!heli`, `!cargo`, `!large`, `!small`, `!chinook`, `!crate`, `!time`, `!pop`, `!wipe`, `!status` in Rust team chat.

Craft / recycle / raid cost lookups are Phase 5 and not built yet.

## Architecture

```
worker/     always-on Node process: Discord gateway + Rust+ WebSocket
supabase/   Postgres schema (migrations)
data/       static Rust item data (Phase 5, empty for now)
```

**Why a separate worker instead of running on Supabase:** Supabase Edge Functions cap at 150s (Free) / 400s (Pro) wall clock and kill WebSockets at that cap. Both the Discord gateway and the Rust+ socket must stay open indefinitely. Supabase is the database; the worker holds the sockets. It needs ~256MB and runs fine on a Fly.io shared-cpu-1x, any cheap VPS, or a Raspberry Pi.

## Setup

### 1. Node 20+

Any Node 20 or newer. If you cannot install system-wide, a portable build works:

```powershell
# Downloads to dev\.node and needs no admin rights
Invoke-WebRequest https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip -OutFile "$env:TEMP\node.zip"
Expand-Archive "$env:TEMP\node.zip" -DestinationPath C:\Users\Tytma\dev\.node
$env:Path = "C:\Users\Tytma\dev\.node\node-v22.14.0-win-x64;$env:Path"
```

```bash
cd worker
npm install
```

### 2. Supabase

Create a project, then apply the schema — either paste `supabase/migrations/0001_initial_schema.sql` into the SQL editor, or:

```bash
supabase link --project-ref <ref>
supabase db push
```

Every table has RLS enabled with no permissive policies. The worker's **service-role** key is the only way in; it bypasses RLS by design. Never ship that key anywhere else.

### 3. Discord application

1. Create an app at <https://discord.com/developers/applications>, add a bot.
2. No privileged intents are needed — the bot never reads Discord message content.
3. Invite it with the `bot` and `applications.commands` scopes, and permission to send messages and embed links in your target channels.

### 4. Configure

```bash
cd worker
cp .env.example .env
```

Generate the encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

This key encrypts `player_token` and your FCM credentials at rest. Those together grant control of the paired account's Rust+ session, including smart switches and alarms — treat the key as a secret and back it up, since losing it means re-pairing.

### 5. Register commands and start

```bash
npm run register-commands
npm start
```

Commands are registered guild-scoped, so they appear instantly rather than taking up to an hour like global ones.

## Linking a server

Linking **cannot** start in game. The Rust+ API only exposes the team chat of a player it is *already* paired with, so the bot is deaf until pairing has already happened. The order is:

1. `/setup events:#your-channel` in Discord.
2. On the machine running the bot: `npm run fcm-register`. Chrome opens; log in with Steam. This writes `rustplus.config.json`.

   **No Chrome?** The tool uses `chrome-launcher`, which honours `CHROME_PATH`, and Edge is Chromium — so point it at Edge instead:

   ```powershell
   $env:CHROME_PATH = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
   npm run fcm-register
   ```

   Note that `fcm-register` launches the browser with `--disable-web-security`, which it needs in order to inject a handler that captures the Rust+ auth token. It does this in a **throwaway profile** (`--user-data-dir`), so your normal browser profile, cookies and saved logins are not exposed. Close the window when it finishes.
3. `/connect` in Discord → **Submit credentials** → paste that whole file.
4. In Rust: `Esc` → **Rust+** → **Pair with Server**.

The pairing push arrives within seconds and the bot connects itself. In-game commands work from then on.

⚠️ The Steam token behind step 2 **expires after 14 days**. When it lapses, pairing pushes silently stop arriving — the bot warns you in Discord two days ahead. Re-run steps 2–3 to refresh.

## Deploying to Railway

The repo ships a `Dockerfile` at the root (so Railway needs no Root Directory override) and a `railway.json`.

### Option A — via GitHub (auto-deploys on push)

1. Create a **private** repo on GitHub and push:

   ```bash
   git remote add origin https://github.com/<you>/rust-event-bot.git
   git push -u origin main
   ```

2. Railway → **New Project** → **Deploy from GitHub repo** → pick it.
3. **Variables** tab → add the eight values from your local `worker/.env`.
4. Deploy.

### Option B — via CLI (no GitHub)

```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

Then set the variables in the dashboard.

### Variables Railway needs

| Variable | Notes |
|---|---|
| `DISCORD_TOKEN` | |
| `DISCORD_CLIENT_ID` | |
| `DISCORD_GUILD_ID` | |
| `SUPABASE_URL` | base URL, no `/rest/v1/` |
| `SUPABASE_SERVICE_ROLE_KEY` | |
| `CREDENTIALS_ENCRYPTION_KEY` | **must be the same key** — it decrypts credentials already in Supabase |
| `TIMEZONE` | e.g. `Europe/Tallinn` |
| `POLL_INTERVAL_MS` | `5000` |

`NODE_ENV=production` is set by the Dockerfile, which also switches logging to plain JSON.

### Things that will bite you

- **Run only one instance.** Two workers sharing a `playerId` compete for the same 25-token Rust+ bucket and post every alert twice. `numReplicas` is pinned to `1` in `railway.json` — leave it there, and **stop the local worker** once Railway is live.
- **No port, no domain.** This is a background worker, not a web service. It never listens on HTTP. Don't let Railway attach a domain or a healthcheck expecting one.
- **Pairing still happens locally.** `fcm-register` needs a browser, so run it on your PC and submit via `/connect`. The credentials land in Supabase, and Railway picks them up on its next connect — no redeploy needed.
- **Re-pairing after the 14-day token expiry** is the same story: local `fcm-register`, then `/connect`.

## Development

```bash
npm run dev         # watch mode
npm test            # 80 tests
npm run typecheck
```

The event logic is deliberately pure and synchronous — `EventDetector.update()` takes marker snapshots and returns events, with no network, database or timers involved. That means the whole of v1's detection can be tested by replaying snapshots rather than waiting for a helicopter to spawn. See `test/detector.test.ts`.

To capture real snapshots for a fixture, log the output of `client.getMapMarkers()` while connected. Note that marker payloads contain player positions and Steam IDs, so `test/fixtures/*.live.json` is gitignored.

## Notes and caveats

- **Rust+ is unofficial.** Facepunch can change or restrict the companion API without notice. There is no stability guarantee.
- **Rate limits** are token-bucket: 50/IP (+15/s) and 25 per playerId (+3/s). `getMapMarkers` costs 1 token, `getMap` costs 5, `sendTeamMessage` costs 2. The default 5s poll uses 0.2 tokens/sec against a 3/sec refill. `getMap` is only called on a fresh wipe, not per reconnect.
- **Heli "downed" is a heuristic.** The API does not say whether a vanished helicopter was destroyed or flew off the map; an Explosion marker within 350 units of its last position is the only available evidence. A rocket landing nearby at the wrong moment can fool it. Tune `HELI_DOWNED_RADIUS` in `src/events/detector.ts`.
- **Oil rig detection is proximity-based.** A Chinook flying to a rig *is* the "heavy scientists called" signal — there is no explicit flag. Stale monument coordinates would break this, which is why the cache is refreshed on wipe.
- **Global chat is invisible.** In-game commands only work in the paired player's team chat. This is a Facepunch limitation.
- **RustLabs no longer exists** — `rustlabs.com` now redirects to `wiki.rustclash.com`, which blocks automated requests. Phase 5 will use a bundled static dataset instead of scraping.
- **`rustplusplus` is GPLv3.** It was used as a behavioural reference only; no code or data files were copied. Keep it that way unless you intend to ship GPLv3.
