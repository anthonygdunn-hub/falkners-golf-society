-- ============================================================
-- The Falkners Arms Golf Society — image storage
--
-- Run this AFTER sql/members-and-gallery.sql.
-- Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- WHY THIS EXISTS AS ITS OWN FILE
-- members-and-gallery.sql was meant to create these buckets and
-- policies, but on this project they never made it in — uploads came
-- back with "Bucket not found" and nobody could set a profile picture.
-- Pulling them into their own file makes them easy to re-run and easy
-- to check, and every statement here is safe to run twice.
--
-- Both buckets are public to READ, because avatars and gallery photos
-- are shown on the site. Writing is what's restricted: you can only
-- put a file in the avatars bucket under a folder named after your own
-- user id, and only an approved member can add to the gallery.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('avatars', 'avatars', true, 5242880),      -- 5 MB
       ('gallery', 'gallery', true, 15728640)      -- 15 MB, phone photos are big
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;

-- Deliberately no allowed_mime_types: phones report camera photos
-- under a surprising range of types (image/heic, image/jpg), and a
-- strict list turns a working upload into a baffling error.

-- ---- Profile pictures ------------------------------------------------

drop policy if exists "Public can view avatars" on storage.objects;
create policy "Public can view avatars" on storage.objects
  for select using (bucket_id = 'avatars');

-- The first folder in the path is the uploader's user id, so this says:
-- you may only write inside your own folder.
drop policy if exists "Users upload their own avatar" on storage.objects;
create policy "Users upload their own avatar" on storage.objects
  for insert with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users replace their own avatar" on storage.objects;
create policy "Users replace their own avatar" on storage.objects
  for update using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users remove their own avatar" on storage.objects;
create policy "Users remove their own avatar" on storage.objects
  for delete using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---- Gallery photos --------------------------------------------------

drop policy if exists "Public can view gallery photos" on storage.objects;
create policy "Public can view gallery photos" on storage.objects
  for select using (bucket_id = 'gallery');

drop policy if exists "Approved members upload gallery photos" on storage.objects;
create policy "Approved members upload gallery photos" on storage.objects
  for insert with check (
    bucket_id = 'gallery'
    and exists (select 1 from memberships m where m.profile_id = auth.uid() and m.status = 'approved')
  );

drop policy if exists "Uploader or committee removes gallery photos" on storage.objects;
create policy "Uploader or committee removes gallery photos" on storage.objects
  for delete using (
    bucket_id = 'gallery'
    and (owner = auth.uid()
         or exists (select 1 from memberships m
                    where m.profile_id = auth.uid() and m.role = 'committee' and m.status = 'approved'))
  );
