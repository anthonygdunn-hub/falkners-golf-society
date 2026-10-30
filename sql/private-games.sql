-- ============================================================
-- Private games, guests, and member-added courses.
-- Also fixes practice rounds for committee members who aren't trip admins.
--
-- Run after sql/society-handicaps.sql. Safe to run twice.
--
-- Private game: a member's own round (up to 4 players: members and
-- friends). Hidden from the website, never in results, the Order of
-- Merit, records or handicaps. The owner chooses whether all members can
-- see it or only the players. Its results are kept in game_results and
-- shown on each member's profile.
--
-- Guests: a friend who isn't a member. The owner adds them by name and
-- handicap; an invite holds a link and a one-off 6-digit code, emailed by
-- the guest-invite function or shared by the member. The friend opens the
-- link, signs in as a temporary guest (Supabase anonymous sign-in) and
-- enters the code. That guest login can see and score that one game until
-- the end of the day it's played, then it stops working. Their email or
-- mobile is deleted when the game ends; their name stays on the card.
-- Guest logins never become pending members.
-- ============================================================

create extension if not exists pgcrypto;

alter table events add column if not exists is_private boolean not null default false;
alter table events add column if not exists owner_id uuid references profiles(id) on delete set null;
alter table events add column if not exists private_visible boolean not null default false;
alter table players add column if not exists guest_event_id uuid references events(id) on delete cascade;

