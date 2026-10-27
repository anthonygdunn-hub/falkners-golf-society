-- ============================================================
-- Ryder Cup weekend: two teams, match play, live scoring.
--
-- Run after sql/round-admins.sql. Safe to run twice.
--
--   rc_cups      one per trip fixture: team names and colours
--   rc_players   who's on which team
--   rc_sessions  e.g. "Friday fourballs" - a format, a tee, a status
--   rc_matches   the pairings in a session (side 1 v side 2)
--   rc_scores    gross strokes per player per hole. Foursomes are one
--                ball, scored under the side's first player.
--
-- The committee (and anyone made admin for the fixture) sets it all up.
-- Players in a match score it while its session is live.
-- ============================================================

create table if not exists rc_cups (
  event_id uuid primary key references events(id) on delete cascade,
  team1_name text not null default 'Team 1',
  team2_name text not null default 'Team 2',
  team1_colour text not null default '#1B3A6C',
  team2_colour text not null default '#B3261E',
  allowance integer not null default 75 check (allowance between 0 and 100),
  updated_at timestamptz not null default now()
);

create table if not exists rc_players (
  event_id uuid not null references rc_cups(event_id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  side smallint not null check (side in (1, 2)),
  primary key (event_id, player_id)
);

create table if not exists rc_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references rc_cups(event_id) on delete cascade,
  name text not null,
  format text not null check (format in ('fourball', 'foursome', 'single')),
  tee_id uuid references course_tees(id) on delete set null,
  play_date date,
  position integer not null default 0,
  status text not null default 'setup' check (status in ('setup', 'live', 'final')),
  created_at timestamptz not null default now()
);

create table if not exists rc_matches (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references rc_sessions(id) on delete cascade,
  event_id uuid not null references rc_cups(event_id) on delete cascade,
  match_no integer not null default 1,
  side1 uuid[] not null default '{}',
  side2 uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists rc_matches_session on rc_matches(session_id, match_no);

create table if not exists rc_scores (
  match_id uuid not null references rc_matches(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  hole integer not null check (hole between 1 and 18),
  strokes integer check (strokes between 1 and 20),
  picked_up boolean not null default false,
  entered_by uuid references profiles(id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (match_id, player_id, hole)
);

-- May the signed-in user score this match? Round managers always; a
-- player in the match while its session is live.
create or replace function rc_can_score(p_match uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from rc_matches m join rc_sessions s on s.id = m.session_id
     where m.id = p_match
       and (can_manage_round(m.event_id)
            or (s.status = 'live' and exists (
                  select 1 from players pl where pl.profile_id = auth.uid()
                     and pl.id = any (m.side1 || m.side2)))));
$$;
revoke execute on function rc_can_score(uuid) from public, anon;
grant execute on function rc_can_score(uuid) to authenticated;

alter table rc_cups enable row level security;
alter table rc_players enable row level security;
alter table rc_sessions enable row level security;
alter table rc_matches enable row level security;
alter table rc_scores enable row level security;

do $$
declare t text;
begin
  foreach t in array array['rc_cups', 'rc_players', 'rc_sessions', 'rc_matches'] loop
    execute format('drop policy if exists "Members read" on %I', t);
    execute format('create policy "Members read" on %I for select using (is_approved_member())', t);
    execute format('drop policy if exists "Managers set up" on %I', t);
    execute format('create policy "Managers set up" on %I for all using (can_manage_round(event_id)) with check (can_manage_round(event_id))', t);
  end loop;
end $$;

drop policy if exists "Members read" on rc_scores;
create policy "Members read" on rc_scores for select using (is_approved_member());
drop policy if exists "Players score" on rc_scores;
create policy "Players score" on rc_scores for insert with check (rc_can_score(match_id) and entered_by = auth.uid());
drop policy if exists "Players change scores" on rc_scores;
create policy "Players change scores" on rc_scores for update using (rc_can_score(match_id)) with check (rc_can_score(match_id) and entered_by = auth.uid());
drop policy if exists "Players clear scores" on rc_scores;
create policy "Players clear scores" on rc_scores for delete using (rc_can_score(match_id));

do $$
declare t text;
begin
  foreach t in array array['rc_cups', 'rc_players', 'rc_sessions', 'rc_matches', 'rc_scores'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;
