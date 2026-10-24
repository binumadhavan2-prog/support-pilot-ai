@AGENTS.md

# Support Pilot AI: project conventions

AI support and operations copilot: ticket management, RAG answers with citations, AI-drafted replies
that always need human approval. This is a portfolio project, but it is built to production standards.

## Stack

Next.js 16 (App Router, Cache Components on), React 19, TypeScript strict, Tailwind v4, shadcn/ui (Radix, lucide icons),
PostgreSQL + pgvector through Drizzle ORM, Zod 4, pino, Vitest 5 (+ PGlite for DB tests),
Playwright (Phase 7), Better Auth, Claude API (seed generator now, AI features Phase 4–6), local
embeddings via transformers.js (`multilingual-e5-small`, 384 dims, no API key).

Next 16 differs from older versions. Read `node_modules/next/dist/docs/` before using an API you
have not checked (e.g. `middleware` is now `proxy`, and dynamic data needs `connection()` or a
request-time API under Cache Components).

## Commands

- `npm run dev`: dev server (`npm run dev:pretty` for readable logs)
- `npm run check`: typecheck + lint + format check + tests. Run it before saying work is done.
- `npm run build`: production build. Must succeed with **no** env vars set.
- `docker compose up --build`: full stack (db, migrate, app, worker). `Dockerfile` targets `runner` (standalone app)
  and `tools` (worker, migrations, scripts). A package loaded by computed `require` (like `onnxruntime-node`, `sharp`)
  must be listed in `outputFileTracingIncludes` in `next.config.ts`, or the image breaks at runtime.
  Vercel + Supabase/Neon: `docs/deployment.md` (keep it in sync with env and runtime changes).
- `npm run test` / `test:watch` / `test:coverage`
- `npm run test:e2e`: Playwright browser tests (`tests/e2e`) against the running app on :3000, using installed Edge.
  Address controls by id where Next keeps a previous page mounted (e.g. `#ticket-status`).
- `npm run db:generate`: create a migration after editing `src/db/schema/*`. Commit the SQL and `drizzle/meta`.
- `npm run db:migrate`: apply migrations to `DATABASE_URL`
- `npm run seed:generate` / `seed:load` / `seed:golden`: demo dataset (see `seed/`, `evals/README.md`)

## Layout

- `src/app`: routes. Route handlers live in `src/app/api/**/route.ts`.
- `src/env.ts`: the only place that reads `process.env` (except `logger.ts`, `instrumentation.ts`, `drizzle.config.ts`,
  and `next.config.ts` for `NODE_ENV` only).
- `src/server/rate-limit.ts`: Postgres fixed-window limiter, applied in `requireApiPermission`. Ticket creation takes an
  `idempotencyKey` (`src/app/api/tickets/idempotency.ts`). Security headers live in `next.config.ts`.
- `src/db/schema/*`: Drizzle tables, one file per domain. `src/db/client.ts` has the lazy `getDb()`.
- `src/lib/errors.ts`: `AppError` + codes. `src/lib/api/handler.ts`: `withApiHandler`, `parseJsonBody`.
- `src/lib/logger.ts`: pino logger with secret redaction.
- `src/server/*`: services holding business logic. Route handlers and server actions stay thin.
- `src/server/auth/`: `permissions.ts` (the RBAC matrix, pure), `auth.ts` (Better Auth config, `createAuth`/`getAuth`),
  `session.ts` (data access layer: `requirePermission` for actions and APIs, `requirePagePermission` for pages).
- `src/proxy.ts`: optimistic cookie-presence redirect only. Never rely on it for authorization. Add new signed-in routes to its matcher.
- `src/components/ui/*`: shadcn/ui components (add with `npx shadcn@latest add <name>`). Local edits are marked
  with a "Local change" comment; keep them when re-adding. `src/hooks/use-mobile.ts` is also locally rewritten.
- `src/components/app-ui.tsx`, `app-sidebar.tsx`, `not-built-yet.tsx`: app components built on shadcn/ui.
- `src/lib/navigation.ts`: sidebar items and the permission each needs. Pages enforce the same permission.
- `scripts/*.mts`: CLI scripts (run via npm scripts with `--conditions=react-server`).
- `src/db/schema/tenancy.ts`: `tenants`, the `tenantId()` column and the same-tenant FK helpers.
- `src/db/types.ts`: `AnyDatabase`. Services take it (not `getDb()` directly) so tests can pass PGlite.
- `src/server/tenants.ts`: `ensureTenant`, `listTenantUsers`, `assertUserInTenant`.
- `src/server/tickets.ts`: create (ticket + message + audit + triage job in one transaction), list, get.
  `src/server/api-keys.ts` + `src/server/auth/api-auth.ts`: Bearer API keys, `requireApiPermission` for `/api/tickets/**`.
- `src/server/jobs.ts`: Postgres job queue (`enqueueJob` inside the caller's transaction, `processNextJob`
  with injected `JobServices`). `scripts/worker.mts` runs it.
- `src/server/ai/`: `redact.ts` (PII -> `[EMAIL_1]` tokens, reversible), `triage.ts` (prompt
  `prompts/triage_v1.md`, Zod output schema, Claude call, routing rules, `triageTicket` job body),
  `model.ts` (env-configured model). Tests use `tests/ai/mock-triage-model.ts`, never the network.
