-- ============================================================
-- Meal choices for a round (e.g. the Christmas meal after Round 9).
--
-- The committee puts a menu on a round: courses, each with options, and
-- an option can have extras (ice cream or custard). Players in that
-- round choose for themselves until it closes; the committee can choose
-- for anyone in the round at any time (handy for members without a
-- login). Every signed-in member can see who's having what.
--
-- Run after sql/live-scoring.sql. Safe to run twice.
-- ============================================================

create table if not exists event_menus (
  event_id uuid primary key references events(id) on delete cascade,
  title text not null default 'Meal choices',
  -- [{"key":"main","label":"Main","options":[{"name":"Roast beef","note":"","extras":[]}]}]
  courses jsonb not null,
  closes_at timestamptz,
  created_at timestamptz not null default now()
);
alter table event_menus enable row level security;
drop policy if exists "Members see menus" on event_menus;
create policy "Members see menus" on event_menus for select to authenticated using (true);
drop policy if exists "Committee manages menus" on event_menus;
create policy "Committee manages menus" on event_menus for all to authenticated using (is_committee()) with check (is_committee());

create table if not exists meal_choices (
  event_id uuid not null references events(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  choices jsonb not null default '{}'::jsonb,   -- {"main":"Roast beef","dessert":"Sticky toffee pudding","dessert_extra":"Custard"}
  not_eating boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (event_id, player_id)
);
alter table meal_choices enable row level security;
drop policy if exists "Members see meal choices" on meal_choices;
create policy "Members see meal choices" on meal_choices for select to authenticated using (true);
-- No insert/update policies: choices go through set_meal_choice().

-- Everyone playing in the round, with their choice (or none yet).
create or replace function meal_board(p_event uuid)
returns table (player_id uuid, name text, mine boolean, choices jsonb, not_eating boolean, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  with field as (
    select distinct coalesce(a.player_id, (select p.id from players p where p.profile_id = a.profile_id limit 1)) as pid
      from attendance a
     where a.event_id = p_event and a.status = 'playing'
  )
  select p.id, p.name, (p.profile_id is not null and p.profile_id = auth.uid()),
         mc.choices, coalesce(mc.not_eating, false), mc.updated_at
    from field f join players p on p.id = f.pid
    left join meal_choices mc on mc.event_id = p_event and mc.player_id = p.id
   where auth.uid() is not null
   order by p.name;
$$;
revoke execute on function meal_board(uuid) from public, anon;
grant execute on function meal_board(uuid) to authenticated;

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
     where a.event_id = p_event and a.status = 'playing'
       and (a.player_id = p_player or a.profile_id = (select profile_id from players where id = p_player))
  ) then raise exception 'Only players in this round can choose a meal.'; end if;

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
revoke execute on function set_meal_choice(uuid, uuid, jsonb, boolean) from public, anon;
grant execute on function set_meal_choice(uuid, uuid, jsonb, boolean) to authenticated;
