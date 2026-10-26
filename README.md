# Support Pilot AI

**AI Support & Operations Copilot**: support ticket management where Claude triages tickets and
drafts replies grounded in your own documents, with source citations, and a human approves every
reply before it is sent.

> **Status: Phases 1-4 and 7 done, Phases 5-6 mostly done.** Sign-in, roles, multi-tenancy,
> tickets (API and email intake, inbox, status, assignment, replies emailed through Resend),
> incidents, the knowledge base with cited answers, AI triage, AI draft replies with human
> approval and the analytics dashboard all work. **Everything runs free, with no API key:**
> without `ANTHROPIC_API_KEY` the app uses its built-in no-model mode (see
> [Free mode](#free-mode-no-api-key)). See [Roadmap](#roadmap).

## Free mode (no API key)

With no `ANTHROPIC_API_KEY`, nothing calls a paid service and nothing extra is installed. The
AI steps switch to built-in, deterministic code (`src/server/ai/builtin.ts`), labeled **Rules**
or **Template** in the UI, never "AI":

| Feature                | With a Claude key                    | Free mode                                                                     |
| ---------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| Triage                 | Claude classifies and summarizes     | Keyword rules (English, Hinglish, Tanglish), injection patterns, same routing |
| Draft replies          | Claude writes a cited reply          | Template quoting the best-matching help article, cited; an agent approves     |
| Knowledge-base answers | Claude writes a cited answer         | The matching passages with their sources (search-only)                        |
| Demo dataset           | `seed:generate` (Claude writes text) | `seed:templates` (template text, same plan and labels)                        |
| Triage eval            | `eval:triage` (paid per ticket)      | `eval:triage -- --rules` (free)                                               |

On the template golden set the rules score 76% category accuracy (target 85%, set for Claude),
49% priority accuracy (92% within one level), 95% language accuracy and 10/10 injections flagged
with no false flags. The tickets were written from templates, so real customer wording would
score lower. Adding a key later switches everything to Claude with no other change.

## Architecture

```
Next.js 16 (App Router, TypeScript)
 ├─ UI: React Server Components + Tailwind v4 + shadcn/ui (Radix)
 ├─ Route handlers / server actions → Zod validation → RBAC guard → services
 │    tickets · AI (classify, draft, answer, judge) · ingest · retrieval · evals · audit
 └─ Cross-cutting: pino structured logs, request IDs, typed AppErrors
        │                                   │
   PostgreSQL + pgvector (Drizzle)     Claude API (server-only) · local embeddings (ONNX)
```

**Retrieval (Phase 4):** documents are chunked by markdown section (`src/server/knowledge/chunk.ts`)
and stored with a generated `tsvector` and a 384-dimension embedding from
`multilingual-e5-small`, which runs locally on the CPU: free, no API key, and nothing leaves the
server. It is multilingual, so a Hinglish ticket ("mera invoice do baar charge hua") lands near
the English article that answers it. Search will be hybrid (pgvector cosine + Postgres full-text).
When the retrieved evidence is too weak, the answer is a clearly marked fallback, never an
unsupported claim.

**Multi-tenancy:** every business table has a `tenant_id`, and every user belongs to one tenant.
Isolation is enforced twice: services filter by the signed-in user's tenant, and composite foreign
keys (`(child.parent_id, child.tenant_id) → parent(id, tenant_id)`) make the database itself
reject any row that links two tenants. Tests try each cross-tenant link and expect a failure.

### Data model

| Table                                        | Purpose                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `user`, `session`, `account`, `verification` | Better Auth tables; `user.role` is `admin` / `agent` / `viewer`                     |
| `tenants`                                    | Customer organizations; everything below carries a `tenant_id`                      |
| `customer_accounts`, `orders`                | The tenant's own customers and invoices (what AI tools look up); demo-seeded        |
| `incidents`                                  | Outages with their evidence bundle (alert JSON, logs); tickets link to them         |
| `tickets`, `ticket_messages`                 | Tickets (with AI classification fields) and conversation history                    |
| `triage_results`                             | History of AI triage passes: category, priority, language, injection flag           |
| `tool_calls`                                 | Actions the AI proposes (e.g. a refund): pending → approved → executed, or rejected |
| `eval_runs`                                  | Batch evaluations (e.g. triage accuracy on the golden set) with metrics             |
| `documents`, `document_chunks`               | KB articles and internal runbooks; chunks with embedding + FTS vector               |
| `ai_drafts`                                  | AI reply drafts, approval status, final edited text, model / tokens / latency       |
| `kb_queries`                                 | Questions and answers from the knowledge-base page                                  |
| `citations`                                  | Cited passages for a draft or an answer, with a quote snapshot                      |
| `answer_evaluations`                         | LLM-judge or human scores (groundedness, relevance, citation accuracy)              |
| `audit_logs`                                 | Append-only log of who did what                                                     |

## Authentication and roles

[Better Auth](https://better-auth.com) with email and password, database sessions (7 days), and
its admin plugin for user management. **Self sign-up is disabled**: an admin creates every account.

| Role     | Can                                                                     |
| -------- | ----------------------------------------------------------------------- |
| `admin`  | Everything, including users, documents, evals and the audit log         |
| `agent`  | Work tickets, generate AI drafts, review (approve / edit / reject) them |
| `viewer` | Read tickets, documents and analytics, ask the knowledge base           |

The full matrix is in `src/server/auth/permissions.ts`, and a test pins every cell of it. Checks
happen at three layers:

1. **`proxy.ts`:** an optimistic redirect to `/login` when there is no session cookie. It improves
   UX only and is not a security boundary.
2. **Data access layer (`src/server/auth/session.ts`):** every page, server action and API route
   calls `requirePagePermission` or `requirePermission`, which validates the session against the
   database on every request. Role changes and bans take effect immediately.
3. **Better Auth admin plugin:** re-checks admin-only operations on its own endpoints.

New users default to `viewer`. Admins cannot demote or ban themselves, which prevents lockouts.
Sign-ins and admin actions are written to `audit_logs`.

## App layout

Signed-in pages share a collapsible sidebar (shadcn/ui `Sidebar`; a slide-over sheet on phones).

| Section        | Route        | Needs            | Status                                                        |
| -------------- | ------------ | ---------------- | ------------------------------------------------------------- |
| Inbox          | `/inbox`     | `ticket:read`    | Ticket list with filters, search and pages; `/tickets/:id`    |
| Approvals      | `/approvals` | `draft:review`   | Queue of AI drafts waiting for review, oldest first           |
| Incidents      | `/incidents` | `incident:read`  | Outages with linked tickets, alert and logs; `/incidents/:id` |
| Analytics      | `/analytics` | `analytics:read` | Volume, response times, breakdowns, AI usage, workload        |
| Knowledge Base | `/knowledge` | `document:read`  | Ask with cited answers; admins upload / delete documents      |
| Settings       | `/settings`  | signed in        | Account and permissions; admins also get `/settings/users`    |

Items a role cannot use are hidden from the sidebar (viewers do not see Approvals), and each page
checks the same permission on the server. Dark mode follows the OS setting until
someone picks Light or Dark with the header toggle (saved per browser).

The ticket page shows the conversation on the left and an "AI Copilot" panel on the right with the
AI triage (summary, suggested team, confidence, reasoning; marked **AI**) and the draft reply (see
[Draft replies](#draft-replies)). A ticket flagged as a prompt-injection attempt
shows a warning banner, and an **Injection** badge in the inbox. Priority is shown as P1-P4
(urgent / high / normal / low). Seed tickets carry a **Demo** badge.

## Knowledge base

`/knowledge` answers staff questions from the company's own documents.

- **Upload** (admins, `document:manage`): `.md`, `.txt`, `.pdf` or `.docx` up to 4 MB, as a help article (may be
  quoted to customers) or an internal runbook. The file is split into sections by heading
  (`src/server/knowledge/chunk.ts`), stored, and embedded locally with `multilingual-e5-small`
  (free, CPU, ~110 MB of memory, nothing leaves the server). The same file twice is rejected.
  If embedding fails, the document still works with keyword search and admins get a
  **Re-index** button.
- **PDF and Word** (`src/server/knowledge/extract.ts`): the file's first bytes must match its
  extension. PDF text comes from [unpdf](https://github.com/unjs/unpdf) (pdf.js, no native code),
  page by page; Word files go through [mammoth](https://github.com/mwilliamson/mammoth.js) and
  their headings become `#` headings, so sections still split by heading. Mammoth never follows
  links to external files, images are dropped, and more than 2 million extracted characters are
  rejected. Scanned PDFs without a text layer are refused (no OCR).
- **Search** (`src/server/knowledge/search.ts`): semantic (pgvector cosine) and keyword
  (Postgres full-text, any of the question's words) candidates merged with reciprocal rank
  fusion, over the tenant's ready documents only. The semantic half matches across languages
  (a Hinglish question finds the English article).
- **Answer** (`src/server/ai/answer.ts`, prompt `prompts/answer_v1.md`): with an API key, Claude
  (`ANSWER_MODEL`) answers only from the top sections, citing them as `[1]`, `[2]`. Sources and
  the question are HTML-escaped inside tags and treated as data. Citation numbers that don't
  exist are dropped, and an answer with no valid citation is marked "not fully covered"
  (`insufficient_evidence`). With no matching sections, a fixed fallback is returned without
  calling the model. Each question is saved to `kb_queries` with its `citations`, model, tokens
  and latency. PII in the question is redacted before it is sent.
- **Without an API key** the ask box shows the most relevant sections instead (search only).
- `SEMANTIC_SEARCH=off` skips the embedding model on low-memory machines: keyword search only.

## Draft replies

On a ticket, an agent clicks **Draft a reply** (`draft:generate`). `src/server/ai/drafts.ts`:

1. Searches the tenant's **help articles only** (internal runbooks never feed customer text),
   using the subject and the latest customer message.
2. With matches, Claude (`ANSWER_MODEL`, prompt `prompts/draft_v1.md`) writes the reply from those
   articles, citing them as `[1]`. Ticket and articles are escaped inside tags and treated as
   data; PII is redacted before sending and restored after.
3. If no article matches, the model says they don't cover it, or the reply cites nothing valid,
   the draft is a fixed **holding reply** that makes no factual claim or promise
   (`insufficient_evidence`; no model call when nothing matched).
4. The draft is saved to `ai_drafts` (model, tokens, latency) with its `citations`, audited as
   `draft.generated`, and replaces the ticket's earlier pending draft.

**Review** (`draft:review`): the agent edits the text if needed, then **Approve** or **Reject**
(with an optional reason). Approving strips the `[n]` markers, adds the agent's name after
"Best regards,", saves `final_body` with status `approved` or `edited`, adds the reply to the
conversation as the agent's message (linked to the draft), sets the first-response time, moves an
open ticket to `pending`, and writes `draft.approved` / `draft.edited_and_approved` to the audit
log, all in one transaction. A draft can be reviewed only once, and the approved reply is emailed
like a typed one (see [Outbound email](#outbound-email)). `/approvals` lists all pending drafts.

## Outbound email

Agent replies, typed or approved from an AI draft, are emailed to the customer through
[Resend](https://resend.com) when `RESEND_API_KEY` and `EMAIL_FROM` are set:

- The reply's transaction marks the message `queued` and adds a `send_reply_email` job, so an email
  is queued only if the reply is saved. The worker sends it as plain text with the subject
  `Re: <subject> [#1042]`, then marks it `sent` and writes `ticket.reply_emailed` to the audit log.
- Failures are marked `failed` and retried with backoff (3 attempts). The message id is the
  provider's idempotency key, so a retry never sends the same reply twice.
- Never emailed (`skipped`, with the reason shown): demo or imported tickets (`external_ref`
  set), reserved test domains (`.example`, `.test`, `example.com` and others), and every reply
  while no key is set.
- Each agent message on the ticket page shows its delivery status.

Customer replies to that email are not threaded yet: they arrive through the inbound email
endpoint as new tickets.

## AI triage

Each new ticket queues a `triage_ticket` job (`npm run jobs:work` runs them):

1. **Redact** (`src/server/ai/redact.ts`): emails, phone numbers (Indian and international), card
   numbers (Luhn-checked), Aadhaar and PAN become tokens such as `[EMAIL_1]`. The map stays in
   memory, so values can be restored in the model's summary for agents. Regex-based and
   best-effort: it reduces what reaches the model rather than guaranteeing nothing does.
2. **Classify** with `TRIAGE_MODEL` (default `claude-opus-5-5`, low effort) using structured output:
   category, priority, sentiment, language, summary, suggested team, injection flag, confidence,
   reasoning. The prompt (`src/server/ai/prompts/triage_v1.md`) puts the ticket inside
   `<ticket>` tags, HTML-escaped so it cannot close them, and states that content inside is data,
   not instructions. Server-side fallbacks are on, so a safety refusal is retried on a fallback
   model.
3. **Save** a `triage_results` row (with model, tokens, latency and prompt version), copy the
   labels onto the ticket and write a `ticket.triaged` audit row, in one transaction.
4. **Route** in code, after the model answers, so ticket text cannot talk its way out of it:
   urgent (P1) or negative-sentiment tickets go to the `lead` queue; otherwise the suggested team.

**Eval:** `npm run eval:triage` runs the same path over `evals/golden_tickets.jsonl` and prints
category, priority and language accuracy, injection recall and precision, and both confusion
matrices. It saves the run to `eval_runs` (predictions only, no golden labels) and exits non-zero
unless category accuracy is at least 85% and every injection ticket is flagged. It makes one paid
API call per golden ticket; `--limit 10 --no-save` is a cheap smoke test, and `--rules` scores the
free keyword triage instead (no key).

## Ticket API

| Method and path           | Auth                    | What it does                                                                                                       |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `POST /api/tickets`       | API key, or agent/admin | Create from JSON: `subject`, `body`, `customer {name, email}`                                                      |
| `POST /api/tickets/email` | API key, or agent/admin | Create from a raw RFC 5322 email in the body (max 2 MB)                                                            |
| `GET /api/tickets`        | API key, or any role    | List: `status`, `priority`, `category`, `assignee` (`me`, `unassigned` or a user id), `search`, `page`, `pageSize` |
| `GET /api/tickets/{id}`   | API key, or any role    | One ticket with its messages                                                                                       |
| `PATCH /api/tickets/{id}` | API key, or agent/admin | Change `status` and/or `assigneeId` (`null` unassigns)                                                             |

**Workflow.** Statuses are `open` (needs a reply), `pending` (waiting on the customer),
`resolved` and `closed`. Resolving or closing stamps `resolved_at`; reopening clears it. A
reply (typed by an agent, or an approved AI draft) sets the first-response time and moves an
open ticket to `pending`. Tickets can be assigned to active agents and admins of the same
tenant. Every change is audited (`ticket.updated` with before/after values, `ticket.replied`).
The inbox filters by assignee (Me / Unassigned) and shows who owns each ticket.

**Auth.** Integrations send `Authorization: Bearer <key>`. Keys belong to one tenant, are created
with `npm run api-key:create` and are stored only as a SHA-256 hash. Without that header, the
session cookie and normal role checks apply. A bad key is rejected (401), never retried as the
cookie. The tenant always comes from the key or the session, never from the request.

**On create**, one transaction writes the ticket, its first customer message, a `ticket.created`
audit row and a `triage_ticket` job. Jobs live in the `jobs` table (Postgres, no Redis) and
`npm run jobs:work` runs them (see [AI triage](#ai-triage)). Failed jobs retry twice, 30 and 60
seconds apart.

```bash
TENANT_SLUG=acme KEY_NAME="curl" npm run api-key:create      # prints the key once
curl -X POST http://localhost:3000/api/tickets \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"subject":"Invoice charged twice","body":"I was billed twice in March.","customer":{"name":"Priya N","email":"priya@example.com"}}'
curl -X POST http://localhost:3000/api/tickets/email \
  -H "Authorization: Bearer $KEY" -H "Content-Type: message/rfc822" --data-binary @message.eml
```

Errors use the standard shape: `{ "error": { "code", "message", "details?", "requestId" } }`.

**Retries are safe.** Send an `Idempotency-Key` header (1-200 printable characters, unique per
delivery) and a repeat of the same request returns the ticket it already created with
**200** and `Idempotent-Replayed: true`, instead of a duplicate (201 is a new ticket). Raw emails
are deduplicated by their `Message-ID` automatically. Keys are scoped to the tenant, and two
identical deliveries arriving at once still create one ticket (a unique constraint decides).

**Limits.** Each API key or user gets 60 write and 300 read requests per minute (fixed window,
counted in Postgres so it holds across restarts); over that, **429** with `Retry-After`. JSON
bodies are capped at 1 MB and raw emails at 2 MB (**413**).

## Getting started

Requirements: Node.js 24+, and a PostgreSQL 15+ database with the `pgvector` extension available.
The free tiers of Supabase and Neon both work.

```bash
npm install
cp .env.example .env.local     # then set DATABASE_URL
npm run db:migrate             # creates the pgvector extension and all tables
# set BETTER_AUTH_SECRET in .env.local (openssl rand -base64 32), then create the first admin
# (TENANT_SLUG is created if missing; use "acme" to share the demo data below):
TENANT_SLUG=acme ADMIN_NAME="Your Name" ADMIN_EMAIL=you@example.com ADMIN_PASSWORD="…12+ chars…" npm run auth:create-admin
npm run dev                    # http://localhost:3000/login, health: /api/health
```

**Demo accounts (optional, demo data):** `DEMO_USER_PASSWORD="…" npm run db:seed:demo` creates
`admin@`, `agent@` and `viewer@demo.supportpilot.test` in the `acme` tenant, named `[Demo] …`,
with that password. Skip this on any database that holds real users. With `DEMO_USER_PASSWORD`
also set in `.env.local`, the login page shows **Try as Guest**, which signs in as the read-only
demo viewer.

**Demo dataset (optional, demo data):** `npm run seed:load` loads the fictional "Acme Cloud"
(subscription billing software) into the `acme` tenant: 50 customer accounts with invoices, 40
KB articles, 5 internal runbooks, 3 incidents with alert and log bundles, and 300 tickets
(Hinglish and Tanglish ones, angry customers, 10 prompt-injection attempts). Tickets load
untriaged. `seed/data` comes from `npm run seed:templates` (free, no model, deterministic; the
committed files) or `npm run seed:generate` (Claude writes richer text; needs `ANTHROPIC_API_KEY`,
roughly $1–3). Both follow the same plan in `seed/lib/plan.ts`. Every file carries a demo notice.
See `seed/` and `evals/README.md`.

**Local dev database (no account):** a small companion project, `support-pilot-devdb` (kept
next to this repo, not in it), runs PGlite with pgvector over the Postgres protocol on `127.0.0.1:54322`. Point the app at it with
`DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres` and `DATABASE_POOL_MAX=1`.

- `npm start` / `npm run stop` there. **Always stop it with `npm run stop` (or Ctrl+C)**, never
  Task Manager: PGlite's files are only consistent after a clean shutdown, and a hard kill can
  leave the data folder unopenable.
- It checkpoints every minute and writes a snapshot to `backups/` every 30 minutes (last 3
  kept); `npm run backup` takes one now and `npm run restore -- backups/<file>` restores one
  (the current data is moved aside, not deleted). `GET 127.0.0.1:54323/status` shows connections.
- PGlite is a single Postgres session, so every client must use one connection. The server also
  works around two pglite-socket 0.2 gaps: it frees connection slots left by killed clients and
  rolls back transactions they left open. Dev only.

Supabase: use the **direct** or **session pooler** connection string for `db:migrate`. The
transaction pooler (port 6543) works for the app, because the client disables prepared statements.

## Scripts

| Command                     | What it does                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `npm run check`             | Typecheck, lint, format check, tests                                               |
| `npm run test`              | Vitest, including DB integration tests on in-process Postgres (PGlite + pgvector)  |
| `npm run build`             | Production build. Needs no environment variables.                                  |
| `npm run db:generate`       | Generate a migration from schema changes                                           |
| `npm run db:migrate`        | Apply migrations                                                                   |
| `npm run auth:create-admin` | Create an admin from `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD`               |
| `npm run db:seed:demo`      | Create the three labeled demo accounts (needs `DEMO_USER_PASSWORD`)                |
| `npm run api-key:create`    | Create an API key for `TENANT_SLUG` named `KEY_NAME` (printed once)                |
| `npm run jobs:work`         | Run queued background jobs (triage, reply emails) until Ctrl+C                     |
| `npm run eval:triage`       | Score triage on the golden set (paid; `--rules` free, `--limit N`, `--no-save`)    |
| `npm run seed:generate`     | Write the demo dataset to `seed/data` with Claude (resumable; `--only`, `--force`) |
| `npm run seed:templates`    | Write the demo dataset from templates: free, no model (`--force` to overwrite)     |
| `npm run seed:load`         | Load `seed/data` into the `acme` tenant (idempotent; embeds chunks locally)        |
| `npm run seed:golden`       | Build `evals/golden_tickets.jsonl` (100 labeled tickets) from the dataset          |

## Environment variables

All variables are server-only and validated with Zod at startup (`src/env.ts`). The server exits
with a clear message if any are invalid. Error messages name the variable but never echo its value.

| Variable             | Required   | Notes                                                        |
| -------------------- | ---------- | ------------------------------------------------------------ |
| `DATABASE_URL`       | Yes        | `postgres://` or `postgresql://`                             |
| `DATABASE_POOL_MAX`  | No         | App connection pool size (default 10; 1 for local PGlite)    |
| `LOG_LEVEL`          | No         | `debug` / `info` / `warn` / `error`                          |
| `BETTER_AUTH_SECRET` | Yes        | 32+ characters; signs session cookies                        |
| `BETTER_AUTH_URL`    | Production | Public base URL; defaults to localhost:3000 in dev           |
| `ANTHROPIC_API_KEY`  | No         | Claude for AI features; without it, free built-in mode       |
| `SEED_MODEL`         | No         | Model for `seed:generate` (default `claude-sonnet-5-5`)      |
| `TRIAGE_MODEL`       | No         | Model for triage and its eval (default `claude-opus-5-5`)    |
| `ANSWER_MODEL`       | No         | Model for knowledge-base answers (default `claude-opus-5-5`) |
| `SEMANTIC_SEARCH`    | No         | `off` = keyword search only, no local model (saves memory)   |
| `MODEL_CACHE_DIR`    | No         | Absolute path for the embedding model (default `.cache/`)    |
| `DEMO_USER_PASSWORD` | No         | Demo accounts' password; enables "Try as Guest"              |
| `RESEND_API_KEY`     | No         | Emails agent replies to customers (needs `EMAIL_FROM`)       |
| `EMAIL_FROM`         | With key   | Sender, e.g. `Acme Support <support@acme.com>`               |

Embeddings need no key: the model (~130 MB) downloads from Hugging Face on first use into
`.cache/transformers` (git-ignored). Downloads retry, because the CDN can be slow to connect.

## Security

- Secrets are read only on the server (`import "server-only"`). No `NEXT_PUBLIC_` keys.
- All input is validated with Zod. Malformed JSON returns 400, not 500; oversized bodies 413.
- Every response carries security headers (`next.config.ts`): a same-origin Content Security
  Policy with `frame-ancestors 'none'` and `object-src 'none'`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, a strict referrer policy, a Permissions-Policy that turns
  off camera / microphone / location / payment, `Cross-Origin-Opener-Policy`, and HSTS.
- API rate limits per key or user (see [Ticket API](#ticket-api)), and idempotent ticket creation.
- Error responses are uniform (`{ error: { code, message, requestId } }`). Unexpected errors and
  upstream causes are logged server-side and never returned to the client.
- Logs are structured JSON with a request ID on every line, and known secret fields are redacted.
- Request IDs supplied by clients are accepted only if they match a strict pattern, which prevents
  log injection.
- `/api/health` reports only up/down status.
- Passwords are hashed by Better Auth (scrypt), must be 12–128 characters, and never appear in logs.
  The length rule is also enforced on the admin create-user endpoint, which Better Auth leaves
  unchecked (found by a test).
- Sign-in failures always return the same message whether the email exists or not. Sign-in is
  limited to 5 attempts per minute per IP in production, counted in Postgres (`rate_limits`,
  shared with the API limiter), so the limit holds across restarts and instances.
- Session cookies are `HttpOnly` and `SameSite=Lax`, and `Secure` in production. Better Auth rejects
  cross-origin auth requests.
- `?next=` redirects after sign-in accept only same-origin paths, which prevents open redirects.
- Server actions re-authorize themselves, because they are reachable without their page.
- Tenant isolation: queries are scoped by the session's tenant, and composite foreign keys make
  cross-tenant links impossible in the database. `tenantId` is a server-only user field: a
  client sending it to update-user gets a 400 (tested).
- Better Auth's admin endpoints are tenant-unaware, so they are blocked over HTTP (403) and called
  only from server actions that first check the target user is in the actor's tenant. A
  cross-tenant user id gets the same "not found" as a missing one.
- Prompt injection: the demo dataset includes 10 injection attempts (in pasted logs, HTML
  comments, Hinglish and Tanglish) so detection can be measured; see `evals/`.
- Supabase: RLS is enabled on every table with no policies, so the public Data API cannot read or
  write anything. A test enforces this for new tables.

## Testing

- **Unit:** env validation, the error-to-HTTP mapping, request-ID handling, JSON body parsing,
  the full RBAC matrix, open-redirect cases, the self-lockout guard.
- **Integration:** the real migrations applied to PGlite with pgvector. Covers constraints, cascades,
  role defaults, ticket numbering, the generated full-text vector, cosine ordering, embedding
  dimension checks, the citation/evaluation checks, RLS on every table, and cross-tenant links
  rejected by composite foreign keys.
- **Seed pipeline:** the deterministic planner (300 tickets, 10 injections, languages matched to
  region, real duplicate charges behind "charged twice" tickets), the Claude client's
  validate-and-retry loop and generation checks against a labeled MOCK API, the loader on PGlite
  (idempotent, leaves app-created rows alone, rolls back on failure), and the golden set format.
- **Auth integration:** the real Better Auth config on PGlite. Covers password hashing, role
  defaults, disabled sign-up, password length, invalid roles, sessions and sign-out, forged
  cookies, admin-only endpoints denied to agents and viewers, and ban revoking live sessions.
- **API and AI integration:** the real route handlers with real Better Auth sessions (tickets,
  email intake, PATCH, idempotency, size limits, rate limits, tenant isolation), triage, the
  knowledge base, draft replies and analytics, all on PGlite with MOCK models and embedder.
- **E2E (Playwright, `npm run test:e2e`):** 16 browser tests against the running app, using the
  installed Microsoft Edge (no browser download). Sign-in (form, wrong password, Try as Guest,
  redirects), role restrictions, security headers, an agent's ticket workflow (search, assign
  to me, reply, resolve, the "Mine" filter), incidents (create, link a ticket, resolve; viewers
  can't edit), the knowledge base (upload, duplicate rejected,
  English and Hinglish search, delete, PDF and Word uploads; viewers can't upload) and analytics (tiles, chart hover,
  table view, range switch) and the theme toggle. Start the app first (`npm run build && npm run start`, demo
  accounts seeded). Tests run one at a time, reuse saved sessions (the app allows 5 sign-ins
  per minute), and label everything they create "[E2E]"; created tickets stay in the database.

## CI

`.github/workflows/ci.yml` runs on pushes and pull requests: typecheck, lint, format check,
migration drift check (fails if the schema changed without a committed migration), tests with
coverage, and a production build with no secrets. A second job builds the Docker images, starts
the Compose stack, waits for `/api/health` and checks the native modules load.

## Deployment

### Docker

```bash
cp .env.example .env      # set BETTER_AUTH_SECRET; optional ANTHROPIC_API_KEY switches to Claude
docker compose up --build # http://localhost:3000
```

`compose.yaml` runs four services:

| Service   | Image                     | What it does                                                        |
| --------- | ------------------------- | ------------------------------------------------------------------- |
| `db`      | `pgvector/pgvector:pg17`  | Postgres with pgvector, data in the `pgdata` volume                 |
| `migrate` | `tools` target            | Applies `drizzle/` migrations, then exits                           |
| `app`     | `runner` target (default) | The web app; starts only after `migrate` succeeds                   |
| `worker`  | `tools` target            | The job queue (AI triage); stops cleanly on `docker stop` (SIGTERM) |

The `Dockerfile` builds two images from one dependency install:

- **`runner`**: Next.js `output: "standalone"`, which copies only the files the server actually
  loads (about 120 MB of app and modules instead of the full `node_modules`). Runs as the
  non-root `node` user and has a `HEALTHCHECK` on `/api/health`. The build gets no secrets.
- **`tools`**: the source plus all dependencies, for things that run TypeScript through `tsx`:
  the worker, `drizzle-kit migrate`, and the CLI scripts.

Both use Debian slim rather than Alpine, because `onnxruntime-node` (local embeddings) ships
glibc binaries only. That module and `sharp` are loaded through computed `require` calls that
file tracing cannot see, so `next.config.ts` lists them in `outputFileTracingIncludes` (only the
build platform's binaries). CI builds the stack, waits for the health check and checks that both
native modules load in the app image.

The embedding model (~130 MB) downloads on the first search into the `model-cache` volume, so
it survives restarts and rebuilds. Containers always use the bundled database; `DATABASE_URL` in
`.env` is ignored by Compose. `POSTGRES_PASSWORD`, `POSTGRES_PORT` (host port, default 5432,
bound to 127.0.0.1) and `APP_PORT` (default 3000) can be set in `.env`.

One-off commands run in the `tools` image:

```bash
# "-e ADMIN_PASSWORD" with no value passes it through from your shell, keeping it out of history
docker compose run --rm -e TENANT_SLUG=acme -e ADMIN_NAME="Your Name" \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD worker npm run auth:create-admin
docker compose run --rm worker npm run db:seed:demo   # needs DEMO_USER_PASSWORD in .env
docker compose run --rm worker npm run seed:load
docker compose down        # stop; add --volumes to also delete the database and model cache
```

### Vercel + Supabase or Neon

See [docs/deployment.md](docs/deployment.md): connection strings, migrations, environment
variables, the first admin, where to run the worker, embeddings on serverless, and when to pick
Docker instead. The build needs no secrets, startup validates the environment, and
`/api/health` serves as the readiness probe.

## Known limitations (current phase)

- The committed demo dataset and golden set are template-written (`seed:templates`): plainer and
  more repetitive than Claude-written text, and the golden labels are the plan's, not
  human-verified (`review_status` stays `ai_labeled`).
- Migration 0003 adds `NOT NULL tenant_id` without a backfill. That is safe because no database
  held data when it was written; one with existing rows would need a backfill step first.
- RLS policies are not used for tenant isolation (the app connects as the table owner). Isolation
  relies on service-layer filtering plus composite foreign keys.

- Incidents are created and linked by hand; there is no AI incident summary or automatic
  grouping yet. There are no internal notes, ticket merging or SLA timers either.
- Analytics days are UTC days (there is no per-tenant time zone yet), and the LLM-judge answer
  evaluation from Phase 6 is not built. Charts use the validated dataviz reference palette
  (`--viz-*` tokens in `globals.css`); every mark carries a visible value label.
- Reply emails are not threaded: a customer's answer arrives as a new ticket. Outbound email is
  tested with a mock mailer only; no real Resend account has been used yet.
- Draft replies are tested with a mock model only (no API key yet); their real quality is
  unmeasured.
- Knowledge-base answers are tested with a mock model only (no API key yet); their real quality
  is unmeasured, and there is no answer eval yet. Retrieval was checked with the real embedding
  model on a few examples, not on a benchmark.
- Uploads embed inside the request (a few seconds for a large file on first use while the
  model loads).
- The Claude triage eval has not been run (no key yet), so Claude's real accuracy is unmeasured.
  The free rules triage has been measured (see [Free mode](#free-mode-no-api-key)).
- The installed SDK's structured-output helper (`@anthropic-ai/sdk` 0.135) sends enum values as
  a description hint, not an `enum` constraint, so the API does not enforce them. Zod validates
  every answer afterwards; an out-of-range value fails the call and the job retries.
- Triage overwrites the ticket's priority, including one set by the creating webhook.
- API keys are created from the command line only (no settings page yet) and all have the same
  scope: read and create tickets.
- The content security policy allows inline scripts (`'unsafe-inline'`), which Next.js needs
  without per-request nonces; nonces would make every page dynamic. Everything else is
  same-origin only.
- Inbox search uses `ILIKE` substring matching (wildcards escaped), which scans the tenant's rows.
  Fine at demo scale; larger tenants would want the full-text index in Phase 4's search work.
- No password reset or email verification yet (Resend could send them, but the flows are not
  built). Admins set initial passwords.
- Integration tests use PGlite (Postgres compiled to WASM). It runs real Postgres SQL and pgvector,
  but there has been no test run against a hosted Postgres yet.
- `npm audit` reports 5 high-severity advisories in `braces`, pulled in only by dev tooling
  (`eslint-config-next`, the `shadcn` CLI). It is a dev dependency and not part of the production bundle. The
  suggested `--force` fix would downgrade Next's ESLint config to v14, so it is deferred until
  upstream ships a fix.
- `npm audit` also reports 4 moderate advisories in an old `esbuild` bundled by `drizzle-kit` (the
  migration CLI, a dev dependency). The advisory concerns esbuild's dev server, which is not used.

## Roadmap

1. ✅ Foundation: schema, migrations, env validation, logging, errors, tests, CI
2. ✅ Auth & roles: Better Auth, sessions, admin / agent / viewer, labeled demo seed, sidebar shell
3. ✅ Tickets: create API (JSON + raw email, API keys), job queue, inbox list / filter / search /
   paginate, detail page, status workflow, assignment, agent replies, guest demo login
4. ✅ Knowledge base: upload (.md / .txt), chunk, local embeddings, hybrid retrieval, cited
   answers + fallback, search-only mode without a key, ✅ PDF / Word upload
5. AI copilot: ✅ triage (PII redaction, structured classification, routing, injection flag,
   token and latency tracking, golden-set eval script; eval not yet run), ✅ cited draft
   replies with approve / edit / reject and an approvals queue, ✅ outbound reply email (Resend)
6. Analytics & evals: ✅ dashboard (ticket volume, created vs resolved per day, median first
   response and resolution times, status / priority / category, draft approval and edit
   rates, triage and knowledge-base usage, tokens, workload), ✅ triage golden-set eval script;
   LLM judge for answers still to do
7. Hardening: ✅ API rate limiting, ✅ idempotent webhooks, ✅ security headers, ✅ request size
   limits, ✅ Playwright E2E, ✅ Docker (standalone image, Compose
   stack, CI smoke test), ✅ Vercel + Supabase/Neon guide
8. Incidents: ✅ create, status and severity, link tickets by number, alert and log evidence;
   AI incident summary still to do (needs a Claude key)
