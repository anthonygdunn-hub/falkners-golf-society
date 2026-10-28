-- ============================================================
-- Society handicaps, practice rounds, divisions, Ryder Cup captains.
--
-- Run after sql/handicap-reviews.sql. Safe to run twice.
--
-- Society handicaps
--   players.handicap is the society index everyone plays off. After every
--   finished round the app recalculates it for everyone (best 8 of the
--   last 20 differentials, fewer while there aren't 20), and the
--   committee can correct a figure afterwards. Each round's working is
--   kept in handicap_reviews, which every member can read.
--   players.official_index is the England Golf index, where a player has
--   one - the starting point. Players without one get a provisional
--   handicap from their society rounds.
--   players.hcp_cut is a temporary cut (winner 2, runner-up 1) taken off
--   the next round the player plays only, then cleared. It carries over
--   when they miss rounds and is ignored by the recalculation.
-- Practice rounds
--   events.is_practice: hidden from the website, never copied to results,
--   no handicap changes, no cuts used up, no reminders.
-- Divisions
--   event_scoring.division_split: when set, the leaderboard splits into
--   two divisions on the index (e.g. 18 = up to 18, then 19 and over).
-- Ryder Cup captains
--   rc_players.captain: a captain may pick their own team's players in
--   the matches, but nothing else.
-- ============================================================

alter table players add column if not exists official_index numeric;
alter table players add column if not exists hcp_cut numeric not null default 0;
alter table players add column if not exists hcp_cut_note text;
alter table event_handicaps add column if not exists cut numeric not null default 0;

-- Committee changes not tied to a round (a provisional handicap) have no event.
alter table handicap_reviews alter column event_id drop not null;
alter table handicap_reviews add column if not exists source text not null default 'card';
alter table handicap_reviews add column if not exists ags numeric;
alter table handicap_reviews add column if not exists overridden boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'handicap_reviews_source_check') then
    alter table handicap_reviews add constraint handicap_reviews_source_check check (source in ('card', 'points', 'manual'));
  end if;
end $$;

alter table events add column if not exists is_practice boolean not null default false;
alter table event_scoring add column if not exists division_split integer check (division_split between 1 and 53);
alter table rc_players add column if not exists captain boolean not null default false;

-- Taking the cut when a round starts. Called by whoever starts the round
-- (committee or the round's admin): each player's pending cut comes off
-- the index snapshotted for this round and is then cleared. Practice
-- rounds leave cuts alone. Safe to call twice.
create or replace function take_handicap_cuts(p_event uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  if not can_manage_round(p_event) then raise exception 'Only the round''s managers can start it.'; end if;
  if (select is_practice from events where id = p_event) then return 0; end if;
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
revoke execute on function take_handicap_cuts(uuid) from public, anon;
grant execute on function take_handicap_cuts(uuid) to authenticated;

-- Ryder Cup captains.
create or replace function rc_captain_side(p_event uuid)
returns smallint language sql stable security definer set search_path = public as $$
  select rp.side from rc_players rp join players pl on pl.id = rp.player_id
   where rp.event_id = p_event and rp.captain and pl.profile_id = auth.uid() limit 1;
$$;
revoke execute on function rc_captain_side(uuid) from public, anon;
grant execute on function rc_captain_side(uuid) to authenticated;

drop policy if exists "Captains pick" on rc_matches;
create policy "Captains pick" on rc_matches for update
  using (rc_captain_side(event_id) is not null) with check (rc_captain_side(event_id) is not null);

-- A captain (who isn't also a manager) may only change their own side,
-- only with their own team, and not once the session is finished.
create or replace function rc_matches_captain_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare s smallint; st text;
begin
  if can_manage_round(new.event_id) then return new; end if;
  s := rc_captain_side(new.event_id);
  if s is null then raise exception 'Not allowed.'; end if;
  select status into st from rc_sessions where id = new.session_id;
  if st = 'final' then raise exception 'That session is finished.'; end if;
  if new.session_id <> old.session_id or new.event_id <> old.event_id or new.match_no <> old.match_no then
    raise exception 'Captains can only pick players.';
  end if;
  if (s = 1 and new.side2 is distinct from old.side2) or (s = 2 and new.side1 is distinct from old.side1) then
    raise exception 'You can only pick your own team.';
  end if;
  if exists (select 1 from unnest(case when s = 1 then new.side1 else new.side2 end) x
              where not exists (select 1 from rc_players rp where rp.event_id = new.event_id and rp.player_id = x and rp.side = s)) then
    raise exception 'That player isn''t on your team.';
  end if;
  return new;
end $$;
drop trigger if exists rc_matches_captain_guard on rc_matches;
create trigger rc_matches_captain_guard before update on rc_matches for each row execute function rc_matches_captain_guard();
