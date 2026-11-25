-- ============================================================
-- Hole guides: how each hole plays, shown in the app when a group
-- moves on to a new hole. Members read; the committee writes (also
-- from the app's hole guide). Clandon's 18 were written from reviews.
-- Also: attendance.buggy (golf buggy marker, committee-only).
-- Safe to run twice.
-- ============================================================
create table if not exists course_hole_guides (
  course_id uuid not null references courses(id) on delete cascade,
  hole integer not null check (hole between 1 and 18),
  guide text not null default '',
  hazards text[] not null default '{}',
  source text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (course_id, hole)
);
alter table course_hole_guides enable row level security;
drop policy if exists "Members read hole guides" on course_hole_guides;
create policy "Members read hole guides" on course_hole_guides for select to authenticated using (true);
drop policy if exists "Committee writes hole guides" on course_hole_guides;
create policy "Committee writes hole guides" on course_hole_guides for all to authenticated using (is_committee()) with check (is_committee());

alter table attendance add column if not exists buggy boolean not null default false;
grant select (buggy) on attendance to anon, authenticated;
