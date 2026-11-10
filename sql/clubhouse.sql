-- ============================================================
-- The Clubhouse: members' contact details, a society feed with
-- birthday posts, direct messages and group chats.
--
-- Run after sql/game-formats.sql. Safe to run twice.
--
-- Privacy
--   member_details is private to its owner and the committee. Other
--   members only ever see it through member_card(), which hands back
--   just the details the owner has shared with members. A date of birth
--   is only ever shown to members as a day and month, never the year.
--   Direct messages and group chats are readable by the people in them
--   and nobody else, committee included; a message someone reports is
--   copied into the report so the committee can deal with it.
-- ============================================================

-- ---------- contact details ----------
create table if not exists member_details (
  profile_id uuid primary key references profiles(id) on delete cascade,
  phone text check (phone is null or char_length(phone) <= 30),
  email text check (email is null or char_length(email) <= 200),
  dob date check (dob is null or dob >= date '1900-01-01'),
  address text check (address is null or char_length(address) <= 300),
  phone_vis text not null default 'me' check (phone_vis in ('me', 'members')),
  email_vis text not null default 'me' check (email_vis in ('me', 'members')),
  dob_vis text not null default 'me' check (dob_vis in ('me', 'members')),
  address_vis text not null default 'me' check (address_vis in ('me', 'members')),
  birthday_post boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table member_details enable row level security;
drop policy if exists "Own details, or the committee" on member_details;
create policy "Own details, or the committee" on member_details for select
  using (profile_id = auth.uid() or is_committee());
drop policy if exists "Members keep their own details" on member_details;
create policy "Members keep their own details" on member_details for insert
  with check (profile_id = auth.uid() and is_approved_member());
drop policy if exists "Members change their own details" on member_details;
create policy "Members change their own details" on member_details for update
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
drop policy if exists "Members remove their own details" on member_details;
create policy "Members remove their own details" on member_details for delete
  using (profile_id = auth.uid());

-- What one member can see of another's details. Yourself and the
-- committee: everything. Other members: what's been shared, and a
-- birthday as day and month only.
create or replace function member_card(p_profile uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d member_details%rowtype; full_view boolean;
begin
  if not is_approved_member() then return null; end if;
  select * into d from member_details where profile_id = p_profile;
  if not found then return '{}'::jsonb; end if;
  full_view := p_profile = auth.uid() or is_committee();
  return jsonb_strip_nulls(jsonb_build_object(
    'phone', case when full_view or d.phone_vis = 'members' then d.phone end,
    'email', case when full_view or d.email_vis = 'members' then d.email end,
    'address', case when full_view or d.address_vis = 'members' then d.address end,
    'dob', case when full_view then d.dob::text end,
    'birthday', case when (full_view or d.dob_vis = 'members') and d.dob is not null then to_char(d.dob, 'FMDD FMMonth') end,
    'full', full_view));
end $$;
revoke execute on function member_card(uuid) from public, anon;
grant execute on function member_card(uuid) to authenticated;

-- A birthday falls today (29 February birthdays on the 28th in other years).
create or replace function is_birthday(p_dob date, p_day date)
returns boolean language sql immutable as $$
  select p_dob is not null and (
    (extract(month from p_dob) = extract(month from p_day) and extract(day from p_dob) = extract(day from p_day))
    or (extract(month from p_dob) = 2 and extract(day from p_dob) = 29 and extract(month from p_day) = 2 and extract(day from p_day) = 28
        and not (extract(year from p_day)::int % 4 = 0 and (extract(year from p_day)::int % 100 <> 0 or extract(year from p_day)::int % 400 = 0))))
$$;

-- ---------- the society feed ----------
create table if not exists club_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references profiles(id) on delete set null default auth.uid(),
  kind text not null default 'post' check (kind in ('post', 'birthday')),
  body text check (body is null or char_length(body) <= 2000),
  photo_paths text[] not null default '{}' check (cardinality(photo_paths) <= 4),
  birthday_of uuid references profiles(id) on delete cascade,
  birthday_year integer,
  hidden boolean not null default false,
  hidden_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (birthday_of, birthday_year),
  check (kind = 'birthday' or body is not null or cardinality(photo_paths) > 0)
);
create index if not exists club_posts_recent on club_posts(created_at desc);

create table if not exists club_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references club_posts(id) on delete cascade,
  author_id uuid references profiles(id) on delete set null default auth.uid(),
  body text not null check (char_length(body) between 1 and 1000),
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists club_comments_post on club_comments(post_id, created_at);

create table if not exists club_likes (
  post_id uuid not null references club_posts(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (post_id, profile_id)
);

create table if not exists club_reports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('post', 'comment', 'message')),
  target_id uuid not null,
  reporter uuid references profiles(id) on delete set null default auth.uid(),
  about uuid references profiles(id) on delete set null,
  reason text check (reason is null or char_length(reason) <= 300),
  snapshot text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references profiles(id) on delete set null
);

