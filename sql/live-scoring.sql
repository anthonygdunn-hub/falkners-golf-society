-- ============================================================
-- Live scoring for the society app (/app).
--
-- Adds courses (tees and holes), a scoring setup per round, playing
-- handicaps per round, and hole-by-hole scores. Nothing existing is
-- changed. Safe to run twice.
-- ============================================================

-- ---------- Helpers ----------

create or replace function is_approved_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m
    where m.profile_id = auth.uid() and m.status = 'approved'
  );
$$;

-- The player row for a signed-in member, if one is linked.
create or replace function my_player_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from players where profile_id = auth.uid() order by created_at limit 1;
$$;

-- ---------- Courses ----------

create table if not exists courses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists course_tees (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses(id) on delete cascade,
  name text not null,                       -- e.g. "White", "Yellow"
  colour text,                              -- css colour for the badge
  course_rating numeric check (course_rating is null or course_rating between 50 and 90),
  slope integer check (slope is null or slope between 55 and 155),
  created_at timestamptz not null default now()
);

create table if not exists course_holes (
  tee_id uuid not null references course_tees(id) on delete cascade,
  hole integer not null check (hole between 1 and 18),
  par integer not null check (par between 3 and 6),
  stroke_index integer not null check (stroke_index between 1 and 18),
  yards integer check (yards is null or yards between 50 and 750),
  primary key (tee_id, hole)
);

-- ---------- Per-round scoring setup ----------

create table if not exists event_scoring (
  event_id uuid primary key references events(id) on delete cascade,
  tee_id uuid references course_tees(id) on delete set null,
  handicap_method text not null default 'whs'
    check (handicap_method in ('whs', 'profile', 'manual')),
  allowance numeric not null default 75 check (allowance between 0 and 100),
  formats text[] not null default array['stableford', 'medal', 'skins'],
  skins_mode text not null default 'net' check (skins_mode in ('net', 'gross')),
  status text not null default 'setup' check (status in ('setup', 'live', 'final')),
  updated_at timestamptz not null default now()
);

