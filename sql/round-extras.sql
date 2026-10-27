-- ============================================================
-- Round extras: side contests, the live feed, putts & fairways,
-- and front/back of the green.
--
-- Run after sql/round-checkin.sql. Safe to run twice.
-- ============================================================

-- Who can see a round's contests and feed: the players on it, and the
-- committee (and that round's moderators).
create or replace function on_round(p_event uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select can_manage_round(p_event)
      or exists (select 1 from attendance a
                  where a.event_id = p_event and a.status = 'playing'
                    and (a.profile_id = auth.uid()
                         or a.player_id in (select id from players where profile_id = auth.uid())));
$$;
revoke execute on function on_round(uuid) from public, anon;
grant execute on function on_round(uuid) to authenticated;

-- ---------- side contests: the stake on the hole ----------
-- The committee picks the holes on the admin page (events.ld_front_hole
-- and friends). Out on the course, a group names whoever's in front;
-- a later group that beats them adds their player underneath, exactly
-- like writing on the stake. The committee checks the stake and
-- confirms the winner, which goes into event_prizes as before.

create table if not exists contest_claims (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  comp text not null check (comp in ('ld-front','ld-back','np-front','np-back','np2-front','np2-back')),
  player_id uuid not null references players(id) on delete cascade,
  claimed_by uuid references profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists contest_claims_event on contest_claims(event_id, comp, created_at);

alter table contest_claims enable row level security;
drop policy if exists "Round sees the stake" on contest_claims;
create policy "Round sees the stake" on contest_claims for select using (on_round(event_id));
drop policy if exists "Players name who's in front" on contest_claims;
create policy "Players name who's in front" on contest_claims for insert
  with check (can_score_event(event_id) and in_field(event_id, player_id) and claimed_by = auth.uid());
drop policy if exists "Take back your own, or the committee" on contest_claims;
create policy "Take back your own, or the committee" on contest_claims for delete
  using (claimed_by = auth.uid() or can_manage_round(event_id));

-- ---------- the live feed ----------

create table if not exists round_posts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  author_id uuid references profiles(id) on delete set null default auth.uid(),
  kind text not null check (kind in ('text','photo','auto','contest')),
  player_id uuid references players(id) on delete cascade,
  hole integer check (hole between 1 and 18),
  body text check (char_length(body) <= 500),
  photo_path text,
  claim_id uuid references contest_claims(id) on delete cascade,
  auto_key text unique,
  created_at timestamptz not null default now()
);
create index if not exists round_posts_event on round_posts(event_id, created_at desc);

alter table round_posts enable row level security;
drop policy if exists "Round reads the feed" on round_posts;
create policy "Round reads the feed" on round_posts for select using (on_round(event_id));
drop policy if exists "Round posts to the feed" on round_posts;
create policy "Round posts to the feed" on round_posts for insert
  with check (on_round(event_id) and author_id = auth.uid() and kind in ('text','photo')
              and auto_key is null and claim_id is null
              and (kind = 'text' and char_length(coalesce(body, '')) between 1 and 500 or kind = 'photo' and photo_path is not null));
drop policy if exists "Remove your own post, or the committee" on round_posts;
create policy "Remove your own post, or the committee" on round_posts for delete
  using ((author_id = auth.uid() and kind in ('text','photo')) or can_manage_round(event_id));

create table if not exists round_post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references round_posts(id) on delete cascade,
  author_id uuid references profiles(id) on delete set null default auth.uid(),
  body text not null check (char_length(body) between 1 and 300),
  created_at timestamptz not null default now()
);
create index if not exists round_post_comments_post on round_post_comments(post_id, created_at);

create or replace function post_event(p_post uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select event_id from round_posts where id = p_post;
$$;
revoke execute on function post_event(uuid) from public, anon;
grant execute on function post_event(uuid) to authenticated;

alter table round_post_comments enable row level security;
drop policy if exists "Round reads comments" on round_post_comments;
create policy "Round reads comments" on round_post_comments for select using (on_round(post_event(post_id)));
drop policy if exists "Round comments" on round_post_comments;
create policy "Round comments" on round_post_comments for insert
  with check (author_id = auth.uid() and on_round(post_event(post_id)));
drop policy if exists "Remove your own comment, or the committee" on round_post_comments;
create policy "Remove your own comment, or the committee" on round_post_comments for delete
  using (author_id = auth.uid() or can_manage_round(post_event(post_id)));

create table if not exists round_post_likes (
  post_id uuid not null references round_posts(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (post_id, profile_id)
);
alter table round_post_likes enable row level security;
drop policy if exists "Round sees likes" on round_post_likes;
create policy "Round sees likes" on round_post_likes for select using (on_round(post_event(post_id)));
drop policy if exists "Like a post" on round_post_likes;
create policy "Like a post" on round_post_likes for insert
  with check (profile_id = auth.uid() and on_round(post_event(post_id)));
drop policy if exists "Unlike a post" on round_post_likes;
create policy "Unlike a post" on round_post_likes for delete using (profile_id = auth.uid());

-- Birdies and better post themselves. If the score changes (or turns
-- out to be disputed) the post changes or goes with it.
create or replace function hole_score_feed()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  rec hole_scores%rowtype;
  par integer;
  key text;
  label text;
begin
  if tg_op = 'DELETE' then rec := old; else rec := new; end if;
  key := 'score:' || rec.event_id || ':' || rec.player_id || ':' || rec.hole;
  if tg_op = 'DELETE' then
    delete from round_posts where auto_key = key;
    return old;
  end if;
  select h.par into par from event_scoring s
    join course_holes h on h.tee_id = s.tee_id and h.hole = rec.hole
   where s.event_id = rec.event_id;
  if par is null or rec.picked_up or rec.strokes is null or coalesce(rec.disputed, false) or rec.strokes > par - 1 then
    delete from round_posts where auto_key = key;
    return new;
  end if;
  label := case when rec.strokes = 1 then 'Hole in one'
                when rec.strokes <= par - 3 then 'Albatross'
                when rec.strokes = par - 2 then 'Eagle'
                else 'Birdie' end;
  insert into round_posts (event_id, author_id, kind, player_id, hole, body, auto_key)
  values (rec.event_id, null, 'auto', rec.player_id, rec.hole, label || '|' || rec.strokes, key)
  on conflict (auto_key) do update set body = excluded.body;
  return new;
end;
$$;
revoke execute on function hole_score_feed() from public, anon, authenticated;
drop trigger if exists hole_scores_feed on hole_scores;
create trigger hole_scores_feed after insert or update or delete on hole_scores
  for each row execute function hole_score_feed();

-- A name on the stake goes in the feed too.
create or replace function contest_claim_feed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into round_posts (event_id, author_id, kind, player_id, body, claim_id, auto_key)
  values (new.event_id, new.claimed_by, 'contest', new.player_id, new.comp, new.id, 'claim:' || new.id)
  on conflict (auto_key) do nothing;
  return new;
end;
$$;
revoke execute on function contest_claim_feed() from public, anon, authenticated;
drop trigger if exists contest_claims_feed on contest_claims;
create trigger contest_claims_feed after insert on contest_claims
  for each row execute function contest_claim_feed();

-- ---------- putts & fairways (optional) ----------

create table if not exists hole_stats (
  event_id uuid not null references events(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  hole integer not null check (hole between 1 and 18),
  putts smallint check (putts between 0 and 10),
  fairway text check (fairway in ('hit','left','right')),
  entered_by uuid references profiles(id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (event_id, player_id, hole)
);
alter table hole_stats enable row level security;
drop policy if exists "Members read stats" on hole_stats;
create policy "Members read stats" on hole_stats for select using (is_approved_member());
drop policy if exists "Scorers add stats" on hole_stats;
create policy "Scorers add stats" on hole_stats for insert
  with check (can_score_event(event_id) and in_field(event_id, player_id) and entered_by = auth.uid());
drop policy if exists "Scorers change stats" on hole_stats;
create policy "Scorers change stats" on hole_stats for update
  using (can_score_event(event_id) and in_field(event_id, player_id))
  with check (can_score_event(event_id) and in_field(event_id, player_id) and entered_by = auth.uid());
drop policy if exists "Scorers clear stats" on hole_stats;
create policy "Scorers clear stats" on hole_stats for delete
  using (can_score_event(event_id) and in_field(event_id, player_id));

-- ---------- front and back of the green ----------

alter table course_hole_geo add column if not exists front_lat double precision;
alter table course_hole_geo add column if not exists front_lng double precision;
alter table course_hole_geo add column if not exists back_lat double precision;
alter table course_hole_geo add column if not exists back_lng double precision;

-- ---------- live updates ----------

do $$
declare t text;
begin
  foreach t in array array['contest_claims','round_posts','round_post_comments','round_post_likes','hole_stats'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;
