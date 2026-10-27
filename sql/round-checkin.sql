-- ============================================================
-- Checking in on the day of a round.
--
-- Run after sql/score-disputes.sql. Safe to run twice.
--
-- Players open the round from the fixture page ("View round" once the
-- committee has set it up, "Start round" on the day) and check in to say
-- they're coming and ready to play. Check-in opens as soon as the round
-- is set up in the app, and closes after the day. Anyone
-- in the same tee group can check the others in — for the members who
-- don't use a phone — and the committee can check anyone in at any
-- time. The committee sees who hasn't checked in under Setup.
-- ============================================================

create table if not exists round_checkins (
  event_id uuid not null references events(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  checked_in_by uuid references profiles(id) on delete set null,
  checked_in_at timestamptz not null default now(),
  primary key (event_id, player_id)
);

alter table round_checkins enable row level security;
drop policy if exists "Members read check-ins" on round_checkins;
create policy "Members read check-ins" on round_checkins for select using (is_approved_member());
-- No direct writes: check_in() below decides who may check whom in.

-- Today in the UK, so "on the day" means the golfer's day, not UTC's.
create or replace function london_today()
returns date language sql stable set search_path = public as $$
  select (now() at time zone 'Europe/London')::date;
$$;

-- Check-in is open from when the round is set up in the app until the
-- end of the day it's played.
create or replace function check_in_open(p_event uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select e.event_date = london_today()
                       or (e.event_date > london_today() and exists (select 1 from event_scoring s where s.event_id = e.id))
                     from events e where e.id = p_event), false);
$$;

-- The tee groups a player is in for a round (normally one).
create or replace function tee_groups_of(p_event uuid, p_player uuid)
returns setof integer language sql stable security definer set search_path = public as $$
  select g.group_number from groupings g
   where g.event_id = p_event and g.group_type = 'fours'
     and (g.player_id = p_player
          or (g.profile_id is not null and g.profile_id = (select profile_id from players where id = p_player)));
$$;

-- May the signed-in user check this player in (or out)?
--   * the committee: always
--   * otherwise only from when the round is set up until the day itself,
--     only if you're on the round yourself, and
--     only for yourself or someone in your tee group (anyone on the round,
--     if the tee draw hasn't been set)
create or replace function can_check_in(p_event uuid, p_player uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_players uuid[];
  my_groups integer[];
  their_groups integer[];
begin
  if me is null or not is_approved_member() then return false; end if;
  if is_committee() then return true; end if;
  if not check_in_open(p_event) then return false; end if;
  if not in_field(p_event, p_player) then return false; end if;
  if not exists (select 1 from attendance a where a.event_id = p_event and a.status = 'playing'
                  and (a.profile_id = me or a.player_id in (select id from players where profile_id = me))) then
    return false;
  end if;
  select array_agg(id) into my_players from players where profile_id = me;
  if p_player = any(coalesce(my_players, '{}')) then return true; end if;
  select array_agg(distinct g.group_number) into my_groups from groupings g
   where g.event_id = p_event and g.group_type = 'fours'
     and (g.profile_id = me or g.player_id = any(coalesce(my_players, '{}')));
  if my_groups is null then
    -- no tee draw yet (or you're not in it): anyone on the round may help
    return not exists (select 1 from groupings g where g.event_id = p_event and g.group_type = 'fours');
  end if;
  select array_agg(x) into their_groups from tee_groups_of(p_event, p_player) x;
  return their_groups && my_groups;
end;
$$;

create or replace function check_in(p_event uuid, p_player uuid, p_here boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not can_check_in(p_event, p_player) then
    if not check_in_open(p_event) and not is_committee() then
      if (select event_date from events where id = p_event) < london_today() then
        raise exception 'This round has been played.';
      end if;
      raise exception 'Check-in opens once the committee has set the round up.';
    end if;
    raise exception 'You can check in yourself and the players in your group.';
  end if;
  if coalesce(p_here, true) then
    insert into round_checkins (event_id, player_id, checked_in_by) values (p_event, p_player, auth.uid())
    on conflict (event_id, player_id) do nothing;
  else
    delete from round_checkins where event_id = p_event and player_id = p_player;
  end if;
end;
$$;

revoke execute on function tee_groups_of(uuid, uuid) from public, anon, authenticated;
revoke execute on function check_in_open(uuid) from public, anon, authenticated;
revoke execute on function can_check_in(uuid, uuid) from public, anon;
revoke execute on function check_in(uuid, uuid, boolean) from public, anon;
grant execute on function can_check_in(uuid, uuid) to authenticated;
grant execute on function check_in(uuid, uuid, boolean) to authenticated;
grant execute on function london_today() to anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and tablename = 'round_checkins') then
    alter publication supabase_realtime add table round_checkins;
  end if;
end $$;
