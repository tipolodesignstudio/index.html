# Supabase keepalive

[`../workflows/supabase-keepalive.yml`](../workflows/supabase-keepalive.yml)
writes a heartbeat row to the Supabase project once a day, so the free tier
never pauses it for inactivity.

Supabase pauses free projects after about **7 days** with no activity. A daily
run leaves a wide margin, because GitHub's scheduler delays or drops runs when
it is busy.

> This prevents pausing. It cannot un-pause. If the project is currently
> paused, restore it from the Supabase dashboard first.

Everything for this job lives under `.github/`, so none of it is published as
part of the www.tipolo.ca site.

## Setup

### 1. Create the heartbeat table

Supabase dashboard -> **SQL Editor** -> **New query**, paste
[`keepalive.sql`](keepalive.sql), and run it. It is idempotent.

It creates a one-row `public.keepalive` table, enables row level security, and
adds two policies that let the `anon` role read and update that single row —
and nothing else.

### 2. Add the repository secrets

**Settings -> Secrets and variables -> Actions -> New repository secret**

| Secret | Value | Where to find it |
| --- | --- | --- |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | Project Settings -> Data API |
| `SUPABASE_KEY` | the **anon** / **publishable** key | Project Settings -> API Keys |

Use the anon/publishable key, not the service role key. The anon key is the one
already shipped in browser clients, and step 1 limits what it can touch here.

### 3. Make sure it is on `main`

GitHub only runs `schedule` triggers from the repository's **default branch**.
On any other branch the cron is ignored, and only manual runs work.

### 4. Run it once by hand

**Actions -> Supabase keepalive -> Run workflow.** A green run means it is
done; the daily schedule takes over from there.

## How it works

1. `PATCH`es `public.keepalive` where `id = 1`, setting `last_seen` to now.
   That is a real database write, so it counts as activity. It retries three
   times with backoff and fails loudly with the HTTP status if Supabase does
   not answer.
2. Commits a `last-run.txt` timestamp back to this repository. GitHub disables
   scheduled workflows in a repository with no activity for 60 days, which
   would silently stop the keepalive; a commit per run resets that clock.
   Pushes made with `GITHUB_TOKEN` do not trigger workflows, so this cannot
   loop.

A failed run sends GitHub's usual workflow-failure email, which is the early
warning that the project is about to pause.

## Changing the schedule

Edit the `cron` line in the workflow. It is UTC, and any interval under ~5 days
is safe:

```yaml
- cron: '23 7 * * *'     # daily (default)
- cron: '23 7 */2 * *'   # every other day
- cron: '23 7 * * 1,4'   # Mondays and Thursdays
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `HTTP 200 but no row was updated` | `keepalive.sql` has not been run, or the row with `id = 1` is missing. |
| `HTTP 401` | Wrong or rotated `SUPABASE_KEY`. |
| `HTTP 404` | Wrong `SUPABASE_URL`, or the table is not in the `public` schema. |
| `HTTP 000` | Network failure, or the project is already paused — restore it from the dashboard. |
| No runs at all | The workflow is not on the default branch, or Actions is disabled for the repository. |
| Runs stopped appearing | The repository was inactive for 60 days and GitHub disabled the schedule. Re-enable it under **Actions**. |
