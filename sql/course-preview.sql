-- ============================================================
-- Course Preview: playing notes and the society's hole averages.
--
-- Run after sql/equipment.sql. Safe to run twice.
--
-- course_notes: tips members leave for a course, or for one hole of
-- it. Every member reads them; you add your own and can delete your
-- own (the committee can delete any).
--
-- course_hole_averages(course): how the society scores on each hole,
-- from society rounds only (never private games or practice rounds).
-- Pick-ups are left out.
-- ============================================================

create table if not exists course_notes (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses(id) on delete cascade,
  hole integer check (hole is null or hole between 1 and 18),
  body text not null check (length(btrim(body)) between 1 and 300),
  author_id uuid not null default auth.uid() references profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists course_notes_course on course_notes(course_id);

alter table course_notes enable row level security;
drop policy if exists "Members read notes" on course_notes;
create policy "Members read notes" on course_notes for select using (is_approved_member());
drop policy if exists "Members add notes" on course_notes;
create policy "Members add notes" on course_notes for insert
  with check (is_approved_member() and author_id = auth.uid());
drop policy if exists "Authors delete notes" on course_notes;
create policy "Authors delete notes" on course_notes for delete
  using (author_id = auth.uid() or is_committee());

create or replace function course_hole_averages(p_course uuid)
returns table (hole integer, cards integer, rounds integer, avg_strokes numeric, over_par numeric)
language sql stable security definer set search_path = public as $$
  select hs.hole, count(*)::int, count(distinct hs.event_id)::int,
         round(avg(hs.strokes)::numeric, 2), round(avg(hs.strokes - ch.par)::numeric, 2)
  from hole_scores hs
  join event_scoring es on es.event_id = hs.event_id
  join course_tees t on t.id = es.tee_id and t.course_id = p_course
  join course_holes ch on ch.tee_id = es.tee_id and ch.hole = hs.hole
  join events e on e.id = hs.event_id
  where is_approved_member()
    and hs.strokes is not null and not hs.picked_up
    and not coalesce(e.is_private, false) and not coalesce(e.is_practice, false)
  group by hs.hole
$$;
revoke execute on function course_hole_averages(uuid) from public, anon;
grant execute on function course_hole_averages(uuid) to authenticated;
