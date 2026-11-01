-- ============================================================
-- Private games: team formats, match play, custom contests and stakes.
--
-- Run after sql/course-data-2026-11.sql. Safe to run twice. Nothing here
-- drops anything; create_private_game_v2 stays for phones on the
-- previous app.
--
-- Formats
--   Individual games keep Stableford / Medal / Skins and can add:
--     betterball  pairs, the better score of the two on each hole
--     matchplay   singles, or pairs v pairs (fourball) when better ball is on
--   One-ball team games (event_scoring.team_format):
--     scramble    teams of 2 to 4, best shot each time
--     foursomes   alternate shot, pairs
--     greensomes  both drive, pick one, then alternate shot
--   The team's card is kept under its first player (the captain), so
--   the usual card, keypad, disputes and boards all work on teams.
--   Match play there is team against team.
--
-- Handicap allowances default to England Golf's recommendations in the
-- app; event_scoring.allowances only holds what the organiser changed.
--
-- Money: every pot is optional and in pounds. event_scoring.stakes holds
-- { main, skins, match, "ld-front": 2, ... } and game_contests.stake the
-- pot for each custom contest. Nothing is paid through the app; it just
-- works out the settle-up.
-- ============================================================

alter table event_scoring add column if not exists team_format text
  check (team_format is null or team_format in ('scramble', 'foursomes', 'greensomes'));
alter table event_scoring add column if not exists team_size smallint not null default 2 check (team_size between 2 and 4);
alter table event_scoring add column if not exists allowances jsonb not null default '{}'::jsonb;
alter table event_scoring add column if not exists stakes jsonb not null default '{}'::jsonb;

-- ---------- teams for the one-ball formats ----------
create table if not exists game_teams (
  event_id uuid not null references events(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  team_number integer not null check (team_number between 1 and 16),
  position smallint not null default 0 check (position between 0 and 3),
  primary key (event_id, player_id)
);
create index if not exists game_teams_event on game_teams(event_id, team_number, position);

-- ---------- match play ----------
-- side1 and side2 are player ids: one each for singles, two for a
-- fourball, and the team captains in a team game.
create table if not exists game_matches (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  number integer not null check (number between 1 and 16),
  side1 uuid[] not null check (cardinality(side1) between 1 and 2),
  side2 uuid[] not null check (cardinality(side2) between 1 and 2),
  unique (event_id, number)
);

-- ---------- custom contests ----------
create table if not exists game_contests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  kind text not null check (kind in ('hole', 'twos', 'birdies', 'putts', 'front9', 'back9')),
  name text not null check (char_length(name) between 1 and 40),
  hole integer check (hole is null or hole between 1 and 18),
  stake numeric(6,2) not null default 0 check (stake between 0 and 100),
  position integer not null default 0,
  check ((kind = 'hole') = (hole is not null))
);
create index if not exists game_contests_event on game_contests(event_id, position);

-- Who's in front on a named hole prize, like writing on the stake.
create table if not exists game_contest_claims (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references game_contests(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  claimed_by uuid references profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists game_contest_claims_contest on game_contest_claims(contest_id, created_at);

-- A claim belongs to a contest on the same round.
create or replace function game_claim_matches_contest()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from game_contests c where c.id = new.contest_id and c.event_id = new.event_id and c.kind = 'hole') then
    raise exception 'That contest isn''t on this round.';
  end if;
  return new;
end $$;
revoke execute on function game_claim_matches_contest() from public, anon, authenticated;
drop trigger if exists game_claim_matches_contest on game_contest_claims;
create trigger game_claim_matches_contest before insert or update on game_contest_claims
  for each row execute function game_claim_matches_contest();

-- ---------- who can see and change them ----------
alter table game_teams enable row level security;
alter table game_matches enable row level security;
alter table game_contests enable row level security;
alter table game_contest_claims enable row level security;

do $$ declare t text; begin
  foreach t in array array['game_teams', 'game_matches', 'game_contests'] loop
    execute format('drop policy if exists "Members read the game" on %I', t);
    execute format('create policy "Members read the game" on %I for select using (is_approved_member() or is_guest_of(event_id))', t);
    execute format('drop policy if exists "Round managers set the game" on %I', t);
    execute format('create policy "Round managers set the game" on %I for all using (can_manage_round(event_id)) with check (can_manage_round(event_id))', t);
  end loop;
end $$;

drop policy if exists "Round sees the stake" on game_contest_claims;
create policy "Round sees the stake" on game_contest_claims for select using (on_round(event_id) or is_guest_of(event_id));
drop policy if exists "Players name who's in front" on game_contest_claims;
create policy "Players name who's in front" on game_contest_claims for insert
  with check (can_score_event(event_id) and in_field(event_id, player_id) and claimed_by = auth.uid());
drop policy if exists "Take back your own, or the organiser" on game_contest_claims;
create policy "Take back your own, or the organiser" on game_contest_claims for delete
  using (claimed_by = auth.uid() or can_manage_round(event_id));

-- A players-only private game stays private from other members.
do $$ declare t text; begin
  foreach t in array array['game_teams', 'game_matches', 'game_contests', 'game_contest_claims'] loop
    execute format('drop policy if exists "Private games stay private" on %I', t);
    execute format('create policy "Private games stay private" on %I as restrictive for select using (not private_hidden(event_id))', t);
  end loop;
end $$;

-- Live updates for the stake on a named hole prize.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'game_contest_claims') then
    alter publication supabase_realtime add table game_contest_claims;
  end if;
