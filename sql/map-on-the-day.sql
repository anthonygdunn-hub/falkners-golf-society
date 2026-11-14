-- ============================================================
-- Mapping a course on the day.
--
-- Anyone scoring a live round can save a hole's tee or the middle of
-- its green from where they're standing. It only fills in what's
-- missing: a hole that's already mapped is left alone (the committee
-- can still move anything on the Map the holes screen). The spot must
-- be a good GPS fix and near the course.
--
-- Run after sql/course-maps.sql and sql/live-scoring.sql. Safe to run twice.
-- ============================================================

create or replace function map_hole_here(p_event uuid, p_hole int, p_kind text, p_lat double precision, p_lng double precision, p_acc double precision)
returns course_hole_geo language plpgsql security definer set search_path = public as $$
declare
  cid uuid; clat double precision; clng double precision; n int; row course_hole_geo;
begin
  if not can_score_event(p_event) then raise exception 'Only players in a live round can map its holes.'; end if;
  if p_kind not in ('tee', 'green') then raise exception 'Choose the tee or the green.'; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then raise exception 'That location doesn''t look right.'; end if;
  if p_acc is null or p_acc > 30 then raise exception 'The GPS isn''t accurate enough yet. Wait a moment in the open and try again.'; end if;
  select c.id, c.lat, c.lng into cid, clat, clng
    from event_scoring s join course_tees t on t.id = s.tee_id join courses c on c.id = t.course_id
   where s.event_id = p_event;
  if cid is null then raise exception 'This round has no course set.'; end if;
  select count(*) into n from course_holes h join event_scoring s on s.tee_id = h.tee_id where s.event_id = p_event;
  if p_hole < 1 or p_hole > greatest(n, 1) then raise exception 'There''s no hole % on this course.', p_hole; end if;
  -- within about 4 km of the course
  if clat is not null and clng is not null
     and sqrt(power(p_lat - clat, 2) + power((p_lng - clng) * cos(radians(clat)), 2)) * 111320 > 4000 then
    raise exception 'You don''t seem to be at the course.';
  end if;

  insert into course_hole_geo (course_id, hole) values (cid, p_hole) on conflict (course_id, hole) do nothing;
  if p_kind = 'tee' then
    update course_hole_geo set tee_lat = p_lat, tee_lng = p_lng, updated_at = now()
     where course_id = cid and hole = p_hole and (tee_lat is null or is_committee());
  else
    update course_hole_geo set green_lat = p_lat, green_lng = p_lng, updated_at = now()
     where course_id = cid and hole = p_hole and (green_lat is null or is_committee());
  end if;
  select * into row from course_hole_geo where course_id = cid and hole = p_hole;
  return row;
end $$;
revoke execute on function map_hole_here(uuid, int, text, double precision, double precision, double precision) from public, anon;
grant execute on function map_hole_here(uuid, int, text, double precision, double precision, double precision) to authenticated;
