# The Falkners Arms Golf Society

The society website: [thefalknersarmsgolfsociety.co.uk](https://www.thefalknersarmsgolfsociety.co.uk)

Plain HTML, CSS and JavaScript served by GitHub Pages, with Supabase behind it
for the data. There's no build step and no framework — edit a file, commit it,
and it's live in under a minute. That's deliberate: a golf society shouldn't
need a toolchain to change a tee time.

## How it fits together

The pages are static. Everything that changes — fixtures, results, members,
photos, the hole-in-one pot — lives in Supabase and is fetched by the browser
at page load. `js/config.js` holds the project URL and the anon key, which are
public by design; what actually protects the data is Row Level Security in the
database, so a curious visitor with the browser console open still can't read
or write anything they shouldn't.

| Page | What it does |
| --- | --- |
| `index.html` | Home, with the next fixtures and the top of the leaderboard |
| `fixtures.html` | Every round; expands in place for details, the playing list, the tee draw and registration |
| `results.html` | Scored rounds by season, with each round's prizes |
| `leaderboard.html` | Order of Merit standings |
| `hole-in-one.html` | The rolling prize pot and how it got there |
| `gallery.html` | Photos, grouped by round |
| `members.html` | The member directory — only visible once you're signed in and approved |
| `member.html` | Sign in, sign up, your profile, photo uploads |
| `join.html` | Membership application (handicap and mobile required) |
| `contact.html` | General enquiries |
| `committee.html` | Who's who |
| `admin.html` | Committee dashboard — everything below |
| `reset-password.html` | Where the password reset email lands |

## What the committee can do

All of it lives on `admin.html`, behind a Supabase login:

- Approve or reject new member requests
- Add and edit fixtures — date, venue, address, cost, meet time, first tee time, website, notes
- Manage who's playing, including adding guests by name who have no website account
- Set the tee draw, which then shows publicly under that round
- Log results, with whoever was actually on the round listed first
- Record each round's prizes: 1st/2nd/3rd, winning pair, longest drive and nearest the pin on both nines
- Keep the hole-in-one pot up to date, including paying it out
- Hold the society's bank details and confirm who's paid for a round
- Choose how many rounds count toward the Order of Merit

## Setting up the database

Supabase dashboard → SQL Editor → paste → Run, in this order. Every file is
safe to run twice, so if you're unsure whether one has been applied, just run
it again.

1. `sql/schema.sql` — players, events, results
2. `sql/members-and-gallery.sql` — profiles, memberships, photos
3. `sql/signup-trigger.sql` — creates a profile and a pending membership when somebody signs up
4. `sql/storage-buckets.sql` — the image buckets and their permissions
5. `sql/attendance-and-groupings.sql` — who's playing, and the tee draw
6. `sql/event-registration-intent.sql` — registering for a round while joining
7. `sql/fixture-details.sql` and `sql/fixture-times.sql` — cost, address, website, notes, meet and tee times
8. `sql/payments.sql` — bank details and payment status
9. `sql/member-profile.sql` — handicap and bio
10. `sql/member-directory.sql` — the members-only directory function
11. `sql/guest-players.sql` and `sql/guest-groupings.sql` — players with no website account
12. `sql/round-prizes.sql` — the prizes for each round
13. `sql/hole-in-one-pot.sql` — the rolling pot
14. `sql/league-settings.sql` — how many rounds count

Two settings in the Supabase dashboard matter and aren't in any SQL file.
Under Authentication → URL Configuration, the Site URL must be the live domain
and the redirect list must include `https://www.thefalknersarmsgolfsociety.co.uk/**`,
or password reset emails will send people to the wrong place.

## Where secrets go

Nothing secret belongs in this repository — it's public, so anything committed
here is readable by anyone forever.

- The Supabase **anon key** in `js/config.js` is fine. It's meant to be public.
- The Supabase **service role key** must never appear here.
- The society's **bank details** live in the `society_settings` table, readable
  only by approved members, and are edited through the admin page.
- Any **mail service API key** belongs in Supabase's Edge Function secrets,
  never in a file.

## Deploying

Commit to `main`. GitHub Pages rebuilds automatically, usually within a minute.
`CNAME` holds the custom domain — don't delete it, or the domain stops
resolving to the site.
