-- ============================================================
-- Notification choices, the list behind the number on the app icon,
-- and the triggers that tell the push function about Clubhouse activity.
--
-- Run after sql/clubhouse.sql. Safe to run twice.
--
-- Four kinds, each on or off per member:
--   messages   direct messages and group chats
--   feed       new posts, comments and likes on your posts, birthdays
--   rounds     round live, results, disputes, entries closing, reminders
--   committee  (committee only) something's been reported
-- Every notification sent is written to `notifications`. The number on
-- the app icon is how many have arrived since the member last opened
-- the app; opening it clears them.
-- ============================================================

create table if not exists notification_prefs (
  profile_id uuid primary key references profiles(id) on delete cascade,
  messages boolean not null default true,
  feed boolean not null default true,
  rounds boolean not null default true,
  committee boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table notification_prefs enable row level security;
drop policy if exists "Your own notification choices" on notification_prefs;
create policy "Your own notification choices" on notification_prefs for select using (profile_id = auth.uid());
drop policy if exists "Set your own notification choices" on notification_prefs;
create policy "Set your own notification choices" on notification_prefs for insert with check (profile_id = auth.uid());
drop policy if exists "Change your own notification choices" on notification_prefs;
create policy "Change your own notification choices" on notification_prefs for update using (profile_id = auth.uid()) with check (profile_id = auth.uid());

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  kind text not null check (kind in ('messages', 'feed', 'rounds', 'committee')),
  title text not null,
  body text,
  url text,
  created_at timestamptz not null default now(),
  seen_at timestamptz
);
create index if not exists notifications_unseen on notifications(profile_id) where seen_at is null;
create index if not exists notifications_recent on notifications(created_at);
alter table notifications enable row level security;
drop policy if exists "Your own notifications" on notifications;
create policy "Your own notifications" on notifications for select using (profile_id = auth.uid());

-- Opening the app clears the number.
create or replace function mark_notifications_seen()
returns void language sql security definer set search_path = public as $$
  update notifications set seen_at = now() where profile_id = auth.uid() and seen_at is null;
  delete from notifications where created_at < now() - interval '60 days';
$$;
revoke execute on function mark_notifications_seen() from public, anon;
grant execute on function mark_notifications_seen() to authenticated;

-- ---------- telling the push function ----------
create or replace function clubhouse_push()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'chat_messages' then
    perform notify_push(jsonb_build_object('type', 'message', 'id', new.id));
  elsif tg_table_name = 'club_posts' then
    perform notify_push(jsonb_build_object('type', case when new.kind = 'birthday' then 'birthday' else 'club_post' end, 'id', new.id));
  elsif tg_table_name = 'club_comments' then
    perform notify_push(jsonb_build_object('type', 'club_comment', 'id', new.id));
  elsif tg_table_name = 'club_likes' then
    perform notify_push(jsonb_build_object('type', 'club_like', 'id', new.post_id, 'by', new.profile_id));
  elsif tg_table_name = 'club_reports' then
    perform notify_push(jsonb_build_object('type', 'report', 'id', new.id));
  end if;
  return new;
end $$;
revoke execute on function clubhouse_push() from public, anon, authenticated;

do $$ declare t text; begin
  foreach t in array array['chat_messages', 'club_posts', 'club_comments', 'club_likes', 'club_reports'] loop
    execute format('drop trigger if exists clubhouse_push on %I', t);
    execute format('create trigger clubhouse_push after insert on %I for each row execute function clubhouse_push()', t);
  end loop;
end $$;
