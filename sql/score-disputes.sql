-- ============================================================
-- Personal cards and score disputes for the scoring app.
--
-- Run AFTER sql/live-scoring.sql. Safe to run twice.
--
-- How it works:
--   * Every phone that enters a score writes its OWN entry
--     (score_entries: one row per player, hole and person entering).
--   * hole_scores becomes the result the app shows: when every entry
--     for a hole agrees, that's the score. When two people have put
--     in different numbers it is marked disputed, and it shows on
--     everyone's phone in that group until they agree.
--   * A group with one person scoring never sees a dispute — there is
--     only ever one entry.
--   * A card can't be submitted while it has a disputed hole.
--   * If they can't agree, "Ask the committee" emails the committee,
--     who settle it from the scorecard. The committee can change any
--     score at any time, even on a submitted card.
-- ============================================================

-- ---------- Entries: who said what ----------

create table if not exists score_entries (
  event_id uuid not null references events(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  hole integer not null check (hole between 1 and 18),
  entered_by uuid not null references profiles(id) on delete cascade,
  strokes integer check (strokes is null or strokes between 1 and 20),
  picked_up boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (event_id, player_id, hole, entered_by),
  check (strokes is not null or picked_up)
);
create index if not exists score_entries_cell_idx on score_entries (event_id, player_id, hole);

-- ---------- The result, now worked out from the entries ----------

alter table hole_scores add column if not exists disputed boolean not null default false;
alter table hole_scores add column if not exists escalated boolean not null default false;
alter table hole_scores add column if not exists settled_by uuid references profiles(id) on delete set null;
alter table hole_scores add column if not exists settled_at timestamptz;

-- Nobody writes hole_scores directly any more: it follows the entries.
drop policy if exists "Players enter scores" on hole_scores;
drop policy if exists "Players correct scores" on hole_scores;
drop policy if exists "Players clear scores" on hole_scores;
drop trigger if exists hole_scores_stamp on hole_scores;

-- ---------- Submitted cards ----------

create table if not exists card_submissions (
  event_id uuid not null references events(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  submitted_by uuid references profiles(id) on delete set null,
  submitted_at timestamptz not null default now(),
  primary key (event_id, player_id)
);

create or replace function card_submitted(target uuid, pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from card_submissions where event_id = target and player_id = pid);
$$;

-- ---------- Working out the result for one hole ----------

create or replace function recompute_hole_score(p_event uuid, p_player uuid, p_hole integer)
returns void language plpgsql security definer set search_path = public as $$
declare
  n_entries integer;
  n_values integer;
  latest score_entries%rowtype;
begin
  select count(*), count(distinct (coalesce(strokes, 0), picked_up))
    into n_entries, n_values
    from score_entries
   where event_id = p_event and player_id = p_player and hole = p_hole;

  if n_entries = 0 then
    delete from hole_scores where event_id = p_event and player_id = p_player and hole = p_hole;
    return;
  end if;

  -- The most recent entry is what shows while a hole is disputed, so the
  -- leaderboard keeps moving; the dispute flag says it isn't settled.
  select * into latest from score_entries
   where event_id = p_event and player_id = p_player and hole = p_hole
   order by updated_at desc limit 1;

  insert into hole_scores (event_id, player_id, hole, strokes, picked_up, entered_by, updated_at, disputed, escalated)
  values (p_event, p_player, p_hole, latest.strokes, latest.picked_up, latest.entered_by, now(), n_values > 1, false)
  on conflict (event_id, player_id, hole) do update
     set strokes = excluded.strokes,
         picked_up = excluded.picked_up,
         entered_by = excluded.entered_by,
         updated_at = excluded.updated_at,
         disputed = excluded.disputed,
         -- an agreed hole is no longer waiting on the committee
         escalated = case when excluded.disputed then hole_scores.escalated else false end,
         settled_by = case when excluded.disputed then null else hole_scores.settled_by end,
         settled_at = case when excluded.disputed then null else hole_scores.settled_at end;
end;
$$;

create or replace function score_entries_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform recompute_hole_score(old.event_id, old.player_id, old.hole);
    return old;
  end if;
  perform recompute_hole_score(new.event_id, new.player_id, new.hole);
  return new;
end;
$$;

drop trigger if exists score_entries_changed on score_entries;
create trigger score_entries_changed after insert or update or delete on score_entries
  for each row execute function score_entries_changed();

-- Whoever is signed in is who the entry belongs to, whatever the phone
-- sends; and an entry can't be handed to somebody else later.
create or replace function score_entries_stamp()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.entered_by := coalesce(auth.uid(), new.entered_by);
  else
    new.entered_by := old.entered_by;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists score_entries_stamp on score_entries;
create trigger score_entries_stamp before insert or update on score_entries
  for each row execute function score_entries_stamp();

-- ---------- Who can enter what ----------

alter table score_entries enable row level security;
alter table card_submissions enable row level security;

drop policy if exists "Members read entries" on score_entries;
create policy "Members read entries" on score_entries for select using (is_approved_member());

-- Anyone on a live round can score anyone in it, as themselves, until
-- that player's card is submitted. The committee always can.
drop policy if exists "Players add their entries" on score_entries;
create policy "Players add their entries" on score_entries for insert
  with check (
    entered_by = auth.uid()
    and can_score_event(event_id) and in_field(event_id, player_id)
    and (is_committee() or not card_submitted(event_id, player_id))
  );
drop policy if exists "Players change their entries" on score_entries;
create policy "Players change their entries" on score_entries for update
  using (entered_by = auth.uid() and can_score_event(event_id) and (is_committee() or not card_submitted(event_id, player_id)))
  with check (entered_by = auth.uid() and in_field(event_id, player_id));
drop policy if exists "Players clear their entries" on score_entries;
create policy "Players clear their entries" on score_entries for delete
  using (entered_by = auth.uid() and can_score_event(event_id) and (is_committee() or not card_submitted(event_id, player_id)));

drop policy if exists "Members read submissions" on card_submissions;
create policy "Members read submissions" on card_submissions for select using (is_approved_member());
drop policy if exists "Committee reopens cards" on card_submissions;
create policy "Committee reopens cards" on card_submissions for delete using (is_committee());

-- ---------- Agreeing, submitting, asking the committee ----------

-- "Use this score": a phone that entered a different number accepts the
-- other one. Only changes the caller's own entry, so agreement is real.
create or replace function accept_score(p_event uuid, p_player uuid, p_hole integer, p_strokes integer, p_picked_up boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not can_score_event(p_event) then raise exception 'Scoring is closed for this round.'; end if;
  if card_submitted(p_event, p_player) and not is_committee() then raise exception 'That card has been submitted.'; end if;
  update score_entries set strokes = p_strokes, picked_up = coalesce(p_picked_up, false)
   where event_id = p_event and player_id = p_player and hole = p_hole and entered_by = auth.uid();
  if not found then
    raise exception 'You have not entered a score for that hole.';
  end if;
end;
$$;

create or replace function submit_card(p_event uuid, p_player uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  missing integer;
  disputes integer;
begin
  if not can_score_event(p_event) then raise exception 'Scoring is closed for this round.'; end if;
  if not in_field(p_event, p_player) then raise exception 'That player is not on this round.'; end if;
  select count(*) into disputes from hole_scores where event_id = p_event and player_id = p_player and disputed;
  if disputes > 0 then
    raise exception 'This card has % disputed hole%. Agree them first, or ask the committee.', disputes, case when disputes = 1 then '' else 's' end;
  end if;
  select 18 - count(*) into missing from hole_scores where event_id = p_event and player_id = p_player;
  if missing > 0 then
    raise exception 'This card is missing % hole%. Put in a score or a pick-up for every hole.', missing, case when missing = 1 then '' else 's' end;
  end if;
  insert into card_submissions (event_id, player_id, submitted_by) values (p_event, p_player, auth.uid())
  on conflict (event_id, player_id) do nothing;
end;
$$;

create or replace function ask_committee(p_event uuid, p_player uuid, p_hole integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not can_score_event(p_event) then raise exception 'Scoring is closed for this round.'; end if;
  update hole_scores set escalated = true
   where event_id = p_event and player_id = p_player and hole = p_hole and disputed and not escalated;
end;
$$;

-- The committee's ruling: every entry for the hole becomes this score,
-- so the hole is agreed. Works on submitted cards and finished rounds.
create or replace function settle_score(p_event uuid, p_player uuid, p_hole integer, p_strokes integer, p_picked_up boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_committee() then raise exception 'Only the committee can settle a score.'; end if;
  if p_strokes is null and not coalesce(p_picked_up, false) then
    -- clearing the hole completely
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

grant execute on function accept_score(uuid, uuid, integer, integer, boolean) to authenticated;
grant execute on function submit_card(uuid, uuid) to authenticated;
grant execute on function ask_committee(uuid, uuid, integer) to authenticated;
grant execute on function settle_score(uuid, uuid, integer, integer, boolean) to authenticated;
revoke execute on function accept_score(uuid, uuid, integer, integer, boolean) from anon;
revoke execute on function submit_card(uuid, uuid) from anon;
revoke execute on function ask_committee(uuid, uuid, integer) from anon;
revoke execute on function settle_score(uuid, uuid, integer, integer, boolean) from anon;

-- ---------- Email the committee when a group asks ----------
-- Same route as the new-member and payment alerts (Edge Function
-- member-alerts). If the call fails the request still stands: it shows
-- in the app under Setup → Disputes either way.

create or replace function notify_dispute_escalated()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.escalated and not coalesce(old.escalated, false) then
    begin
      perform net.http_post(
        url := 'https://drwfedhhpuhgiqmqtwgi.supabase.co/functions/v1/member-alerts',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'Authorization', 'Bearer sb_publishable_9BqjPM1TnF1b1gy0YTWGiA_iw9yxpUw'),
        body := jsonb_build_object('type', 'UPDATE', 'table', 'hole_scores', 'schema', 'public',
                                   'record', to_jsonb(new), 'old_record', to_jsonb(old)));
    exception when others then
      raise warning 'Dispute alert not sent: %', sqlerrm;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_dispute_escalated on hole_scores;
create trigger notify_dispute_escalated after update of escalated on hole_scores
  for each row execute function notify_dispute_escalated();

-- ---------- Live updates ----------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and tablename = 'score_entries') then
    alter publication supabase_realtime add table score_entries;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and tablename = 'card_submissions') then
    alter publication supabase_realtime add table card_submissions;
  end if;
end $$;
