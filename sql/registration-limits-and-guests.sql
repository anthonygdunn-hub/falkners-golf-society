-- ============================================================
-- The Falkners Arms Golf Society: player cap, closing date,
-- waiting list and member-registered guests
--
-- Run this AFTER sql/round-competitions.sql.
-- Supabase dashboard -> SQL Editor -> paste -> Run. Safe to run twice.
--
-- WHAT IT DOES
-- * A round holds 32 players by default (guests included). A round can
--   override that with its own number on the events row.
-- * Members can't register themselves inside the last 7 days before a
--   round. The committee can still add anyone at any time.
-- * Once a round is full, members who register go on a waiting list.
--   Nobody moves up automatically: the committee decides.
-- * A member can bring a guest. The guest counts towards the cap and
--   the member pays for them.
--
-- The rules are enforced here in the database, not just on the page,
-- so they hold however somebody tries to register.
-- ============================================================

-- ------------------------------------------------------------------
-- Settings
-- ------------------------------------------------------------------
alter table league_settings
  add column if not exists max_players integer default 32,
  add column if not exists close_days integer default 7;

alter table league_settings drop constraint if exists league_settings_max_players_check;
alter table league_settings add constraint league_settings_max_players_check
  check (max_players is null or max_players > 0);
alter table league_settings drop constraint if exists league_settings_close_days_check;
alter table league_settings add constraint league_settings_close_days_check
  check (close_days is null or close_days >= 0);

update league_settings
   set max_players = coalesce(max_players, 32),
       close_days  = coalesce(close_days, 7);

-- A single round can hold more or fewer than the usual number.
alter table events add column if not exists max_players integer;
alter table events drop constraint if exists events_max_players_check;
alter table events add constraint events_max_players_check
  check (max_players is null or max_players > 0);

-- ------------------------------------------------------------------
-- Attendance: playing or waiting, and who brought a guest
-- ------------------------------------------------------------------
alter table attendance
  add column if not exists status text not null default 'playing',
  add column if not exists guest_of uuid references profiles(id) on delete set null;

alter table attendance drop constraint if exists attendance_status_check;
alter table attendance add constraint attendance_status_check
  check (status in ('playing', 'waiting'));

-- attendance uses column-level grants (payment columns stay private),
-- so the new columns need granting explicitly. Whether someone is
-- playing or waiting is public, like the playing list itself.
grant select (status, guest_of) on attendance to anon, authenticated;
grant update (status) on attendance to authenticated;

create index if not exists attendance_guest_of_idx on attendance (guest_of) where guest_of is not null;

-- ------------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------------
create or replace function public.round_capacity(target uuid)
returns integer
language sql stable security definer
set search_path to 'public'
as $$
  select coalesce(e.max_players, (select max_players from league_settings limit 1), 32)
  from events e where e.id = target;
$$;

create or replace function public.round_closes_on(target uuid)
returns date
language sql stable security definer
set search_path to 'public'
as $$
  select e.event_date - coalesce((select close_days from league_settings limit 1), 7)
  from events e where e.id = target;
$$;

-- Committee, or a moderator for this round.
create or replace function public.can_manage_round(target uuid)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$ select is_committee() or can_moderate(target); $$;

-- ------------------------------------------------------------------
-- Enforcement on every new registration
-- ------------------------------------------------------------------
create or replace function public.attendance_before_insert()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $$
declare
  ev events%rowtype;
  taken integer;
begin
  select * into ev from events where id = new.event_id;
  if not found then
    raise exception 'That round no longer exists.';
  end if;

  -- The committee can add anyone, any time, over the cap if they choose.
  if can_manage_round(new.event_id) then
    return new;
  end if;

  if ev.event_date < current_date then
    raise exception 'This round has already been played.';
  end if;

  if current_date > round_closes_on(new.event_id) then
    raise exception 'Sign-ups for this round closed on %. Ask a committee member if you still want to play.',
      to_char(round_closes_on(new.event_id), 'FMDay FMDD FMMonth');
  end if;

  -- One registration at a time per round, so two people can't both
  -- take the last place.
  perform pg_advisory_xact_lock(hashtext('round:' || new.event_id::text));

  select count(*) into taken
    from attendance
   where event_id = new.event_id and status = 'playing';

  new.status := case when taken >= round_capacity(new.event_id) then 'waiting' else 'playing' end;
  new.payment_status := 'unpaid';
  new.payment_confirmed_at := null;
  new.payment_confirmed_by := null;
  return new;