end $$;

-- ---------- creating a game ----------
-- p, as for create_private_game_v2, plus:
--   formats      may also hold 'betterball' and 'matchplay'
--   team_format  'scramble' | 'foursomes' | 'greensomes' (or null)
--   team_size    2 to 4 (scramble only; the others are pairs)
--   allowances   { key: percent or [percents] } the organiser changed
--   stakes       { main, skins, match, "ld-front", ... } in pounds
--   custom       [{ kind, name, hole, stake }]
-- Teams, pairs and matches are made in the order the players are given:
-- teams of team_size, then side 1 v side 2, 3 v 4 and so on.
create or replace function create_private_game_v3(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  ev uuid;
  tf text := case when p ->> 'team_format' in ('scramble', 'foursomes', 'greensomes') then p ->> 'team_format' end;
  ts integer := case when tf = 'scramble' then least(4, greatest(2, coalesce((p ->> 'team_size')::int, 2))) else 2 end;
  fmts text[] := array(select x from jsonb_array_elements_text(coalesce(p -> 'formats', '["stableford"]'::jsonb)) x
                        where x in ('stableford', 'medal', 'skins', 'betterball', 'matchplay'));
  field uuid[];
  c jsonb;
  i integer;
  k integer := 0;
  pair_on boolean;
begin
  if tf is not null then
    -- One ball per team: no individual extras.
    fmts := array(select x from unnest(fmts) x where x in ('stableford', 'medal', 'matchplay'));
  end if;
  if not exists (select 1 from unnest(fmts) x where x in ('stableford', 'medal')) then fmts := array['stableford'] || fmts; end if;
  pair_on := tf is null and ('betterball' = any(fmts) or coalesce((p ->> 'pairs')::boolean, false));

  -- The basics (field, groups, tee, handicaps, NTP/LD) as before.
  ev := create_private_game_v2(p || jsonb_build_object('formats', to_jsonb(fmts), 'pairs', pair_on));

  update event_scoring set
    formats = fmts,
    team_format = tf,
    team_size = ts,
    allowances = case when jsonb_typeof(p -> 'allowances') = 'object' then p -> 'allowances' else '{}'::jsonb end,
    stakes = case when jsonb_typeof(p -> 'stakes') = 'object' then p -> 'stakes' else '{}'::jsonb end
  where event_id = ev;

  -- The field in the order v2 put it in the tee groups.
  field := array(select g.player_id from groupings g where g.event_id = ev and g.group_type = 'fours' order by g.group_number, g.position);

  if tf in ('foursomes', 'greensomes') and cardinality(field) % 2 = 1 then
    raise exception 'Foursomes and greensomes need an even number of players.';
  end if;
  if tf is not null then
    for i in 1 .. cardinality(field) loop
      insert into game_teams (event_id, player_id, team_number, position) values (ev, field[i], (i - 1) / ts + 1, (i - 1) % ts);
    end loop;
  end if;

  if 'matchplay' = any(fmts) then
    -- The sides in order: team 1 v team 2, pair 1 v pair 2, or player 1 v
    -- player 2, and so on. Anyone left over sits out; the organiser can
    -- change the matches in Manage.
    if tf is not null then
      for i in 1 .. ((cardinality(field) + ts - 1) / ts) / 2 loop
        insert into game_matches (event_id, number, side1, side2)
        values (ev, i, array[field[(2 * i - 2) * ts + 1]], array[field[(2 * i - 1) * ts + 1]]);
      end loop;
    elsif pair_on then
      for i in 1 .. (cardinality(field) / 2) / 2 loop
        insert into game_matches (event_id, number, side1, side2)
        values (ev, i, array[field[4 * i - 3], field[4 * i - 2]], array[field[4 * i - 1], field[4 * i]]);
      end loop;
    else
      for i in 1 .. cardinality(field) / 2 loop
        insert into game_matches (event_id, number, side1, side2) values (ev, i, array[field[2 * i - 1]], array[field[2 * i]]);
      end loop;
    end if;
  end if;

  for c in select * from jsonb_array_elements(coalesce(p -> 'custom', '[]'::jsonb)) loop
    if c ->> 'kind' not in ('hole', 'twos', 'birdies', 'putts', 'front9', 'back9') then continue; end if;
    k := k + 1;
    if k > 12 then raise exception 'Up to 12 contests.'; end if;
    insert into game_contests (event_id, kind, name, hole, stake, position)
    values (ev, c ->> 'kind', left(coalesce(nullif(trim(c ->> 'name'), ''), 'Contest'), 40),
            case when c ->> 'kind' = 'hole' then (c ->> 'hole')::int end,
            least(100, greatest(0, coalesce((c ->> 'stake')::numeric, 0))), k);
  end loop;
  return ev;
end $$;
revoke execute on function create_private_game_v3(jsonb) from public, anon;
grant execute on function create_private_game_v3(jsonb) to authenticated;
