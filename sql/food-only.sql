-- ============================================================
-- Coming for food, not playing (e.g. Colette at the Christmas meal).
--
-- A new attendance status, 'food': on the round for the meal only. They
-- aren't in the field, the draw, scoring or the golf numbers, but they
-- are on the meal list and can pick their meal. Members can sign
-- themselves up for food only; the committee can add anyone, including
-- people without a login.
--
-- Pub (food) money is tracked per person: food_paid, set by the
-- committee only. The menu carries the price.
--
-- Run after sql/meal-choices.sql. Safe to run twice.
-- ============================================================

alter table attendance drop constraint if exists attendance_status_check;
alter table attendance add constraint attendance_status_check check (status in ('playing', 'waiting', 'food'));

alter table attendance add column if not exists food_paid boolean not null default false;
alter table attendance add column if not exists food_paid_at timestamptz;
alter table attendance add column if not exists food_paid_by uuid;
alter table event_menus add column if not exists price numeric(6,2);

-- Signing up for food only skips the golf cap (and keeps 'food').
create or replace function attendance_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
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

  new.food_paid := false; new.food_paid_at := null; new.food_paid_by := null;

  -- Food only: no golf place taken, so no cap and no closing date for the golf.
  if new.status = 'food' then
    new.payment_status := 'unpaid';
    new.payment_confirmed_at := null;
    new.payment_confirmed_by := null;
    return new;
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

create or replace function attendance_before_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if can_manage_round(old.event_id) then
    return new;
  end if;
  if new.status is distinct from old.status
     or new.event_id is distinct from old.event_id
     or new.guest_of is distinct from old.guest_of
     or new.player_id is distinct from old.player_id
     or new.food_paid is distinct from old.food_paid
     or new.food_paid_at is distinct from old.food_paid_at
     or new.food_paid_by is distinct from old.food_paid_by then
    raise exception 'Only the committee can change that.';
  end if;
  return new;
end;
$$;

