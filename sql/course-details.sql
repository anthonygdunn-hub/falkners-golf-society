-- ============================================================
-- Course details: website, phone, club logo and photos, and filling
-- a new course in automatically from OpenStreetMap.
--
-- Run after sql/private-game-setup.sql. Safe to run twice.
--
-- Logos and photos are uploaded by the committee (pictures the club
-- has OK'd, or the society's own). Until there's one, the course page
-- shows the course from above on the satellite map.
--
-- auto_fill_course(): when any member adds a course, the app looks it
-- up on OpenStreetMap and sends what it found here. It only fills gaps
-- (it never overwrites what someone has typed in, or holes already
-- mapped), so it's safe for any member to call.
-- ============================================================

alter table courses add column if not exists website text check (website is null or length(website) <= 200);
alter table courses add column if not exists phone text check (phone is null or length(phone) <= 40);
alter table courses add column if not exists logo_url text check (logo_url is null or length(logo_url) <= 500);
alter table courses add column if not exists photos text[] not null default '{}';
alter table courses add column if not exists osm_ref text;
alter table courses add column if not exists filled_at timestamptz;

insert into storage.buckets (id, name, public, file_size_limit)
values ('course-images', 'course-images', true, 10485760)
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit;

drop policy if exists "Anyone can view course images" on storage.objects;
create policy "Anyone can view course images" on storage.objects
  for select using (bucket_id = 'course-images');
drop policy if exists "Committee uploads course images" on storage.objects;
create policy "Committee uploads course images" on storage.objects
  for insert with check (bucket_id = 'course-images' and is_committee());
drop policy if exists "Committee replaces course images" on storage.objects;
create policy "Committee replaces course images" on storage.objects
  for update using (bucket_id = 'course-images' and is_committee()) with check (bucket_id = 'course-images' and is_committee());
drop policy if exists "Committee removes course images" on storage.objects;
create policy "Committee removes course images" on storage.objects
  for delete using (bucket_id = 'course-images' and is_committee());

-- p: { lat, lng, website, phone, osm_ref,
--      holes: [{ hole, par, si, tee_lat, tee_lng, green_lat, green_lng, front_lat, front_lng, back_lat, back_lng }] }
create or replace function auto_fill_course(p_course uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c courses%rowtype;
  h jsonb;
  mapped int := 0;
  carded boolean := false;
  t uuid;
begin
  if not is_approved_member() then raise exception 'Members only.'; end if;
  select * into c from courses where id = p_course;
  if not found then raise exception 'No such course.'; end if;

  update courses set
    lat = coalesce(lat, (p ->> 'lat')::double precision),
    lng = coalesce(lng, (p ->> 'lng')::double precision),
    website = coalesce(website, left(nullif(p ->> 'website', ''), 200)),
    phone = coalesce(phone, left(nullif(p ->> 'phone', ''), 40)),
    osm_ref = coalesce(osm_ref, left(nullif(p ->> 'osm_ref', ''), 40)),
    filled_at = now()
  where id = p_course;

  -- Holes from the map, only where the course has none yet.
  if not exists (select 1 from course_hole_geo where course_id = p_course) then
    for h in select * from jsonb_array_elements(coalesce(p -> 'holes', '[]'::jsonb)) loop
      if (h ->> 'hole')::int between 1 and 18 and (h ->> 'tee_lat') is not null and (h ->> 'green_lat') is not null then
        insert into course_hole_geo (course_id, hole, tee_lat, tee_lng, green_lat, green_lng, front_lat, front_lng, back_lat, back_lng)
        values (p_course, (h ->> 'hole')::int, (h ->> 'tee_lat')::float8, (h ->> 'tee_lng')::float8, (h ->> 'green_lat')::float8, (h ->> 'green_lng')::float8,
                (h ->> 'front_lat')::float8, (h ->> 'front_lng')::float8, (h ->> 'back_lat')::float8, (h ->> 'back_lng')::float8)
        on conflict (course_id, hole) do nothing;
        mapped := mapped + 1;
      end if;
    end loop;
  end if;

  -- A starter card when the map has par and stroke index for every
  -- hole and the course has no tees yet. Yards are left for the card.
  if not exists (select 1 from course_tees where course_id = p_course)
     and jsonb_array_length(coalesce(p -> 'holes', '[]'::jsonb)) in (9, 18)
     and not exists (select 1 from jsonb_array_elements(p -> 'holes') x where (x ->> 'par') is null or (x ->> 'si') is null) then
    insert into course_tees (course_id, name, colour) values (p_course, 'Yellow', '#f2c94c') returning id into t;
    insert into course_holes (tee_id, hole, par, stroke_index)
    select t, (x ->> 'hole')::int, (x ->> 'par')::int, (x ->> 'si')::int from jsonb_array_elements(p -> 'holes') x
    where (x ->> 'par')::int between 3 and 6 and (x ->> 'si')::int between 1 and 18
    on conflict do nothing;
    carded := true;
  end if;
  return jsonb_build_object('mapped', mapped, 'card', carded);
end $$;
revoke execute on function auto_fill_course(uuid, jsonb) from public, anon;
grant execute on function auto_fill_course(uuid, jsonb) to authenticated;
