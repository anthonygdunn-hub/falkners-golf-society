-- ============================================================
-- The Falkners Arms Golf Society — database schema
--
-- HOW TO USE:
-- 1. Create a free project at https://supabase.com
-- 2. Open the "SQL Editor" tab in your project
-- 3. Paste this entire file in and click "Run"
-- 4. That's it — your tables, security rules, and starting data
--    structure are all set up.
-- ============================================================

-- Everyone (public website visitors) can be a player.
create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  handicap numeric,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- A round / fixture (past or upcoming).
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  name text not null,              -- e.g. "Round 3"
  venue text,
  address text,
  event_date date not null,
  format text default 'mixed',     -- 'stableford' | 'strokeplay' | 'mixed' etc, just a label
  order_of_merit boolean not null default true,
  notes text,
  results_entered boolean not null default false,
  created_at timestamptz not null default now()
);

-- One player's result for one event.
create table if not exists results (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  gross_score numeric,
  handicap numeric,                -- handicap snapshot at the time of the round
  points numeric not null,         -- the number that counts toward the season leaderboard
  notes text,
  created_at timestamptz not null default now(),
  unique (event_id, player_id)
);

-- ------------------------------------------------------------------
-- Row Level Security: anyone can READ (so the public site can show
-- leaderboards/results), but only SIGNED-IN committee members can
-- add, edit, or delete anything.
-- ------------------------------------------------------------------

alter table players enable row level security;
alter table events enable row level security;
alter table results enable row level security;

create policy "Public can read players" on players for select using (true);
create policy "Public can read events" on events for select using (true);
create policy "Public can read results" on results for select using (true);

create policy "Signed-in users can manage players" on players
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "Signed-in users can manage events" on events
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "Signed-in users can manage results" on results
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ------------------------------------------------------------------
-- Starter data — the current committee & 2026 fixture list, carried
-- over from the old site. Feel free to edit names/handicaps/dates
-- straight in the Supabase Table Editor at any time.
-- ------------------------------------------------------------------

insert into players (name, handicap) values
  ('Jon Chapman', null),
  ('Anthony Dunn', null),
  ('Robin Harden', null)
on conflict do nothing;

insert into events (name, venue, address, event_date, notes) values
  ('Round 1', 'Hurtmore Golf Club', 'Hurtmore Rd, Godalming GU7 2RN', '2026-03-01', null),
  ('Round 2', 'Clandon Golf Club', 'Epsom Rd, Guildford, Surrey GU4 7AA', '2026-03-29', null),
  ('Round 3', 'Sherfield Oaks', 'Wildmoor Ln, Sherfield on Loddon, Basingstoke RG27 0HB', '2026-04-26', null),
  ('Round 4', 'Tylney Park Golf Club', 'The St, Rotherwick, Hook RG27 9AY', '2026-06-28', null),
  ('Round 5', 'Downshire Golf Complex', 'Easthampstead Park, Bracknell, Wokingham RG40 3DH', '2026-07-26', null),
  ('Round 6', 'Venue TBC', null, '2026-08-30', null),
  ('Round 7', 'Silvermere Golf Course', 'Redhill Rd, Cobham KT11 1EF', '2026-09-27', null),
  ('Round 8', 'Clandon Golf Club', 'Epsom Rd, Guildford, Surrey GU4 7AA', '2026-10-25', null),
  ('Round 9', 'Hurtmore Golf Club', 'Hurtmore Rd, Godalming GU7 2RN', '2026-11-29', null)
on conflict do nothing;
