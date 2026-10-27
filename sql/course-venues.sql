-- ============================================================
-- Society venues — Hurtmore, Clandon Golf, Tylney Park.
--
-- Taken from published scorecard listings (thesocialgolfer.com,
-- stymie, tylneypark.co.uk). CHECK AGAINST THE CARD IN THE
-- CLUBHOUSE — any hole, rating or slope can be corrected in the app
-- under Courses. Run after sql/live-scoring.sql. Safe to run twice:
-- an existing tee is left alone, so corrections made in the app
-- are never overwritten.
--
-- Tylney Park's course rating and slope weren't published anywhere
-- reachable, so they're blank: add them from the card in the app,
-- or the handicaps there use slope 113 with no rating adjustment.
-- ============================================================

create or replace function pg_temp.seed_tee(
  p_course text, p_address text, p_tee text, p_colour text,
  p_rating numeric, p_slope integer,
  p_pars integer[], p_sis integer[], p_yards integer[]
) returns void language plpgsql as $$
declare
  c uuid;
  t uuid;
begin
  select id into c from courses where name = p_course;
  if c is null then
    insert into courses (name, address) values (p_course, p_address) returning id into c;
  end if;
  select id into t from course_tees where course_id = c and name = p_tee;
  if t is not null then return; end if;
  insert into course_tees (course_id, name, colour, course_rating, slope)
  values (c, p_tee, p_colour, p_rating, p_slope) returning id into t;
  insert into course_holes (tee_id, hole, par, stroke_index, yards)
  select t, i, p_pars[i], p_sis[i], p_yards[i] from generate_series(1, 18) i;
end;
$$;

-- Hurtmore Golf Club (par 70)
-- Hurtmore's nines were swapped at some point; this is the current
-- order (hole 2 is a par 4), confirmed by the committee Oct 2026 and
-- matching stymie.golf and the hole layout on OpenStreetMap.
select pg_temp.seed_tee('Hurtmore Golf Club', 'Hurtmore Rd, Godalming GU7 2RN', 'Yellow', '#f2c94c', 65.8, 112,
  array[4,4,4,4,4,5,3,4,4, 4,3,4,4,3,4,4,4,4],
  array[10,14,4,16,12,2,8,18,6, 11,7,1,15,9,3,13,17,5],
  array[321,256,359,303,289,514,125,221,321, 313,176,432,223,118,348,271,245,356]);
select pg_temp.seed_tee('Hurtmore Golf Club', 'Hurtmore Rd, Godalming GU7 2RN', 'White', '#ffffff', 66.7, 119,
  array[4,4,4,4,4,5,3,4,4, 4,3,4,4,3,4,4,4,4],
  array[10,14,4,16,12,2,8,18,6, 11,7,1,15,9,3,13,17,5],
  array[335,271,372,309,320,532,154,228,343, 338,183,439,232,132,358,310,286,392]);

-- Clandon Golf, Merrow (par 69) — the Epsom Rd GU4 7AA course, not Clandon Regis
select pg_temp.seed_tee('Clandon Golf Club', 'Epsom Rd, Guildford, Surrey GU4 7AA', 'Yellow', '#f2c94c', 67.5, 114,
  array[4,3,4,4,4,5,3,4,4, 4,4,3,5,3,4,3,4,4],
  array[16,18,14,4,12,6,10,8,2, 9,3,17,5,13,1,11,15,7],
  array[319,159,308,338,350,562,163,334,406, 341,397,129,528,145,399,161,287,346]);

-- Tylney Park Golf Club (par 72) — rating and slope to add from the card
select pg_temp.seed_tee('Tylney Park Golf Club', 'The St, Rotherwick, Hook RG27 9AY', 'Yellow', '#f2c94c', null, null,
  array[5,4,4,4,3,4,4,3,5, 4,5,4,3,5,4,4,3,4],
  array[12,8,4,14,10,16,2,18,6, 3,15,5,9,1,13,7,17,11],
  array[489,366,421,319,206,306,353,152,486, 420,468,398,151,495,361,396,152,313]);
select pg_temp.seed_tee('Tylney Park Golf Club', 'The St, Rotherwick, Hook RG27 9AY', 'White', '#ffffff', null, null,
  array[5,4,4,4,3,4,4,3,5, 4,5,4,3,5,4,4,3,4],
  array[12,8,4,14,10,16,2,18,6, 3,15,5,9,1,13,7,17,11],
  array[525,378,430,327,217,343,386,184,496, 432,478,410,191,519,405,402,162,317]);