create table if not exists club_mutes (
  profile_id uuid primary key references profiles(id) on delete cascade,
  muted_until timestamptz,
  muted_by uuid references profiles(id) on delete set null,
  reason text,
  created_at timestamptz not null default now()
);

create or replace function is_muted()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from club_mutes where profile_id = auth.uid() and (muted_until is null or muted_until > now()))
$$;
revoke execute on function is_muted() from public, anon;
grant execute on function is_muted() to authenticated;

alter table club_posts enable row level security;
alter table club_comments enable row level security;
alter table club_likes enable row level security;
alter table club_reports enable row level security;
alter table club_mutes enable row level security;

drop policy if exists "Members read the feed" on club_posts;
create policy "Members read the feed" on club_posts for select
  using (is_approved_member() and (not hidden or is_committee() or author_id = auth.uid()));
drop policy if exists "Members post" on club_posts;
create policy "Members post" on club_posts for insert
  with check (is_approved_member() and author_id = auth.uid() and kind = 'post' and birthday_of is null and not hidden and not is_muted());
drop policy if exists "Remove your own, or the committee" on club_posts;
create policy "Remove your own, or the committee" on club_posts for delete
  using (author_id = auth.uid() or is_committee());

drop policy if exists "Members read comments" on club_comments;
create policy "Members read comments" on club_comments for select
  using (is_approved_member() and (not hidden or is_committee() or author_id = auth.uid()));
drop policy if exists "Members comment" on club_comments;
create policy "Members comment" on club_comments for insert
  with check (is_approved_member() and author_id = auth.uid() and not hidden and not is_muted()
              and exists (select 1 from club_posts p where p.id = post_id and not p.hidden));
drop policy if exists "Remove your own comment, or the committee" on club_comments;
create policy "Remove your own comment, or the committee" on club_comments for delete
  using (author_id = auth.uid() or is_committee());

drop policy if exists "Members see likes" on club_likes;
create policy "Members see likes" on club_likes for select using (is_approved_member());
drop policy if exists "Members like" on club_likes;
create policy "Members like" on club_likes for insert with check (is_approved_member() and profile_id = auth.uid());
drop policy if exists "Members unlike" on club_likes;
create policy "Members unlike" on club_likes for delete using (profile_id = auth.uid());

drop policy if exists "Committee reads reports" on club_reports;
create policy "Committee reads reports" on club_reports for select using (is_committee() or reporter = auth.uid());
drop policy if exists "Committee sees mutes" on club_mutes;
create policy "Committee sees mutes" on club_mutes for select using (is_committee() or profile_id = auth.uid());

