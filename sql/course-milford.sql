-- ============================================================
-- Milford Golf Club — White and Yellow tees.
--
-- Taken from the 2020 scorecard listing on thesocialgolfer.com.
-- CHECK AGAINST THE CARD IN THE CLUBHOUSE before relying on it —
-- any hole can be corrected in the app under Courses.
-- Run after sql/live-scoring.sql. Safe to run twice.
-- ============================================================

do $$
declare
  c uuid;
  w uuid;
  y uuid;
begin
  select id into c from courses where name = 'Milford Golf Club';
  if c is null then
    insert into courses (name, address) values ('Milford Golf Club', 'Station Lane, Milford, Godalming GU8 5HS')
    returning id into c;
  end if;

  select id into w from course_tees where course_id = c and name = 'White';
  if w is null then
    insert into course_tees (course_id, name, colour, course_rating, slope)
    values (c, 'White', '#ffffff', 67.8, 122) returning id into w;
  end if;

  select id into y from course_tees where course_id = c and name = 'Yellow';
  if y is null then
    insert into course_tees (course_id, name, colour, course_rating, slope)
    values (c, 'Yellow', '#f2c94c', 65.5, 119) returning id into y;
  end if;

  insert into course_holes (tee_id, hole, par, stroke_index, yards) values
    (w, 1, 4, 10, 313), (w, 2, 3, 16, 169), (w, 3, 4, 18, 293), (w, 4, 5, 2, 472),
    (w, 5, 4, 14, 302), (w, 6, 4, 6, 392), (w, 7, 3, 8, 217), (w, 8, 4, 12, 367),
    (w, 9, 4, 4, 419), (w, 10, 3, 13, 159), (w, 11, 4, 3, 404), (w, 12, 5, 11, 427),
    (w, 13, 3, 5, 235), (w, 14, 4, 17, 343), (w, 15, 3, 9, 151), (w, 16, 4, 1, 362),
    (w, 17, 3, 15, 165), (w, 18, 5, 7, 450),
    (y, 1, 4, 10, 306), (y, 2, 3, 16, 162), (y, 3, 4, 18, 284), (y, 4, 4, 2, 437),
    (y, 5, 4, 14, 279), (y, 6, 4, 6, 363), (y, 7, 3, 8, 191), (y, 8, 4, 12, 335),
    (y, 9, 4, 4, 411), (y, 10, 3, 13, 156), (y, 11, 4, 3, 394), (y, 12, 4, 11, 371),
    (y, 13, 3, 5, 184), (y, 14, 4, 17, 332), (y, 15, 3, 9, 123), (y, 16, 4, 1, 327),
    (y, 17, 3, 15, 139), (y, 18, 5, 7, 448)
  on conflict (tee_id, hole) do nothing;
end $$;
