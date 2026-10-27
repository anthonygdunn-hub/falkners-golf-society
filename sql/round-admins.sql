-- ============================================================
-- Round admins: someone to run one round when the committee can't.
--
-- Run after sql/push-notifications.sql. Safe to run twice.
--
-- The committee picks a player in the app (Setup → Round admins). That
-- writes a moderator_grants row for that one fixture, and for that
-- fixture only they can do what the committee does on the day: set the
-- round up, publish it, settle disputes, change and reopen cards,
-- confirm the side contests and finish the round into Results.
--
-- What they can't do: change anyone's handicap (committee only, by
-- society rule), or touch any other fixture. The grant can be removed
-- at any time, and it does nothing once the round is over.
-- ============================================================

-- A grant for a single fixture now works for any approved member; a
-- grant for every fixture (event_id null) still needs the moderator role.
create or replace function can_moderate(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select is_committee() or exists (
    select 1
      from memberships m
      join moderator_grants g on g.profile_id = m.profile_id
     where m.profile_id = auth.uid()
       and m.status = 'approved'
       and ((g.event_id is not null and g.event_id = target)
            or (g.event_id is null and m.role in ('moderator', 'committee')))
  );
$$;

-- Settling a score, and the "card already in" exceptions, move from
-- committee-only to whoever's running the round.
create or replace function settle_score(p_event uuid, p_player uuid, p_hole integer, p_strokes integer, p_picked_up boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not can_manage_round(p_event) then raise exception 'Only the committee or the round admin can settle a score.'; end if;
  if p_strokes is null and not coalesce(p_picked_up, false) then
    delete from score_entries where event_id = p_event and player_id = p_player and hole = p_hole;
    return;
  end if;
  insert into score_entries (event_id, player_id, hole, entered_by, strokes, picked_up)
  values (p_event, p_player, p_hole, auth.uid(), p_strokes, coalesce(p_picked_up, false))
  on conflict (event_id, player_id, hole, entered_by) do update
     set strokes = excluded.strokes, picked_up = excluded.picked_up;
  update score_entries set strokes = p_strokes, picked_up = coalesce(p_picked_up, false)
   where event_id = p_event and player_id = p_player and hole = p_hole;
  update hole_scores set settled_by = auth.uid(), settled_at = now()
   where event_id = p_event and player_id = p_player and hole = p_hole;
end;
$$;

create or replace function accept_score(p_event uuid, p_player uuid, p_hole integer, p_strokes integer, p_picked_up boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not can_score_event(p_event) then raise exception 'Scoring is closed for this round.'; end if;
  if card_submitted(p_event, p_player) and not can_manage_round(p_event) then raise exception 'That card has been submitted.'; end if;
  update score_entries set strokes = p_strokes, picked_up = coalesce(p_picked_up, false)
   where event_id = p_event and player_id = p_player and hole = p_hole and entered_by = auth.uid();
  if not found then
    raise exception 'You have not entered a score for that hole.';
  end if;
end;
$$;

drop policy if exists "Players add their entries" on score_entries;
create policy "Players add their entries" on score_entries for insert
  with check (
    entered_by = auth.uid()
    and can_score_event(event_id) and in_field(event_id, player_id)
    and (can_manage_round(event_id) or not card_submitted(event_id, player_id))
  );
drop policy if exists "Players change their entries" on score_entries;
create policy "Players change their entries" on score_entries for update
  using (entered_by = auth.uid() and can_score_event(event_id) and (can_manage_round(event_id) or not card_submitted(event_id, player_id)))
  with check (entered_by = auth.uid() and in_field(event_id, player_id));
drop policy if exists "Players clear their entries" on score_entries;
create policy "Players clear their entries" on score_entries for delete
  using (entered_by = auth.uid() and can_score_event(event_id) and (can_manage_round(event_id) or not card_submitted(event_id, player_id)));

drop policy if exists "Committee reopens cards" on card_submissions;
create policy "Committee reopens cards" on card_submissions for delete using (can_manage_round(event_id));

-- Who's running a round, for the app to show. Names only.
create or replace function round_admins(p_event uuid)
returns table (profile_id uuid, name text) language sql stable security definer set search_path = public as $$
  select g.profile_id, coalesce(pl.name, pr.display_name)
    from moderator_grants g
    join profiles pr on pr.id = g.profile_id
    left join lateral (select name from players where players.profile_id = g.profile_id limit 1) pl on true
   where g.event_id = p_event and is_approved_member();
$$;
revoke execute on function round_admins(uuid) from public, anon;
grant execute on function round_admins(uuid) to authenticated;