create table if not exists guest_invites (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  token uuid not null unique default gen_random_uuid(),
  code text not null,
  email text,
  mobile text,
  attempts integer not null default 0,
  used_by uuid,
  used_at timestamptz,
  expires_at timestamptz not null,
  created_by uuid references profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists guest_sessions (
  user_id uuid primary key,
  event_id uuid not null references events(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  expires_at timestamptz not null
);

create table if not exists game_results (
  event_id uuid not null references events(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  points integer,
  gross integer,
  position integer,
  field integer,
  created_at timestamptz not null default now(),
  primary key (event_id, player_id)
);

-- ---------- who can see what ----------

create or replace function is_guest_of(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from guest_sessions g where g.user_id = auth.uid() and g.event_id = target and g.expires_at > now());
$$;

create or replace function in_game(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from events e where e.id = target and e.owner_id = auth.uid())
      or exists (select 1 from attendance a where a.event_id = target and a.status = 'playing'
                  and (a.profile_id = auth.uid() or a.player_id in (select id from players where profile_id = auth.uid())));
$$;

-- Practice: any approved member. Private: everyone who can see it as the
-- owner chose, plus its players and guests.
create or replace function can_see_event(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when e.is_private then (e.private_visible and is_approved_member()) or in_game(target) or is_guest_of(target)
    when e.is_practice then is_approved_member()
    else (not e.hidden) or is_trip_admin()
  end
  from events e where e.id = target;
$$;

-- True only for a private game the signed-in user mustn't see; used by
-- the restrictive policies below so a players-only game stays private.
create or replace function private_hidden(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select e.is_private and not coalesce(can_see_event(target), false) from events e where e.id = target), false);
$$;

do $$ declare f text; begin
  foreach f in array array['is_guest_of(uuid)', 'in_game(uuid)', 'can_see_event(uuid)', 'private_hidden(uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- The events table itself stays as it was, so the website never shows a
-- practice round or a private game. The app reaches them through these.
create or replace function game_event(target uuid)
returns setof events language sql stable security definer set search_path = public as $$
  select * from events e where e.id = target and (e.is_practice or e.is_private) and coalesce(can_see_event(target), false);
$$;
-- Practice rounds and private games for the home screen: practice rounds
-- (committee) and private games the user can see, newest first.
create or replace function my_games()
returns setof events language sql stable security definer set search_path = public as $$
  select * from events e
   where (e.is_practice or e.is_private) and coalesce(can_see_event(e.id), false)
     and e.event_date >= london_today() - 120
   order by e.event_date desc, e.created_at desc limit 30;
$$;
do $$ declare f text; begin
  foreach f in array array['game_event(uuid)', 'my_games()'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
-- These policies came with an earlier draft; they're not wanted.
drop policy if exists "Read practice and private games" on events;
drop policy if exists "Committee runs practice rounds" on events;
drop policy if exists "Owners manage their private game" on events;
drop policy if exists "Owners delete their private game" on events;
drop policy if exists "Read practice and private attendance" on attendance;

-- Guests read their one game.
do $$ declare t text; begin
  foreach t in array array['event_scoring', 'event_handicaps', 'hole_scores', 'score_entries', 'card_submissions', 'round_checkins', 'hole_stats', 'game_results'] loop
    execute format('drop policy if exists "Guests read their game" on %I', t);
    execute format('create policy "Guests read their game" on %I for select using (is_guest_of(event_id))', t);
  end loop;
end $$;

-- A players-only private game stays private from other members.
do $$ declare t text; begin
  foreach t in array array['event_scoring', 'event_handicaps', 'hole_scores', 'score_entries', 'card_submissions', 'round_checkins', 'hole_stats', 'round_posts', 'contest_claims'] loop
    execute format('drop policy if exists "Private games stay private" on %I', t);
    execute format('create policy "Private games stay private" on %I as restrictive for select using (not private_hidden(event_id))', t);
  end loop;
end $$;

alter table game_results enable row level security;
drop policy if exists "Read game results" on game_results;
create policy "Read game results" on game_results for select using (can_see_event(event_id));
drop policy if exists "Managers write game results" on game_results;
create policy "Managers write game results" on game_results for all using (can_manage_round(event_id)) with check (can_manage_round(event_id));

-- Invites hold contact details: the owner and the committee only.
alter table guest_invites enable row level security;
drop policy if exists "Owners read invites" on guest_invites;
create policy "Owners read invites" on guest_invites for select using (created_by = auth.uid() or is_committee());
alter table guest_sessions enable row level security;
drop policy if exists "Guests read their session" on guest_sessions;
create policy "Guests read their session" on guest_sessions for select using (user_id = auth.uid());

-- ---------- courses: any member can add and correct one ----------
do $$ declare t text; begin
  foreach t in array array['courses', 'course_tees', 'course_holes'] loop
    execute format('drop policy if exists "Members add courses" on %I', t);
    execute format('create policy "Members add courses" on %I for insert with check (is_approved_member())', t);
    execute format('drop policy if exists "Members correct courses" on %I', t);
    execute format('create policy "Members correct courses" on %I for update using (is_approved_member()) with check (is_approved_member())', t);
  end loop;
end $$;

-- ---------- guests never become pending members ----------
create or replace function public.handle_new_member_signup()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.is_anonymous, false) then return new; end if;
  insert into profiles (id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'display_name',''), 'New member'))
  on conflict (id) do nothing;
  insert into memberships (profile_id, intended_event_id)
  values (new.id, nullif(new.raw_user_meta_data ->> 'intended_event_id','')::uuid)
  on conflict (profile_id) do nothing;
  return new;
exception when others then
  raise warning 'handle_new_member_signup failed for %: %', new.id, sqlerrm;
  return new;
end;
$$;

-- ---------- the scoring field includes guests of the game ----------
create or replace function scoring_field(target uuid)
returns table(player_id uuid, profile_id uuid, name text, handicap numeric, is_guest boolean, tee_group integer, pair_groups integer[])
language sql stable security definer set search_path = public as $$
  with att as (
    select a.id, a.guest_of,
           coalesce(a.player_id, (select p.id from players p where p.profile_id = a.profile_id order by p.created_at limit 1)) as pid,
           a.profile_id as att_profile
      from attendance a
     where a.event_id = target and a.status = 'playing'
  )
  select att.pid,
         coalesce(pl.profile_id, att.att_profile),
         coalesce(pl.name, pr.display_name, 'Unknown'),
         coalesce(pl.handicap, pr.handicap),
         att.guest_of is not null or pl.guest_event_id is not null,
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
   where (is_approved_member() and not private_hidden(target)) or is_guest_of(target);
$$;
revoke execute on function scoring_field(uuid) from public, anon;
grant execute on function scoring_field(uuid) to authenticated;

-- End of the game's day, London time.
create or replace function game_day_end(d date)
returns timestamptz language sql immutable as $$
  select ((d + 1)::timestamp at time zone 'Europe/London');
$$;

-- ---------- a member creates a private game ----------
-- p_players: other members (player ids). p_guests: [{"name": "...", "handicap": 18.2}, ...]
create or replace function create_private_game(p_name text, p_date date, p_tee uuid, p_visible boolean, p_players uuid[], p_guests jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_player uuid;
  ev uuid;
  course_name text;
  pid uuid;
  g jsonb;
  n integer := 0;
  everyone uuid[];
begin
  if not is_approved_member() then raise exception 'Only members can set up a private game.'; end if;
  select id into my_player from players where profile_id = me order by created_at limit 1;
  if my_player is null then raise exception 'You need to be on the player list first — ask the committee to link your account.'; end if;
  everyone := array(select distinct x from unnest(array[my_player] || coalesce(p_players, '{}')) x where x is not null);
  if cardinality(everyone) + coalesce(jsonb_array_length(p_guests), 0) > 4 then raise exception 'A private game is up to 4 players.'; end if;
  if exists (select 1 from unnest(everyone) x where not exists (select 1 from players p where p.id = x and p.guest_event_id is null)) then
    raise exception 'That player isn''t on the society list.';
  end if;
  select c.name into course_name from course_tees t join courses c on c.id = t.course_id where t.id = p_tee;
  if course_name is null then raise exception 'Choose a course and tee.'; end if;
  if p_date is null or p_date < london_today() - 1 then raise exception 'Choose today or a date ahead.'; end if;

  insert into events (name, venue, event_date, hidden, order_of_merit, is_private, owner_id, private_visible)
  values (coalesce(nullif(trim(p_name), ''), 'Private game'), course_name, p_date, true, false, true, me, coalesce(p_visible, false))
  returning id into ev;
  insert into moderator_grants (profile_id, event_id, granted_by) values (me, ev, me);
  insert into event_scoring (event_id, tee_id, handicap_method, allowance, formats, skins_mode, status)
  values (ev, p_tee, 'whs', 75, array['stableford', 'medal'], 'net', 'setup');

  foreach pid in array everyone loop
    insert into attendance (event_id, player_id, status, payment_status) values (ev, pid, 'playing', 'confirmed');
    insert into groupings (event_id, player_id, group_type, group_number, position) values (ev, pid, 'fours', 1, n);
    n := n + 1;
  end loop;
  for g in select * from jsonb_array_elements(coalesce(p_guests, '[]'::jsonb)) loop
    if coalesce(trim(g ->> 'name'), '') = '' then continue; end if;
    insert into players (name, handicap, active, guest_event_id)
    values (left(trim(g ->> 'name'), 60), least(54, greatest(-10, nullif(g ->> 'handicap', '')::numeric)), false, ev)
    returning id into pid;
    insert into attendance (event_id, player_id, status, payment_status) values (ev, pid, 'playing', 'confirmed');
    insert into groupings (event_id, player_id, group_type, group_number, position) values (ev, pid, 'fours', 1, n);
    n := n + 1;
  end loop;
  return ev;
end $$;
revoke execute on function create_private_game(text, date, uuid, boolean, uuid[], jsonb) from public, anon;
grant execute on function create_private_game(text, date, uuid, boolean, uuid[], jsonb) to authenticated;

-- ---------- a committee member creates a practice round ----------
create or replace function create_practice_round(p_name text, p_date date, p_tee uuid, p_players uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare ev uuid; course_name text; pid uuid; n integer := 0;
begin
  if not is_committee() then raise exception 'Only the committee can set up practice rounds.'; end if;
  select c.name into course_name from course_tees t join courses c on c.id = t.course_id where t.id = p_tee;
  if course_name is null then raise exception 'Choose a course and tee.'; end if;
  if coalesce(cardinality(p_players), 0) = 0 then raise exception 'Tick at least one player.'; end if;
  insert into events (name, venue, event_date, hidden, order_of_merit, is_practice)
  values (coalesce(nullif(trim(p_name), ''), 'Practice round'), course_name, coalesce(p_date, london_today()), true, false, true)
  returning id into ev;
  insert into event_scoring (event_id, tee_id, handicap_method, allowance, formats, skins_mode, status)
  values (ev, p_tee, 'whs', 75, array['stableford'], 'net', 'setup');
  foreach pid in array p_players loop
    insert into attendance (event_id, player_id, status, payment_status) values (ev, pid, 'playing', 'confirmed');
    insert into groupings (event_id, player_id, group_type, group_number, position) values (ev, pid, 'fours', n / 4 + 1, n % 4);
    n := n + 1;
  end loop;
  return ev;
end $$;
revoke execute on function create_practice_round(text, date, uuid, uuid[]) from public, anon;
grant execute on function create_practice_round(text, date, uuid, uuid[]) to authenticated;

-- Delete a practice round (committee) or a private game (its organiser).
create or replace function delete_game(target uuid)
returns void language plpgsql security definer set search_path = public as $$
declare e events%rowtype;
begin
  select * into e from events where id = target;
  if not found then return; end if;
  if not ((e.is_practice and is_committee()) or (e.is_private and (e.owner_id = auth.uid() or is_committee()))) then
    raise exception 'You can''t delete that.';
  end if;
  delete from events where id = target;
end $$;
revoke execute on function delete_game(uuid) from public, anon;
grant execute on function delete_game(uuid) to authenticated;

-- ---------- invites ----------
-- Returns the link token and the 6-digit code; a new invite replaces the old one.
create or replace function create_guest_invite(p_player uuid, p_email text, p_mobile text)
returns table(invite_id uuid, token uuid, code text) language plpgsql security definer set search_path = public as $$
declare ev uuid; d date; c text;
begin
  select p.guest_event_id into ev from players p where p.id = p_player;
  if ev is null then raise exception 'That player isn''t a guest.'; end if;
  if not can_manage_round(ev) then raise exception 'Only the game''s organiser can invite guests.'; end if;
  if coalesce(trim(p_email), '') = '' and coalesce(trim(p_mobile), '') = '' then raise exception 'Add their email or mobile.'; end if;
  select event_date into d from events where id = ev;
  delete from guest_invites where player_id = p_player and used_at is null;
  c := lpad((floor(random() * 1000000))::int::text, 6, '0');
  return query insert into guest_invites (event_id, player_id, code, email, mobile, expires_at)
    values (ev, p_player, c, nullif(lower(trim(p_email)), ''), nullif(trim(p_mobile), ''), game_day_end(d))
    returning id, guest_invites.token, guest_invites.code;
end $$;
revoke execute on function create_guest_invite(uuid, text, text) from public, anon;
grant execute on function create_guest_invite(uuid, text, text) to authenticated;

-- What the join page shows before the code is entered: just enough to
-- know you're in the right place. No contact details.
create or replace function guest_invite_info(p_token uuid)
returns table(guest_name text, game_name text, venue text, event_date date, organiser text, needs_email boolean, expired boolean)
language sql stable security definer set search_path = public as $$
  select pl.name, e.name, e.venue, e.event_date, coalesce(pr.display_name, 'A member'), i.email is not null, i.expires_at < now() or i.attempts >= 5
    from guest_invites i join players pl on pl.id = i.player_id join events e on e.id = i.event_id
    left join profiles pr on pr.id = i.created_by
   where i.token = p_token;
$$;
grant execute on function guest_invite_info(uuid) to anon, authenticated;

-- The friend, signed in as a temporary guest, enters the code. Returns
-- the game, or null when the code or email doesn't match (5 tries).
create or replace function redeem_guest_invite(p_token uuid, p_code text, p_email text)
returns uuid language plpgsql security definer set search_path = public as $$
declare i guest_invites%rowtype; me uuid := auth.uid();
begin
  if me is null then raise exception 'Sign in first.'; end if;
  select * into i from guest_invites where token = p_token for update;
  if not found then raise exception 'That invite link isn''t valid. Ask for a new one.'; end if;
  if i.expires_at < now() then raise exception 'That invite has expired.'; end if;
  if i.attempts >= 5 then raise exception 'Too many wrong codes. Ask for a new invite.'; end if;
  if i.used_by is not null and i.used_by <> me then raise exception 'That invite has already been used. Ask for a new one.'; end if;
  if trim(coalesce(p_code, '')) <> i.code or (i.email is not null and lower(trim(coalesce(p_email, ''))) <> i.email) then
    -- Counted, not raised: an error would undo the count.
    update guest_invites set attempts = attempts + 1 where id = i.id;
    return null;
  end if;
  update guest_invites set used_by = me, used_at = coalesce(used_at, now()) where id = i.id;
  insert into profiles (id, display_name) select me, name from players where id = i.player_id on conflict (id) do nothing;
  update players set profile_id = me where id = i.player_id;
  insert into guest_sessions (user_id, event_id, player_id, expires_at) values (me, i.event_id, i.player_id, i.expires_at)
    on conflict (user_id) do update set event_id = excluded.event_id, player_id = excluded.player_id, expires_at = excluded.expires_at;
  return i.event_id;
end $$;
revoke execute on function redeem_guest_invite(uuid, text, text) from public, anon;
grant execute on function redeem_guest_invite(uuid, text, text) to authenticated;

-- The guest's game, if their access is still open.
create or replace function my_guest_game()
returns table(event_id uuid, player_id uuid, expires_at timestamptz) language sql stable security definer set search_path = public as $$
  select g.event_id, g.player_id, g.expires_at from guest_sessions g where g.user_id = auth.uid() and g.expires_at > now();
$$;
grant execute on function my_guest_game() to authenticated;

-- ---------- handicap cuts are never used up by a private game ----------
create or replace function take_handicap_cuts(p_event uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  if not can_manage_round(p_event) then raise exception 'Only the round''s managers can start it.'; end if;
  if (select is_practice or is_private from events where id = p_event) then return 0; end if;
  with due as (
    select eh.player_id, p.hcp_cut from event_handicaps eh join players p on p.id = eh.player_id
     where eh.event_id = p_event and eh.cut = 0 and p.hcp_cut > 0 and eh.handicap_index is not null
  ), upd as (
    update event_handicaps eh set handicap_index = eh.handicap_index - due.hcp_cut, cut = due.hcp_cut
      from due where eh.event_id = p_event and eh.player_id = due.player_id returning eh.player_id
  )
  update players p set hcp_cut = 0, hcp_cut_note = null from upd where p.id = upd.player_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- tidying up after the game ----------
-- Contact details go when the game's day ends; guest logins stop working
-- then too (their sessions lapse). Their name and scores stay on the card.
create or replace function tidy_guest_games()
returns void language sql security definer set search_path = public as $$
  update guest_invites set email = null, mobile = null where expires_at < now() and (email is not null or mobile is not null);
  delete from guest_sessions where expires_at < now() - interval '1 day';
$$;
revoke execute on function tidy_guest_games() from public, anon, authenticated;

create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'falkners-tidy-guests';
select cron.schedule('falkners-tidy-guests', '20 * * * *', $$ select tidy_guest_games() $$);