-- Everyone on the meal list: players and food-only, with their choice
-- and (for the committee's benefit) whether they've paid for the food.
create or replace function meal_list(p_event uuid)
returns table (player_id uuid, name text, mine boolean, attending text, choices jsonb, not_eating boolean, food_paid boolean, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  with rows as (
    select distinct on (pid) pid, a.status, a.food_paid
      from (select a.*, coalesce(a.player_id, (select p.id from players p where p.profile_id = a.profile_id limit 1)) as pid
              from attendance a where a.event_id = p_event and a.status in ('playing', 'food')) a
     where pid is not null
     order by pid, (a.status = 'playing') desc
  )
  select p.id, p.name, (p.profile_id is not null and p.profile_id = auth.uid()), r.status,
         mc.choices, coalesce(mc.not_eating, false), r.food_paid, mc.updated_at
    from rows r join players p on p.id = r.pid
    left join meal_choices mc on mc.event_id = p_event and mc.player_id = p.id
   where auth.uid() is not null
   order by p.name;
$$;
revoke execute on function meal_list(uuid) from public, anon;
grant execute on function meal_list(uuid) to authenticated;

-- Players and food-only people can choose; the committee can choose for anyone on it.
create or replace function set_meal_choice(p_event uuid, p_player uuid, p_choices jsonb, p_not_eating boolean default false)
returns meal_choices language plpgsql security definer set search_path = public as $$
declare
  menu event_menus; course jsonb; opt jsonb; picked text; extra text; clean jsonb := '{}'::jsonb;
  committee boolean := is_committee(); row meal_choices;
begin
  select * into menu from event_menus where event_id = p_event;
  if menu.event_id is null then raise exception 'There''s no menu for this round.'; end if;
  if not exists (
    select 1 from attendance a
     where a.event_id = p_event and a.status in ('playing', 'food')
       and (a.player_id = p_player or a.profile_id = (select profile_id from players where id = p_player))
  ) then raise exception 'Only people on this round can choose a meal.'; end if;
  if not committee then
    if not exists (select 1 from players where id = p_player and profile_id = auth.uid()) then
      raise exception 'You can only choose your own meal.';
    end if;
    if menu.closes_at is not null and now() > menu.closes_at then
      raise exception 'Meal choices have closed. Ask the committee if you need to change yours.';
    end if;
  end if;
  if not coalesce(p_not_eating, false) then
    for course in select * from jsonb_array_elements(menu.courses) loop
      picked := p_choices ->> (course ->> 'key');
      if picked is null or picked = '' then raise exception 'Choose a %.', lower(course ->> 'label'); end if;
      select o into opt from jsonb_array_elements(course -> 'options') o where o ->> 'name' = picked;
      if opt is null then raise exception '% isn''t on the menu.', picked; end if;
      clean := clean || jsonb_build_object(course ->> 'key', picked);
      if jsonb_array_length(coalesce(opt -> 'extras', '[]'::jsonb)) > 0 then
        extra := p_choices ->> ((course ->> 'key') || '_extra');
        if extra is null or not exists (select 1 from jsonb_array_elements_text(opt -> 'extras') x where x = extra) then
          raise exception 'Choose % with the %.', lower(array_to_string(array(select jsonb_array_elements_text(opt -> 'extras')), ' or ')), lower(picked);
        end if;
        clean := clean || jsonb_build_object((course ->> 'key') || '_extra', extra);
      end if;
    end loop;
  end if;
  insert into meal_choices (event_id, player_id, choices, not_eating, updated_at, updated_by)
  values (p_event, p_player, clean, coalesce(p_not_eating, false), now(), auth.uid())
  on conflict (event_id, player_id) do update
    set choices = excluded.choices, not_eating = excluded.not_eating, updated_at = now(), updated_by = auth.uid()
  returning * into row;
  return row;
end $$;

-- A member signs themselves up for the food only.
create or replace function join_for_food(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null or not is_approved_member() then raise exception 'Sign in as a member first.'; end if;
  if exists (select 1 from attendance a where a.event_id = p_event
              and (a.profile_id = me or a.player_id in (select id from players where profile_id = me))) then
    raise exception 'You''re already on this round.';
  end if;
  -- Make sure there's a player record, so they appear on the meal list.
  if not exists (select 1 from players where profile_id = me) then
    insert into players (name, handicap, profile_id) select display_name, handicap, id from profiles where id = me;
  end if;
  insert into attendance (event_id, profile_id, status) values (p_event, me, 'food');
end $$;
revoke execute on function join_for_food(uuid) from public, anon;
grant execute on function join_for_food(uuid) to authenticated;

-- The committee adds someone for food only, by player, or by name for
-- someone new (a guest record is made for them).
create or replace function add_food_only(p_event uuid, p_player uuid default null, p_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare pid uuid := p_player; nm text := nullif(trim(coalesce(p_name, '')), '');
begin
  if not can_manage_round(p_event) then raise exception 'Only the committee can add people for food.'; end if;
  if pid is null then
    if nm is null then raise exception 'Give a name.'; end if;
    select id into pid from players where lower(regexp_replace(name, '\s+', ' ', 'g')) = lower(regexp_replace(nm, '\s+', ' ', 'g')) limit 1;
    if pid is null then
      insert into players (name, active, guest_event_id) values (nm, false, p_event) returning id into pid;
    end if;
  end if;
  if exists (select 1 from attendance a where a.event_id = p_event
              and (a.player_id = pid or a.profile_id = (select profile_id from players where id = pid))) then
    raise exception 'They''re already on this round.';
  end if;
  insert into attendance (event_id, player_id, status) values (p_event, pid, 'food');
  return pid;
end $$;
revoke execute on function add_food_only(uuid, uuid, text) from public, anon;
grant execute on function add_food_only(uuid, uuid, text) to authenticated;

-- Committee: mark someone's food as paid or not.
create or replace function set_food_paid(p_event uuid, p_player uuid, p_paid boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_committee() then raise exception 'Only the committee can mark food as paid.'; end if;
  update attendance a set food_paid = coalesce(p_paid, false),
         food_paid_at = case when p_paid then now() end, food_paid_by = case when p_paid then auth.uid() end
   where a.event_id = p_event and a.status in ('playing', 'food')
     and (a.player_id = p_player or a.profile_id = (select profile_id from players where id = p_player));
  if not found then raise exception 'They''re not on this round.'; end if;
end $$;
revoke execute on function set_food_paid(uuid, uuid, boolean) from public, anon;
grant execute on function set_food_paid(uuid, uuid, boolean) to authenticated;

-- The committee takes a food-only person off the round.
create or replace function remove_food_only(p_event uuid, p_player uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (can_manage_round(p_event) or exists (select 1 from players where id = p_player and profile_id = auth.uid())) then
    raise exception 'Only the committee can do that.';
  end if;
  delete from attendance a where a.event_id = p_event and a.status = 'food'
     and (a.player_id = p_player or a.profile_id = (select profile_id from players where id = p_player));
  delete from meal_choices where event_id = p_event and player_id = p_player;
end $$;
revoke execute on function remove_food_only(uuid, uuid) from public, anon;
grant execute on function remove_food_only(uuid, uuid) to authenticated;