-- Report a post, a comment or a message. The words are copied into the
-- report, so the committee can see what was said without being able to
-- read anyone's chats.
create or replace function report_item(p_kind text, p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare who uuid; words text;
begin
  if not is_approved_member() then raise exception 'Members only.'; end if;
  if p_kind = 'post' then
    select author_id, coalesce(body, '(photo)') into who, words from club_posts where id = p_id;
  elsif p_kind = 'comment' then
    select author_id, body into who, words from club_comments where id = p_id;
  elsif p_kind = 'message' then
    select m.author_id, coalesce(m.body, '(photo)') into who, words from chat_messages m
    where m.id = p_id and exists (select 1 from chat_members cm where cm.chat_id = m.chat_id and cm.profile_id = auth.uid());
  else raise exception 'Nothing to report.';
  end if;
  if not found then raise exception 'That''s gone already.'; end if;
  insert into club_reports (kind, target_id, about, reason, snapshot)
  values (p_kind, p_id, who, left(nullif(trim(p_reason), ''), 300), left(words, 2000));
end $$;
revoke execute on function report_item(text, uuid, text) from public, anon;
grant execute on function report_item(text, uuid, text) to authenticated;

-- Committee: hide or show a post or comment, close a report, mute someone.
create or replace function moderate(p_kind text, p_id uuid, p_hide boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_committee() then raise exception 'Committee only.'; end if;
  if p_kind = 'post' then update club_posts set hidden = p_hide, hidden_by = case when p_hide then auth.uid() end where id = p_id;
  elsif p_kind = 'comment' then update club_comments set hidden = p_hide where id = p_id;
  else raise exception 'Nothing to change.';
  end if;
  update club_reports set resolved_at = now(), resolved_by = auth.uid() where target_id = p_id and resolved_at is null and p_hide;
end $$;
revoke execute on function moderate(text, uuid, boolean) from public, anon;
grant execute on function moderate(text, uuid, boolean) to authenticated;

create or replace function resolve_report(p_report uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_committee() then raise exception 'Committee only.'; end if;
  update club_reports set resolved_at = now(), resolved_by = auth.uid() where id = p_report;
end $$;
revoke execute on function resolve_report(uuid) from public, anon;
grant execute on function resolve_report(uuid) to authenticated;

-- p_days: null to lift a mute, 0 for until lifted, otherwise days.
create or replace function mute_member(p_profile uuid, p_days integer, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_committee() then raise exception 'Committee only.'; end if;
  if p_profile = auth.uid() then raise exception 'You can''t mute yourself.'; end if;
  if p_days is null then delete from club_mutes where profile_id = p_profile; return; end if;
  insert into club_mutes (profile_id, muted_until, muted_by, reason)
  values (p_profile, case when p_days > 0 then now() + make_interval(days => p_days) end, auth.uid(), left(p_reason, 300))
  on conflict (profile_id) do update set muted_until = excluded.muted_until, muted_by = excluded.muted_by, reason = excluded.reason, created_at = now();
end $$;
revoke execute on function mute_member(uuid, integer, text) from public, anon;
grant execute on function mute_member(uuid, integer, text) to authenticated;

-- ---------- birthdays ----------
-- Members with a birthday today who are happy for it to be posted.
create or replace function birthdays_today()
returns table (profile_id uuid, display_name text, avatar_url text)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, p.avatar_url
  from member_details d
  join profiles p on p.id = d.profile_id
  join memberships m on m.profile_id = d.profile_id and m.status = 'approved'
  where d.birthday_post and is_birthday(d.dob, (now() at time zone 'Europe/London')::date) and is_approved_member()
  order by p.display_name
$$;
revoke execute on function birthdays_today() from public, anon;
grant execute on function birthdays_today() to authenticated;

-- Run each morning (pg_cron, below): one birthday post per member per
-- year. The app also calls it, so the post is there even if the morning
-- job hasn't run yet. It only ever adds today's posts.
create or replace function make_birthday_posts()
returns integer language plpgsql security definer set search_path = public as $$
declare today date := (now() at time zone 'Europe/London')::date; n integer;
begin
  insert into club_posts (author_id, kind, birthday_of, birthday_year, created_at)
  select null, 'birthday', d.profile_id, extract(year from today)::int, now()
  from member_details d
  join memberships m on m.profile_id = d.profile_id and m.status = 'approved'
  where d.birthday_post and is_birthday(d.dob, today)
  on conflict (birthday_of, birthday_year) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function make_birthday_posts() from public, anon;
grant execute on function make_birthday_posts() to authenticated;

-- ---------- direct messages and group chats ----------
create table if not exists chats (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('direct', 'group')),
  name text check (name is null or char_length(name) between 1 and 60),
  direct_key text unique,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create table if not exists chat_members (
  chat_id uuid not null references chats(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  last_read_at timestamptz not null default now(),
  muted boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (chat_id, profile_id)
);
create index if not exists chat_members_profile on chat_members(profile_id);
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats(id) on delete cascade,
  author_id uuid references profiles(id) on delete set null default auth.uid(),
  body text check (body is null or char_length(body) <= 2000),
  photo_path text,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  check (deleted or body is not null or photo_path is not null)
);
create index if not exists chat_messages_chat on chat_messages(chat_id, created_at desc);

create or replace function in_chat(p_chat uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from chat_members where chat_id = p_chat and profile_id = auth.uid())
$$;
revoke execute on function in_chat(uuid) from public, anon;
grant execute on function in_chat(uuid) to authenticated;

alter table chats enable row level security;
alter table chat_members enable row level security;
alter table chat_messages enable row level security;

drop policy if exists "People in the chat" on chats;
create policy "People in the chat" on chats for select using (in_chat(id));
drop policy if exists "People in the chat see who's in it" on chat_members;
create policy "People in the chat see who's in it" on chat_members for select using (in_chat(chat_id));
drop policy if exists "Your own read marker and mute" on chat_members;
create policy "Your own read marker and mute" on chat_members for update
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
drop policy if exists "People in the chat read it" on chat_messages;
create policy "People in the chat read it" on chat_messages for select using (in_chat(chat_id));
drop policy if exists "People in the chat write" on chat_messages;
create policy "People in the chat write" on chat_messages for insert
  with check (author_id = auth.uid() and in_chat(chat_id) and is_approved_member() and not deleted and not is_muted());

-- A member can only change their read marker and mute, not their role.
create or replace function chat_member_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('falkners.chat_admin', true) = 'on' then return new; end if;
  if new.chat_id <> old.chat_id or new.profile_id <> old.profile_id or new.role <> old.role or new.joined_at <> old.joined_at then
    raise exception 'Only the read marker and mute can change.';
  end if;
  return new;
end $$;
revoke execute on function chat_member_guard() from public, anon, authenticated;
drop trigger if exists chat_member_guard on chat_members;
create trigger chat_member_guard before update on chat_members for each row execute function chat_member_guard();

create or replace function chat_message_touch()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update chats set last_message_at = new.created_at where id = new.chat_id;
  update chat_members set last_read_at = greatest(last_read_at, new.created_at)
  where chat_id = new.chat_id and profile_id = new.author_id;
  return new;
end $$;
revoke execute on function chat_message_touch() from public, anon, authenticated;
drop trigger if exists chat_message_touch on chat_messages;
create trigger chat_message_touch after insert on chat_messages for each row execute function chat_message_touch();

create or replace function approved(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships where profile_id = p and status = 'approved')
$$;
revoke execute on function approved(uuid) from public, anon;

-- Open (or find) the one-to-one chat with another member.
create or replace function start_direct_chat(p_other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare k text; c uuid;
begin
  if not is_approved_member() then raise exception 'Members only.'; end if;
  if p_other = auth.uid() then raise exception 'That''s you.'; end if;
  if not approved(p_other) then raise exception 'They''re not a member.'; end if;
  k := least(auth.uid()::text, p_other::text) || ':' || greatest(auth.uid()::text, p_other::text);
  select id into c from chats where direct_key = k;
  if c is null then
    insert into chats (kind, direct_key, created_by) values ('direct', k, auth.uid())
    on conflict (direct_key) do nothing returning id into c;
    if c is null then select id into c from chats where direct_key = k; end if;
    insert into chat_members (chat_id, profile_id, role) values (c, auth.uid(), 'member'), (c, p_other, 'member') on conflict do nothing;
  end if;
  return c;
end $$;
revoke execute on function start_direct_chat(uuid) from public, anon;
grant execute on function start_direct_chat(uuid) to authenticated;

-- A group: you plus the members you pick (up to 50 in all).
create or replace function create_group_chat(p_name text, p_members uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare c uuid; ids uuid[];
begin
  if not is_approved_member() then raise exception 'Members only.'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the group a name.'; end if;
  ids := array(select distinct x from unnest(coalesce(p_members, '{}')) x where x <> auth.uid() and approved(x));
  if cardinality(ids) < 1 then raise exception 'Add at least one other member.'; end if;
  if cardinality(ids) > 49 then raise exception 'Up to 50 in a group.'; end if;
  insert into chats (kind, name, created_by) values ('group', left(trim(p_name), 60), auth.uid()) returning id into c;
  insert into chat_members (chat_id, profile_id, role) values (c, auth.uid(), 'owner');
  insert into chat_members (chat_id, profile_id) select c, x from unnest(ids) x;
  return c;
end $$;
revoke execute on function create_group_chat(text, uuid[]) from public, anon;
grant execute on function create_group_chat(text, uuid[]) to authenticated;

-- Group owner: add people, rename. Anyone: leave. Owner: remove people.
create or replace function add_to_group(p_chat uuid, p_members uuid[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from chat_members cm join chats c on c.id = cm.chat_id
                 where cm.chat_id = p_chat and cm.profile_id = auth.uid() and cm.role = 'owner' and c.kind = 'group') then
    raise exception 'Only the group''s owner can add people.';
  end if;
  insert into chat_members (chat_id, profile_id)
  select p_chat, x from unnest(p_members) x where approved(x) on conflict do nothing;
  if (select count(*) from chat_members where chat_id = p_chat) > 50 then raise exception 'Up to 50 in a group.'; end if;
end $$;
revoke execute on function add_to_group(uuid, uuid[]) from public, anon;
grant execute on function add_to_group(uuid, uuid[]) to authenticated;

create or replace function rename_group(p_chat uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the group a name.'; end if;
  update chats set name = left(trim(p_name), 60) where id = p_chat and kind = 'group'
    and exists (select 1 from chat_members where chat_id = p_chat and profile_id = auth.uid() and role = 'owner');
  if not found then raise exception 'Only the group''s owner can rename it.'; end if;
end $$;
revoke execute on function rename_group(uuid, text) from public, anon;
grant execute on function rename_group(uuid, text) to authenticated;

create or replace function leave_chat(p_chat uuid, p_member uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare who uuid := coalesce(p_member, auth.uid()); k text;
begin
  select kind into k from chats where id = p_chat;
  if k is distinct from 'group' then raise exception 'You can only leave a group.'; end if;
  if who <> auth.uid() and not exists (select 1 from chat_members where chat_id = p_chat and profile_id = auth.uid() and role = 'owner') then
    raise exception 'Only the group''s owner can remove people.';
  end if;
  delete from chat_members where chat_id = p_chat and profile_id = who;
  -- The owner left: hand the group to whoever's been in it longest.
  if not exists (select 1 from chat_members where chat_id = p_chat and role = 'owner') then
    perform set_config('falkners.chat_admin', 'on', true);
    update chat_members set role = 'owner'
    where chat_id = p_chat and profile_id = (select profile_id from chat_members where chat_id = p_chat order by joined_at limit 1);
    perform set_config('falkners.chat_admin', 'off', true);
  end if;
  if not exists (select 1 from chat_members where chat_id = p_chat) then delete from chats where id = p_chat; end if;
end $$;
revoke execute on function leave_chat(uuid, uuid) from public, anon;
grant execute on function leave_chat(uuid, uuid) to authenticated;

create or replace function delete_message(p_message uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update chat_messages set deleted = true, body = null, photo_path = null where id = p_message and author_id = auth.uid();
  if not found then raise exception 'You can only delete your own messages.'; end if;
end $$;
revoke execute on function delete_message(uuid) from public, anon;
grant execute on function delete_message(uuid) to authenticated;

-- Your chats, newest first, with who's in them, the last message and
-- how many you haven't read.
create or replace function my_chats()
returns table (id uuid, kind text, name text, last_message_at timestamptz, unread integer, muted boolean, role text,
               members jsonb, last_body text, last_author uuid, last_photo boolean, last_deleted boolean)
language sql stable security definer set search_path = public as $$
  select c.id, c.kind, c.name, c.last_message_at,
    (select count(*)::int from chat_messages m where m.chat_id = c.id and m.created_at > me.last_read_at and m.author_id is distinct from auth.uid()),
    me.muted, me.role,
    (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'avatar', p.avatar_url, 'role', cm.role) order by p.display_name), '[]')
       from chat_members cm join profiles p on p.id = cm.profile_id where cm.chat_id = c.id),
    l.body, l.author_id, l.photo_path is not null, coalesce(l.deleted, false)
  from chat_members me
  join chats c on c.id = me.chat_id
  left join lateral (select * from chat_messages m where m.chat_id = c.id order by m.created_at desc limit 1) l on true
  where me.profile_id = auth.uid()
  order by c.last_message_at desc
$$;
revoke execute on function my_chats() from public, anon;
grant execute on function my_chats() to authenticated;

-- ---------- photos ----------
-- A private bucket. Feed photos: any member. Chat photos: the people in
-- that chat. The app shows them with short-lived signed links.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clubhouse', 'clubhouse', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function clubhouse_path_ok(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(p_name, '/');
begin
  if not is_approved_member() then return false; end if;
  -- Thumbnails sit under thumbs/ with the same path as the photo.
  if parts[1] = 'thumbs' then parts := parts[2:]; end if;
  if parts[1] = 'feed' then return true; end if;
  if parts[1] = 'chat' and parts[2] ~ '^[0-9a-f-]{36}$' then return in_chat(parts[2]::uuid); end if;
  return false;
end $$;
revoke execute on function clubhouse_path_ok(text) from public, anon;
grant execute on function clubhouse_path_ok(text) to authenticated;

drop policy if exists "Clubhouse photos: members who can see them" on storage.objects;
create policy "Clubhouse photos: members who can see them" on storage.objects for select
  using (bucket_id = 'clubhouse' and clubhouse_path_ok(name));
drop policy if exists "Clubhouse photos: members add" on storage.objects;
create policy "Clubhouse photos: members add" on storage.objects for insert
  with check (bucket_id = 'clubhouse' and clubhouse_path_ok(name) and not is_muted());
drop policy if exists "Clubhouse photos: your own, or the committee" on storage.objects;
create policy "Clubhouse photos: your own, or the committee" on storage.objects for delete
  using (bucket_id = 'clubhouse' and (owner = auth.uid() or is_committee()));

-- ---------- live updates ----------
do $$ declare t text; begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['club_posts', 'club_comments', 'club_likes', 'chat_messages', 'chat_members'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
        execute format('alter publication supabase_realtime add table %I', t);
      end if;
    end loop;
  end if;
end $$;

-- ---------- the morning birthday job ----------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('falkners-birthdays', '1 6,7 * * *', 'select make_birthday_posts()');
  end if;
end $$;
