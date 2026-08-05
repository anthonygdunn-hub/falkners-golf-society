-- ============================================================
-- The Falkners Arms Golf Society — members & gallery add-on
--
-- Run this AFTER sql/schema.sql (from the original setup).
-- Same process: Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- What this adds:
--   - Public sign-up for members (pending committee approval)
--   - Member profiles (display name + profile picture)
--   - A photo gallery, with photos linked to a specific round
-- ============================================================

-- One row per logged-in person. Created automatically the moment
-- someone signs up (see trigger below) — nobody can create these
-- directly, so there's no way to fake your own profile.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'New member',
  avatar_url text,
  created_at timestamptz not null default now()
  );

-- Separate from profiles on purpose: this is the "permissions" table.
-- Keeping it apart means a member updating their own display name has
-- no way to accidentally (or deliberately) grant themselves committee
-- access or approve themselves — only committee accounts can touch this.
create table if not exists memberships (
  profile_id uuid primary key references profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'committee')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references profiles(id)
  );

-- A single photo, tied to whichever round it's from.
create table if not exists photos (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  uploader_id uuid references profiles(id) on delete set null,
  storage_path text not null,
  caption text,
  created_at timestamptz not null default now()
  );

-- ------------------------------------------------------------------
-- Auto-create a profile + a pending membership the moment someone
-- signs up. SECURITY DEFINER lets this trigger write to these tables
-- even though ordinary users aren't allowed to insert into them
-- directly (see policies below) — it's the only way in.
-- ------------------------------------------------------------------

create or replace function handle_new_member_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
insert into profiles (id, display_name)
values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', 'New member'));

insert into memberships (profile_id)
values (new.id);

return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function handle_new_member_signup();

-- ------------------------------------------------------------------
-- Row Level Security
-- ------------------------------------------------------------------

alter table profiles enable row level security;
alter table memberships enable row level security;
alter table photos enable row level security;

-- Profiles: everyone can see display names/photos (needed to show who
-- posted what on the gallery); only you can edit your own.
create policy "Public can read profiles" on profiles for select using (true);
create policy "Users can update their own profile" on profiles
for update using (auth.uid() = id) with check (auth.uid() = id);

-- Memberships: you can see your own status; committee can see everyone's
-- and is the only one who can approve/reject or promote to committee.
create policy "Users can read their own membership" on memberships
for select using (auth.uid() = profile_id);

create policy "Committee can read all memberships" on memberships
for select using (
  exists (select 1 from memberships m where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
  );

create policy "Committee can update memberships" on memberships
for update using (
  exists (select 1 from memberships m where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
  );

-- Photos: anyone can view the gallery. Only APPROVED members can add
-- photos, and only as themselves. You (or committee) can remove a photo.
create policy "Public can read photos" on photos for select using (true);

create policy "Approved members can upload photos" on photos
for insert with check (
  uploader_id = auth.uid()
  and exists (select 1 from memberships m where m.profile_id = auth.uid() and m.status = 'approved')
  );

create policy "Uploader or committee can delete photos" on photos
for delete using (
  uploader_id = auth.uid()
  or exists (select 1 from memberships m where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved')
  );

-- ------------------------------------------------------------------
-- Storage: one bucket for profile pictures, one for gallery photos.
-- Both are publicly viewable; uploading is restricted.
-- ------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true), ('gallery', 'gallery', true)
on conflict (id) do nothing;

create policy "Public can view avatars" on storage.objects
for select using (bucket_id = 'avatars');

create policy "Users upload their own avatar" on storage.objects
for insert with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users replace their own avatar" on storage.objects
for update using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Public can view gallery photos" on storage.objects
for select using (bucket_id = 'gallery');

create policy "Approved members upload gallery photos" on storage.objects
for insert with check (
  bucket_id = 'gallery'
  and exists (select 1 from memberships m where m.profile_id = auth.uid() and m.status = 'approved')
  );

-- ------------------------------------------------------------------
-- One-time step for your EXISTING committee logins (Jon, Robin, you):
-- these accounts were created before this migration existed, so they
-- already have a 'pending member' row from the trigger above. Run
-- this to promote them to approved committee status. Replace the
-- email addresses with your actual committee logins first.
-- ------------------------------------------------------------------

-- update memberships set role = 'committee', status = 'approved', decided_at = now()
-- where profile_id in (
--   select id from auth.users where email in (
--     'jon@example.com', 'robin@example.com', 'you@example.com'
--   )
-- );