-- Handicap snapshot for each player on a round. playing_handicap is a
-- committee override; when it's null the app works it out from the
-- index and the round's method.
create table if not exists event_handicaps (
  event_id uuid not null references events(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  handicap_index numeric check (handicap_index is null or handicap_index between -10 and 54),
  playing_handicap integer check (playing_handicap is null or playing_handicap between -10 and 60),
  primary key (event_id, player_id)
);

-- ---------- Hole-by-hole scores ----------

create table if not exists hole_scores (
  event_id uuid not null references events(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  hole integer not null check (hole between 1 and 18),
  strokes integer check (strokes is null or strokes between 1 and 20),
  picked_up boolean not null default false,
  entered_by uuid default auth.uid() references profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (event_id, player_id, hole),
  check (strokes is not null or picked_up)
);

create index if not exists hole_scores_event_idx on hole_scores (event_id);

-- ---------- The field for a round ----------
-- Everyone playing, as player rows, with their handicap and draw.
-- Members show up in attendance either by player or by profile, so
-- both are resolved to the player row here. pair_groups is every pair
-- number the player holds: two on an odd turnout (see
-- sql/pairs-double-up.sql), and their score counts for both.

drop function if exists scoring_field(uuid);
create function scoring_field(target uuid)
returns table (
  player_id uuid,
  profile_id uuid,
  name text,
  handicap numeric,
  is_guest boolean,
  tee_group integer,
  pair_groups integer[]
)
language sql stable security definer set search_path = public as $$
  with att as (
    select a.id, a.guest_of,
           coalesce(a.player_id,
                    (select p.id from players p where p.profile_id = a.profile_id order by p.created_at limit 1)) as pid,
           a.profile_id as att_profile
      from attendance a
     where a.event_id = target and a.status = 'playing'
  )
  select att.pid,
         coalesce(pl.profile_id, att.att_profile),
         coalesce(pl.name, pr.display_name, 'Unknown'),
         -- The committee's figure (admin page → Players) comes first.
         coalesce(pl.handicap, pr.handicap),
         att.guest_of is not null,
         (select g.group_number from groupings g
           where g.event_id = target and g.group_type = 'fours'
             and (g.player_id = att.pid or (g.profile_id is not null and g.profile_id = coalesce(pl.profile_id, att.att_profile)))
           order by g.group_number limit 1),
         coalesce((select array_agg(distinct g.group_number order by g.group_number) from groupings g
           where g.event_id = target and g.group_type = 'pairs'
             and (g.player_id = att.pid or (g.profile_id is not null and g.profile_id = coalesce(pl.profile_id, att.att_profile)))),
           '{}'::integer[])
    from att
    left join players pl on pl.id = att.pid
    left join profiles pr on pr.id = coalesce(pl.profile_id, att.att_profile)
   where is_approved_member();
$$;

-- Committee: give a member on the round a player row so they can be scored.
create or replace function link_member_player(p_profile uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  pid uuid;
begin
  if not is_committee() then
    raise exception 'Only the committee can do that.';
  end if;
  select id into pid from players where profile_id = p_profile order by created_at limit 1;
  if pid is null then
    insert into players (name, handicap, profile_id)
    select display_name, handicap, id from profiles where id = p_profile
    returning id into pid;
  end if;
  return pid;
end;
$$;

-- Can the signed-in user enter scores on this round? The committee
-- always can; otherwise anyone playing in it while it's live.
create or replace function can_score_event(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select can_manage_round(target)
      or (
        exists (select 1 from event_scoring s where s.event_id = target and s.status = 'live')
        and exists (
          select 1 from attendance a
           where a.event_id = target and a.status = 'playing'
             and (a.profile_id = auth.uid()
                  or a.player_id in (select id from players where profile_id = auth.uid()))
        )
      );
$$;

create or replace function in_field(target uuid, pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from attendance a
     where a.event_id = target and a.status = 'playing'
       and (a.player_id = pid
            or a.profile_id in (select profile_id from players where id = pid and profile_id is not null))
  );
$$;

-- ---------- Row Level Security ----------

alter table courses enable row level security;
alter table course_tees enable row level security;
alter table course_holes enable row level security;
alter table event_scoring enable row level security;
alter table event_handicaps enable row level security;
alter table hole_scores enable row level security;

drop policy if exists "Anyone can read courses" on courses;
create policy "Anyone can read courses" on courses for select using (true);
drop policy if exists "Committee manages courses" on courses;
create policy "Committee manages courses" on courses for all using (is_committee()) with check (is_committee());

drop policy if exists "Anyone can read tees" on course_tees;
create policy "Anyone can read tees" on course_tees for select using (true);
drop policy if exists "Committee manages tees" on course_tees;
create policy "Committee manages tees" on course_tees for all using (is_committee()) with check (is_committee());

drop policy if exists "Anyone can read holes" on course_holes;
create policy "Anyone can read holes" on course_holes for select using (true);
drop policy if exists "Committee manages holes" on course_holes;
create policy "Committee manages holes" on course_holes for all using (is_committee()) with check (is_committee());

drop policy if exists "Members read scoring setup" on event_scoring;
create policy "Members read scoring setup" on event_scoring for select using (is_approved_member());
drop policy if exists "Round managers set up scoring" on event_scoring;
create policy "Round managers set up scoring" on event_scoring for all
  using (can_manage_round(event_id)) with check (can_manage_round(event_id));

drop policy if exists "Members read round handicaps" on event_handicaps;
create policy "Members read round handicaps" on event_handicaps for select using (is_approved_member());
-- Only the committee changes handicaps. Whoever starts the round may
-- snapshot the field, but only as the committee's figures, untouched.
drop policy if exists "Round managers set handicaps" on event_handicaps;
drop policy if exists "Committee sets handicaps" on event_handicaps;
create policy "Committee sets handicaps" on event_handicaps for all
  using (is_committee()) with check (is_committee());
drop policy if exists "Round managers snapshot handicaps" on event_handicaps;
create policy "Round managers snapshot handicaps" on event_handicaps for insert
  with check (
    can_manage_round(event_id)
    and playing_handicap is null
    and handicap_index is not distinct from (select handicap from players where id = player_id)
  );

drop policy if exists "Members read scores" on hole_scores;
create policy "Members read scores" on hole_scores for select using (is_approved_member());
drop policy if exists "Players enter scores" on hole_scores;
create policy "Players enter scores" on hole_scores for insert
  with check (can_score_event(event_id) and in_field(event_id, player_id));
drop policy if exists "Players correct scores" on hole_scores;
create policy "Players correct scores" on hole_scores for update
  using (can_score_event(event_id)) with check (can_score_event(event_id) and in_field(event_id, player_id));
drop policy if exists "Players clear scores" on hole_scores;
create policy "Players clear scores" on hole_scores for delete using (can_score_event(event_id));

-- Stamp who changed a score and when, whatever the client sends.
create or replace function hole_scores_stamp()
returns trigger language plpgsql set search_path = public as $$
begin
  new.entered_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists hole_scores_stamp on hole_scores;
create trigger hole_scores_stamp before insert or update on hole_scores
  for each row execute function hole_scores_stamp();

grant execute on function scoring_field(uuid) to authenticated;
grant execute on function link_member_player(uuid) to authenticated;
revoke execute on function scoring_field(uuid) from anon;
revoke execute on function link_member_player(uuid) from anon;

-- ---------- Realtime ----------
-- Leaderboards update as scores go in.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and tablename = 'hole_scores') then
    alter publication supabase_realtime add table hole_scores;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and tablename = 'event_scoring') then
    alter publication supabase_realtime add table event_scoring;
  end if;
end $$;