- `src/server/evals/triage-eval.ts` + `evals/run-triage.mts`: golden-set scoring (`npm run eval:triage`, paid).
  A new prompt version gets a new file (`triage_v2.md`) and `TRIAGE_PROMPT_VERSION`; don't edit a measured prompt in place.
- `tests/api/`: route-handler tests on PGlite with real Better Auth sessions (only `getDb`/`getAuth`/`headers` are swapped).
- `src/server/knowledge/`: `chunk.ts` (markdown chunker), `embeddings.ts` (local model, `embed(texts, "query" | "passage")`),
  `documents.ts` (upload checks, add / index / list / delete), `search.ts` (hybrid search), `embedder.ts` (env-aware, may be null).
- `src/server/ai/claude.ts`: `callStructured` (structured output, fallbacks, usage). `answer.ts`: `askKnowledgeBase`.
  `drafts.ts`: `generateDraft` (help articles only, holding-reply fallback), `reviewDraft` (the human approval step).
  Tests use `tests/ai/mock-knowledge.ts` (mock embedder, answer and draft models).
- `src/server/evals/golden.ts`: schema + parser for `evals/golden_tickets.jsonl`.
- `seed/`: DEMO DATA pipeline. `lib/plan.ts` decides labels in code, `lib/generate.ts` has Claude write text,
  `lib/load-data.ts` loads tenant "acme". `seed/data/*.json` is generated output; edit the catalog/plan, not the JSON.
- `tests/db/test-db.ts`: `createTestDb()` gives a migrated in-memory Postgres for integration tests.
- `drizzle/`: generated SQL migrations. Never edit an applied migration; add a new one.

## Rules

**Security**

- Secrets are read only on the server. Never use `NEXT_PUBLIC_` for keys. Any module touching
  secrets, the DB or the Claude API starts with `import "server-only"`.
- Validate every external input (body, params, query, uploaded files, model output) with Zod.
- Check authorization on the server in every handler, server action and page with the `session.ts` helpers.
  Hiding UI is not a control. A new permission goes in `permissions.ts` and its test matrix.
- Read `await headers()` / `cookies()` before calling `getAuth()`/`getDb()` in render paths, so prerendering
  stops before needing secrets. Session-reading components go inside `<Suspense>`.
- Never log secrets, tokens, passwords or full documents. The logger's redact list is a backstop, not permission.
- Error responses never include stack traces, SQL or upstream messages. Throw `AppError` with a safe message.

**AI behavior**

- AI output is a draft. Nothing reaches a customer without a human approval recorded in `ai_drafts` + `audit_logs`.
- Answers must cite retrieved chunks. When evidence is insufficient, return the fallback
  (`grounding_status = insufficient_evidence`). Never let the model answer from general knowledge.
- Record model, tokens and latency for every model call.

**Tenancy**

- Every business table has `tenantId: tenantId()`. Every query on it filters by `user.tenantId` from the session.
  Never take a tenant id from the request.
- A child row referencing a tenant-owned parent uses `sameTenantCascade`, or `sameTenantCheck` next to a
  single-column `set null` FK for nullable references; the parent needs `unique(id, tenant_id)`. Add a
  cross-tenant rejection test in `tests/db/schema.test.ts`.
- drizzle-kit emits the composite FKs before the `unique(id, tenant_id)` they need when both are added to existing
  tables: move the UNIQUE statements up in the generated SQL (see migration 0003).
- Better Auth admin endpoints are blocked over HTTP. Call `auth.api.*` from server actions only, after
  `assertUserInTenant`. New users get `data: { tenantId }`.

**Data**

- Timestamps are `timestamptz`. IDs are UUIDs, except auth tables (text IDs owned by Better Auth).
- Every new table must get `ENABLE ROW LEVEL SECURITY` in its migration (Supabase Data API exposure). A test enforces this.
- Deleting users must not delete business records (`on delete set null`). Child rows cascade from their parent.

**Testing and honesty**

- Test important behavior and edge cases. Use `createTestDb()` for anything touching SQL.
  Don't mock Drizzle.
- Mocks of external APIs (Claude, the embedding model) are allowed in tests only, and must be named or commented as mocks.
- Never report a check as passing unless it was actually run in this session. Quote the real output.
- Seed and demo data must be labeled as demo data in the UI and code. Seed rows have an `external_ref`;
  the loader replaces only those, never rows created in the app.
- Ground-truth labels (`seed/data/ticket_labels.json`, `evals/`) never go into the database or into prompts.
- An unbuilt section shows `<NotBuiltYet>`, never sample data.

**UI**

- Use theme tokens (`bg-background`, `text-muted-foreground`, `border`) rather than raw palette colors.
- Client Components must not read `Math.random()`, `Date.now()` or similar during render: Cache Components
  fails the build when it prerenders them.

## Style

Prettier (100 cols, double quotes, trailing commas) + ESLint (next config), zero warnings.
Comments explain _why_, not _what_. Keep functions small and typed. Avoid `any`.
