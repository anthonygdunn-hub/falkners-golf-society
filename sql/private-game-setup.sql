-- ============================================================
-- Private games, step by step: up to 16 players in tee groups, the
-- format, handicaps, nearest the pin and long drive holes, and draft
-- or start now.
--
-- Run after sql/course-preview.sql. Safe to run twice. The older
-- create_private_game stays for phones still on the previous app.
-- ============================================================

create or replace function create_private_game_v2(p jsonb)
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
  field uuid[] := '{}';
  per integer := least(4, greatest(2, coalesce((p ->> 'group_size')::int, 4)));
  d date := coalesce((p ->> 'date')::date, london_today());
  t uuid := (p ->> 'tee')::uuid;
  fmts text[] := array(select x from jsonb_array_elements_text(coalesce(p -> 'formats', '["stableford"]'::jsonb)) x where x in ('stableford', 'medal', 'skins'));
  meth text := coalesce(p ->> 'handicap_method', 'whs');
  allow numeric := coalesce((p ->> 'allowance')::numeric, 95);
  st text := case when p ->> 'status' = 'live' then 'live' else 'setup' end;
  hole_ok jsonb := coalesce(p -> 'contests', '{}'::jsonb);
  h integer;
begin
  if not is_approved_member() then raise exception 'Only members can set up a private game.'; end if;
  select id into my_player from players where profile_id = me and guest_event_id is null order by created_at limit 1;
  if my_player is null then raise exception 'You need to be on the player list first — ask the committee to link your account.'; end if;
  everyone := array(select distinct x::uuid from jsonb_array_elements_text(coalesce(p -> 'players', '[]'::jsonb)) x);
  everyone := array[my_player] || array(select x from unnest(everyone) x where x <> my_player);
  if cardinality(everyone) + coalesce(jsonb_array_length(p -> 'guests'), 0) > 16 then raise exception 'A private game is up to 16 players.'; end if;
  if exists (select 1 from unnest(everyone) x where not exists (select 1 from players pl where pl.id = x and pl.guest_event_id is null)) then
    raise exception 'That player isn''t on the society list.';
  end if;
  select c.name into course_name from course_tees ct join courses c on c.id = ct.course_id where ct.id = t;
  if course_name is null then raise exception 'Choose a course and tee.'; end if;
  if d < london_today() - 1 then raise exception 'Choose today or a date ahead.'; end if;
  if st = 'live' and d <> london_today() then st := 'setup'; end if;
  if meth not in ('whs', 'profile') then meth := 'whs'; end if;
  allow := least(100, greatest(0, allow));
  if cardinality(fmts) = 0 then fmts := array['stableford']; end if;
  foreach h in array array[(hole_ok ->> 'ld_front_hole')::int, (hole_ok ->> 'ld_back_hole')::int, (hole_ok ->> 'ntp_front_hole')::int,
                           (hole_ok ->> 'ntp_back_hole')::int, (hole_ok ->> 'ntp2_front_hole')::int, (hole_ok ->> 'ntp2_back_hole')::int] loop
    if h is not null and (h < 1 or h > 18) then raise exception 'Contest holes are 1 to 18.'; end if;
  end loop;

  insert into events (name, venue, event_date, tee_time, hidden, order_of_merit, is_private, owner_id, private_visible,
                      ld_front_hole, ld_back_hole, ntp_front_hole, ntp_back_hole, ntp2_front_hole, ntp2_back_hole)
  values (left(coalesce(nullif(trim(p ->> 'name'), ''), 'Private game'), 80), course_name, d, nullif(p ->> 'tee_time', '')::time,
          true, false, true, me, coalesce((p ->> 'visible')::boolean, false),
          (hole_ok ->> 'ld_front_hole')::int, (hole_ok ->> 'ld_back_hole')::int, (hole_ok ->> 'ntp_front_hole')::int,
          (hole_ok ->> 'ntp_back_hole')::int, (hole_ok ->> 'ntp2_front_hole')::int, (hole_ok ->> 'ntp2_back_hole')::int)
  returning id into ev;
  insert into moderator_grants (profile_id, event_id, granted_by) values (me, ev, me);
  insert into event_scoring (event_id, tee_id, handicap_method, allowance, formats, skins_mode, status, tee_interval)
  values (ev, t, meth, allow, fmts, case when p ->> 'skins_mode' = 'gross' then 'gross' else 'net' end, st,
          nullif(least(30, greatest(0, coalesce((p ->> 'tee_interval')::int, 0))), 0));

  foreach pid in array everyone loop
    insert into attendance (event_id, player_id, status, payment_status) values (ev, pid, 'playing', 'confirmed');
    field := field || pid;
  end loop;
  for g in select * from jsonb_array_elements(coalesce(p -> 'guests', '[]'::jsonb)) loop
    if coalesce(trim(g ->> 'name'), '') = '' then continue; end if;
    insert into players (name, handicap, active, guest_event_id)
    values (left(trim(g ->> 'name'), 60), least(54, greatest(-10, coalesce(nullif(g ->> 'handicap', '')::numeric, 54))), false, ev)
    returning id into pid;
    insert into attendance (event_id, player_id, status, payment_status) values (ev, pid, 'playing', 'confirmed');
    field := field || pid;
  end loop;

  -- Tee groups in the order given, so many to a group; pairs are
  -- the first two and the last two of each group.
  n := 0;
  foreach pid in array field loop
    insert into groupings (event_id, player_id, group_type, group_number, position) values (ev, pid, 'fours', n / per + 1, n % per);
    if coalesce((p ->> 'pairs')::boolean, false) then
      insert into groupings (event_id, player_id, group_type, group_number, position)
      values (ev, pid, 'pairs', (n / per) * ((per + 1) / 2) + (n % per) / 2 + 1, (n % per) % 2);
    end if;
    n := n + 1;
  end loop;
  return ev;
end $$;
revoke execute on function create_private_game_v2(jsonb) from public, anon;
grant execute on function create_private_game_v2(jsonb) to authenticated;
