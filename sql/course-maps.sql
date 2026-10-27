-- ============================================================
-- Hole maps for the scoring app: where each tee and green is.
--
-- Run AFTER sql/live-scoring.sql. Safe to run twice.
--
-- One tee pin and one green-centre pin per hole, per course (shared by
-- every tee colour — the yellow and white tees are close enough for a
-- yardage to the middle of the green). The committee places them once,
-- in the app under Courses → Map the holes, or imports them from
-- OpenStreetMap where the course has been drawn there. Players' own
-- locations are never sent or stored: distances are worked out on the
-- phone.
-- ============================================================

alter table courses add column if not exists lat double precision;
alter table courses add column if not exists lng double precision;

create table if not exists course_hole_geo (
  course_id uuid not null references courses(id) on delete cascade,
  hole integer not null check (hole between 1 and 18),
  tee_lat double precision check (tee_lat is null or tee_lat between -90 and 90),
  tee_lng double precision check (tee_lng is null or tee_lng between -180 and 180),
  green_lat double precision check (green_lat is null or green_lat between -90 and 90),
  green_lng double precision check (green_lng is null or green_lng between -180 and 180),
  updated_at timestamptz not null default now(),
  primary key (course_id, hole)
);

alter table course_hole_geo enable row level security;

drop policy if exists "Anyone can read hole maps" on course_hole_geo;
create policy "Anyone can read hole maps" on course_hole_geo for select using (true);
drop policy if exists "Committee maps holes" on course_hole_geo;
create policy "Committee maps holes" on course_hole_geo for all using (is_committee()) with check (is_committee());
