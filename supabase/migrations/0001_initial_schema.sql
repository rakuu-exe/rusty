-- Rust Event Bot -- initial schema
--
-- Everything here is written and read exclusively by the always-on worker
-- using the service-role key. RLS is enabled with no permissive policies,
-- so anon/authenticated clients can read nothing. The service role bypasses
-- RLS by design; that is the only intended access path.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Rust+ paired servers
-- ---------------------------------------------------------------------------
create table if not exists public.rust_servers (
  id            uuid primary key default gen_random_uuid(),
  guild_id      text        not null,
  name          text        not null,
  description   text,
  server_ip     text        not null,
  app_port      integer     not null,
  -- Steam ID64 of the paired player.
  player_id     text        not null,
  -- Encrypted at rest by the worker (AES-256-GCM). Never store plaintext:
  -- this token grants control of the paired account's smart devices.
  player_token  text        not null,
  map_size      integer,
  seed          bigint,
  salt          bigint,
  wipe_time     timestamptz,
  is_active     boolean     not null default true,
  connected_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One row per (server, paired player). Re-pairing updates in place.
  unique (server_ip, app_port, player_id)
);

create index if not exists rust_servers_guild_active_idx
  on public.rust_servers (guild_id) where is_active;

-- ---------------------------------------------------------------------------
-- Per-guild Discord configuration
-- ---------------------------------------------------------------------------
create table if not exists public.discord_config (
  guild_id             text primary key,
  event_channel_id     text,
  team_chat_channel_id text,
  timezone             text    not null default 'UTC',
  command_prefix       text    not null default '!',
  use_embeds           boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Monument cache (from getMap(), which costs 5 rate-limit tokens)
--
-- Refreshed once per connection/wipe rather than per poll. Oil rig positions
-- drive the CH47 proximity test that distinguishes "crate called at rig"
-- from "chinook crossing the map".
-- ---------------------------------------------------------------------------
create table if not exists public.monuments (
  server_id  uuid   not null references public.rust_servers(id) on delete cascade,
  token      text   not null,
  x          double precision not null,
  y          double precision not null,
  created_at timestamptz not null default now(),

  primary key (server_id, token, x, y)
);

create index if not exists monuments_server_token_idx
  on public.monuments (server_id, token);

-- ---------------------------------------------------------------------------
-- Event history -- powers "!heli" / "time since last cargo" queries
-- ---------------------------------------------------------------------------
create table if not exists public.event_log (
  id         uuid primary key default gen_random_uuid(),
  server_id  uuid not null references public.rust_servers(id) on delete cascade,
  -- e.g. patrol_helicopter, cargo_ship, ch47, oil_rig_crate, locked_crate
  event_type text not null,
  -- e.g. entered_map, left_map, downed, called, unlocked, egress
  phase      text not null,
  -- Grid label at the time of the event, e.g. "W4" or "outside grid, SE".
  grid       text,
  world_x    double precision,
  world_y    double precision,
  -- For oil rig crates: when the 15 minute unlock completes.
  opens_at   timestamptz,
  -- Rust+ marker id, so repeat polls of the same marker are idempotent.
  marker_id  text,
  raw        jsonb,
  created_at timestamptz not null default now()
);

create index if not exists event_log_lookup_idx
  on public.event_log (server_id, event_type, created_at desc);

-- A given marker only produces a given phase once, even if the worker
-- restarts mid-poll and re-observes the same marker set.
create unique index if not exists event_log_marker_phase_idx
  on public.event_log (server_id, marker_id, event_type, phase)
  where marker_id is not null;

-- ---------------------------------------------------------------------------
-- Pending timers -- persisted so a redeploy mid-crate still fires "OPENS"
-- ---------------------------------------------------------------------------
create table if not exists public.active_timers (
  id         uuid primary key default gen_random_uuid(),
  server_id  uuid not null references public.rust_servers(id) on delete cascade,
  -- oil_rig_crate_unlock | cargo_ship_egress
  kind       text        not null,
  expires_at timestamptz not null,
  payload    jsonb       not null default '{}'::jsonb,
  fired_at   timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists active_timers_pending_idx
  on public.active_timers (server_id, expires_at) where fired_at is null;

-- Only one live timer of a kind per marker, so a restart cannot double-arm.
create unique index if not exists active_timers_unique_pending_idx
  on public.active_timers (server_id, kind, (payload->>'markerId'))
  where fired_at is null;

-- ---------------------------------------------------------------------------
-- Rust+ / FCM credentials
--
-- Keyed by guild, not by Steam ID: the credentials are submitted before any
-- pairing has happened, and the Steam ID only becomes known when the first
-- pairing push arrives. It is backfilled at that point.
--
-- The Steam auth token behind FCM registration expires after 2 weeks;
-- expires_at drives the Discord re-pair nag.
-- ---------------------------------------------------------------------------
create table if not exists public.pairing_credentials (
  guild_id         text primary key,
  steam_id         text,
  -- Encrypted at rest by the worker (AES-256-GCM).
  fcm_credentials  text not null,
  expo_push_token  text,
  issued_at        timestamptz not null default now(),
  expires_at       timestamptz,
  last_warned_at   timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['rust_servers', 'discord_config', 'pairing_credentials']
  loop
    execute format(
      'drop trigger if exists %I on public.%I', t || '_touch_updated_at', t
    );
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function public.touch_updated_at()',
      t || '_touch_updated_at', t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock everything down.
--
-- RLS on with zero policies == deny-all for anon and authenticated roles.
-- The worker's service-role key bypasses RLS and is the only way in.
-- ---------------------------------------------------------------------------
alter table public.rust_servers        enable row level security;
alter table public.discord_config      enable row level security;
alter table public.monuments           enable row level security;
alter table public.event_log           enable row level security;
alter table public.active_timers       enable row level security;
alter table public.pairing_credentials enable row level security;

revoke all on public.rust_servers        from anon, authenticated;
revoke all on public.discord_config      from anon, authenticated;
revoke all on public.monuments           from anon, authenticated;
revoke all on public.event_log           from anon, authenticated;
revoke all on public.active_timers       from anon, authenticated;
revoke all on public.pairing_credentials from anon, authenticated;
