# HSL Director Hub — Netlify + Supabase edition

A standalone version of the HSL dashboard: your own domain on Netlify, with
real accounts (invite-only — no public sign-up) and three access levels:

- **Owner** — full control, including inviting people and changing roles
- **Editor** — can post updates, add links, and check off the resource list
- **Viewer** — can see everything, but can't change anything

Nobody can create their own account. You invite people by email from inside
the app (Team Access page, once you're set up as an owner).

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a free account/project.
2. Once it's created, go to **Project Settings → API**. You'll need two values
   from there in a minute: the **Project URL** and the **anon public key**.
3. Go to **Authentication → Providers** and make sure **Email** is enabled.
4. Go to **Authentication → Settings** and turn **off** "Allow new users to
   sign up" (sometimes called "Enable signup") — this is what makes the hub
   invite-only. People can only get in if you invite them.

## 2. Set up the database

1. In Supabase, go to **SQL Editor → New query**.
2. Open `supabase-schema.sql` from this folder, paste its contents in, and
   run it. This creates the tables (profiles, updates, links, tools),
   the security rules that enforce the owner/editor/viewer permissions, and
   seeds the resource checklist.

## 3. Fill in your keys

Open `config.js` in this folder and replace the two placeholder values with
your Project URL and anon public key from step 1.

## 4. Deploy to Netlify

1. Push this folder to a GitHub repo (or drag-and-drop deploy it directly in
   the Netlify dashboard — either works).
2. In Netlify, create a new site from that repo. The build settings are
   already defined in `netlify.toml`, so you shouldn't need to change
   anything — just confirm the publish directory is the repo root.
3. In **Site settings → Environment variables**, add two variables (these
   power the invite system and are never exposed to visitors):
   - `SUPABASE_URL` — your Project URL (same one from step 1)
   - `SUPABASE_SERVICE_ROLE_KEY` — from Supabase **Project Settings → API**,
     the **service_role** key (not the anon key — keep this one secret)
4. Deploy. Netlify will install `@supabase/supabase-js` automatically for the
   two serverless functions (`invite-user` and `set-role`) using the
   `package.json` in this folder.

## 5. Make yourself the first owner

Since nobody can sign up on their own, you need to invite yourself first:

1. In Supabase, go to **Authentication → Users → Invite user**, and invite
   your own email address. You'll get an email with a link to set a password.
2. Set your password and sign in at your new Netlify site's URL.
3. Back in Supabase, go to **SQL Editor** and run:
   ```sql
   update profiles set role = 'owner' where email = 'your-email@churchofthehighlands.com';
   ```
4. Refresh the dashboard — you should now see a **Team Access** tab in the
   nav. From here on, you can invite everyone else and set their role
   directly from the app — no more need to touch Supabase for day-to-day use.

## Day-to-day use

- **Team Access** page (only visible to owners): invite new directors by
  email and pick their role, or change an existing person's role.
- Everything else — Updates, Files & Links, Resource Status — works the same
  as before, live and shared, but now gated by real roles: Viewers can look,
  Editors and Owners can post/add/check things off.

## If something's not working

- **Photos not showing**: make sure the `assets/` folder deployed along with
  the rest of the site (it should, automatically).
- **"Supabase isn't configured yet" banner**: you haven't filled in
  `config.js` yet, or it has a typo.
- **Invite button fails / 403**: the two Netlify environment variables in
  step 4 aren't set, or you're not actually an owner yet (see step 5).
- **New person can't post anything**: check their role on the Team Access
  page — Viewers are read-only by design.
