# Deployment: Vercel + Supabase or Neon

This guide puts the web app on Vercel and the database on Supabase or Neon. For a single
container host (Fly.io, Render, Railway, a VPS), use the Docker setup in the README instead; see
[Which option to pick](#which-option-to-pick).

## What runs where

| Part                  | Where                                     | Why                                                      |
| --------------------- | ----------------------------------------- | -------------------------------------------------------- |
| Web app + API         | Vercel                                    | Serverless functions, previews, HTTPS and CDN included   |
| Postgres + pgvector   | Supabase or Neon                          | Both ship pgvector and a connection pooler               |
| Migrations            | Your machine (or CI), once per release    | Need a direct (non-transaction-pooled) connection        |
| Job worker (triage)   | A container host, using the `tools` image | Vercel functions cannot run a long-lived polling process |
| Embedding model cache | `/tmp` on each Vercel instance            | The deployment's own files are read-only                 |

## 1. Create the database

**Supabase:** create a project, then open **Connect**. You need two connection strings:

- **App** (`DATABASE_URL` on Vercel): the **transaction pooler**, port `6543`. It works
  because the client disables prepared statements (`src/db/client.ts`).
- **Migrations and scripts**: the **session pooler** (port `5432` on the pooler host). The
  direct `db.<ref>.supabase.co` host is IPv6-only unless you buy the IPv4 add-on, so it may not
  connect from your network.

**Neon:** create a project. The dashboard's connection string has a **Pooled connection**
toggle:

- **App:** the pooled string (its host contains `-pooler`).
- **Migrations and scripts:** the direct string (toggle off).

Nothing else to configure. The first migration runs `CREATE EXTENSION IF NOT EXISTS vector`,
which both providers allow. Every table has row level security turned on with no policies, so
Supabase's public Data API can read or write nothing (a test enforces this for new tables).

## 2. Run the migrations

From your machine, with the **direct / session** connection string:

```bash
DATABASE_URL="postgres://…direct-or-session…" npm run db:migrate
```

A `DATABASE_URL` set in the shell takes precedence over `.env.local`. Run this again before
deploying any release that adds a migration (`drizzle/`). Migrations only add; never edit one
that has already been applied.

## 3. Deploy to Vercel

1. Push the repository to GitHub and import it in Vercel. It detects Next.js; keep the default
   build command (`npm run build`). The build needs no secrets.
2. Under **Settings → Environment Variables**, add these for **Production**:

| Variable             | Value                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`       | The **pooled** connection string from step 1                                |
| `DATABASE_POOL_MAX`  | `1` to `3`. Each function instance opens its own pool, so keep it small     |
| `BETTER_AUTH_SECRET` | A new random value: `openssl rand -base64 32`. Never reuse your dev secret  |
| `BETTER_AUTH_URL`    | The production URL, e.g. `https://support-pilot.vercel.app` (no trailing /) |
| `MODEL_CACHE_DIR`    | `/tmp/transformers`                                                         |
| `ANTHROPIC_API_KEY`  | Optional. Turns on cited answers and draft replies                          |
| `DEMO_USER_PASSWORD` | Optional, demo deployments only. Shows "Try as Guest"                       |
| `RESEND_API_KEY`     | Optional. Emails agent replies to customers (sent by the worker)            |
| `EMAIL_FROM`         | Required with `RESEND_API_KEY`, on a domain verified in Resend              |

3. Deploy, then open `https://<your-domain>/api/health`. It should return
   `{"status":"ok","checks":{"database":"up"}}`. A 503 means the app cannot reach the database:
   check `DATABASE_URL`.

If a required variable is missing or invalid, the server stops at startup and the function logs
name the variable (never its value).

**Preview deployments** get their own URLs, which won't match `BETTER_AUTH_URL`, so sign-in
there is rejected. Either keep previews for UI review only, or give the Preview environment its
own database and set `BETTER_AUTH_URL` to a stable preview domain.

## 4. Create the first admin

Self sign-up is off, so create an admin from your machine against the production database. Use
the direct / session connection string and the production auth values:

```bash
DATABASE_URL="postgres://…direct-or-session…" \
BETTER_AUTH_SECRET="…production value…" BETTER_AUTH_URL="https://<your-domain>" \
TENANT_SLUG=acme ADMIN_NAME="Your Name" ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD="…12+ chars…" npm run auth:create-admin
```

Sign in, then add agents and viewers at **Settings → Users**.

**Demo deployment (optional, demo data):** `npm run db:seed:demo` creates the demo accounts and
`npm run seed:load` loads the fictional Acme Cloud dataset, both with the same variables as
above. Don't run either against a database with real users.

## 5. Run the job worker

New tickets queue a `triage_ticket` job. Something has to process the queue, and a Vercel
function can't, because the worker polls continuously. Run the `tools` image on any container
host as a background worker (no public port):

```bash
docker build --target tools -t support-pilot-ai-tools .
```

Give it `DATABASE_URL` (the pooled string is fine; the worker uses one connection),
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NODE_ENV=production` (already set in the image),
`ANTHROPIC_API_KEY`, and `RESEND_API_KEY` + `EMAIL_FROM` to send reply emails. The image's default command is the worker. It stops cleanly on SIGTERM,
finishing the job in progress.

Without a worker, the app still works: tickets just stay untriaged (no AI summary, suggested
team or priority). Failed jobs retry twice with backoff, then end as `failed`.

## Embeddings on Vercel

Semantic search runs the `multilingual-e5-small` model inside the function (about 300 MB of
memory). Each new Vercel instance downloads the model (~130 MB) from Hugging Face into
`MODEL_CACHE_DIR` on its first search or upload, so that first request is slow. Warm instances
reuse it.

If that's not acceptable, set `SEMANTIC_SEARCH=off`: search becomes keyword-only and the model
is never loaded. Documents uploaded while it is off are stored without embeddings, so they
won't show up in semantic results if you turn it back on later; re-upload them.

The native runtime (`onnxruntime-node`) and `sharp` are added to the function bundle through
`outputFileTracingIncludes` in `next.config.ts`. Vercel builds on Linux x64, so only those
binaries are included.

## Known limits of this setup

- **Reply emails need the worker:** replies are queued in Postgres and sent by the worker, so
  without one they stay "Queued for email".
- **Cold starts:** Neon's free tier suspends idle databases and Vercel scales functions to zero.
  The first request after a quiet period is slower.
- **Function limits:** model calls and embedding run inside requests. Check your Vercel plan's
  maximum function duration if answers time out.

## Which option to pick

|                 | Vercel + Supabase/Neon                    | Docker on a container host     |
| --------------- | ----------------------------------------- | ------------------------------ |
| Setup           | Least ops for the web app                 | One image and one Compose file |
| Worker          | Needs a separate host anyway              | Runs next to the app           |
| Embedding model | Downloaded per instance (cold-start cost) | Kept on a volume               |
| Previews per PR | Built in                                  | Not included                   |

For a portfolio demo, Vercel + Supabase/Neon with `SEMANTIC_SEARCH=off` and no worker is the
cheapest way to show the UI. Running every feature (triage, semantic search) is simpler with the
Docker image on one host, pointed at a Supabase or Neon database, or at the bundled Postgres.