end;
$$;

drop trigger if exists trg_attendance_before_insert on attendance;
create trigger trg_attendance_before_insert
  before insert on attendance
  for each row execute function attendance_before_insert();

-- Members can flag their own payment, but only the committee can move
-- somebody off the waiting list or change who a row belongs to.
create or replace function public.attendance_before_update()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $$
begin
  if can_manage_round(old.event_id) then
    return new;
  end if;
  if new.status is distinct from old.status
     or new.event_id is distinct from old.event_id
     or new.guest_of is distinct from old.guest_of
     or new.player_id is distinct from old.player_id then
    raise exception 'Only the committee can change that.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_attendance_before_update on attendance;
create trigger trg_attendance_before_update
  before update on attendance
  for each row execute function attendance_before_update();

-- ------------------------------------------------------------------
-- What a member can see of their own registration and their guests'
-- ------------------------------------------------------------------
drop view if exists attendance_payments;
create view attendance_payments with (security_invoker = false) as
  select id, event_id, profile_id, player_id, created_at,
         payment_status, payment_reference, payment_confirmed_at,
         status, guest_of
    from attendance a
   where (is_committee() or a.profile_id = auth.uid() or a.guest_of = auth.uid())
     and exists (
       select 1 from events e
        where e.id = a.event_id and (e.hidden = false or is_trip_admin())
     );

grant select on attendance_payments to anon, authenticated;

-- ------------------------------------------------------------------
-- Bringing a guest
-- ------------------------------------------------------------------
create or replace function public.register_guest(p_event uuid, p_name text)
returns uuid
language plpgsql security definer
set search_path to 'public'
as $$
declare
  me uuid := auth.uid();
  clean text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  pl players%rowtype;
  new_id uuid;
begin
  if me is null or not exists (
    select 1 from memberships where profile_id = me and status = 'approved'
  ) then
    raise exception 'You need to be a signed-in member to bring a guest.';
  end if;

  if length(clean) < 2 then
    raise exception 'Enter your guest''s full name.';
  end if;

  if not exists (select 1 from attendance where event_id = p_event and profile_id = me) then
    raise exception 'Register yourself for this round first, then add your guest.';
  end if;

  -- A name already in the society reuses that player, so their results
  -- join up with any earlier rounds.
  select * into pl from players where lower(name) = lower(clean) order by created_at limit 1;

  if found and pl.profile_id is not null then
    raise exception '% has their own member account, so they can register themselves.', pl.name;
  end if;

  if not found then
    insert into players (name, active) values (clean, false) returning * into pl;
  end if;

  if exists (select 1 from attendance where event_id = p_event and player_id = pl.id) then
    raise exception '% is already on this round.', pl.name;
  end if;

  insert into attendance (event_id, player_id, guest_of)
  values (p_event, pl.id, me)
  returning id into new_id;

  return new_id;
end;
$$;

create or replace function public.remove_guest(p_attendance uuid)
returns void
language plpgsql security definer
set search_path to 'public'
as $$
begin
  delete from attendance
   where id = p_attendance
     and guest_of = auth.uid()
     and payment_status <> 'confirmed';
  if not found then
    raise exception 'That guest can''t be removed. If they''ve already paid, ask a committee member.';
  end if;
end;
$$;

-- Flags (or un-flags) the member's own payment and their guests' in one go.
create or replace function public.claim_round_payment(p_event uuid, p_status text, p_reference text)
returns void
language plpgsql security definer
set search_path to 'public'
as $$
begin
  if p_status not in ('unpaid', 'claimed') then
    raise exception 'Unknown payment status.';
  end if;
  update attendance
     set payment_status = p_status,
         payment_reference = case when p_status = 'claimed' then left(p_reference, 30) else null end
   where event_id = p_event
     and (profile_id = auth.uid() or guest_of = auth.uid())
     and status = 'playing'
     and payment_status <> 'confirmed';
end;
$$;

revoke all on function public.register_guest(uuid, text) from public;
revoke all on function public.remove_guest(uuid) from public;
revoke all on function public.claim_round_payment(uuid, text, text) from public;
grant execute on function public.register_guest(uuid, text) to authenticated;
grant execute on function public.remove_guest(uuid) to authenticated;
grant execute on function public.claim_round_payment(uuid, text, text) to authenticated;
grant execute on function public.round_capacity(uuid) to anon, authenticated;
grant execute on function public.round_closes_on(uuid) to anon, authenticated;
