-- Multi-tenancy, triage / tool calls / incidents / evals, 384-dim local embeddings.
-- Adds NOT NULL tenant_id columns without a backfill: written before any database held data.
-- A database with existing rows would need a backfill step first.
CREATE TYPE "public"."document_kind" AS ENUM('article', 'runbook');--> statement-breakpoint
CREATE TYPE "public"."eval_run_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."incident_severity" AS ENUM('sev1', 'sev2', 'sev3', 'sev4');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('open', 'investigating', 'mitigated', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."tool_call_status" AS ENUM('pending', 'approved', 'rejected', 'executed');--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_slug_format" CHECK ("tenants"."slug" ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);
--> statement-breakpoint
CREATE TABLE "customer_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"company_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"contact_email" text NOT NULL,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"mrr_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_accounts_tenant_ref_uq" UNIQUE("tenant_id","external_ref"),
	CONSTRAINT "customer_accounts_id_tenant_uq" UNIQUE("id","tenant_id"),
	CONSTRAINT "customer_accounts_mrr_nonnegative" CHECK ("customer_accounts"."mrr_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text NOT NULL,
	"ordered_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_tenant_ref_uq" UNIQUE("tenant_id","external_ref"),
	CONSTRAINT "orders_amount_nonnegative" CHECK ("orders"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_ref" text,
	"title" text NOT NULL,
	"status" "incident_status" DEFAULT 'open' NOT NULL,
	"severity" "incident_severity" NOT NULL,
	"summary" text,
	"alert" jsonb,
	"logs" text,
	"started_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_tenant_ref_uq" UNIQUE("tenant_id","external_ref"),
	CONSTRAINT "incidents_id_tenant_uq" UNIQUE("id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"dataset_name" text NOT NULL,
	"dataset_hash" text NOT NULL,
	"model" text NOT NULL,
	"status" "eval_run_status" DEFAULT 'running' NOT NULL,
	"total_cases" integer DEFAULT 0 NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"started_by_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "eval_runs_id_tenant_uq" UNIQUE("id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"draft_id" uuid,
	"tool_name" text NOT NULL,
	"arguments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rationale" text,
	"status" "tool_call_status" DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error_message" text,
	"model" text,
	"reviewed_by_id" text,
	"reviewed_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_calls_reviewed_when_decided" CHECK ("tool_calls"."status" = 'pending' OR "tool_calls"."reviewed_at" IS NOT NULL),
	CONSTRAINT "tool_calls_executed_at_when_executed" CHECK (("tool_calls"."status" = 'executed') = ("tool_calls"."executed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "triage_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"category" "ticket_category" NOT NULL,
	"priority" "ticket_priority" NOT NULL,
	"sentiment" "ticket_sentiment" NOT NULL,
	"language" text NOT NULL,
	"is_injection" boolean DEFAULT false NOT NULL,
	"summary" text NOT NULL,
	"suggested_document_id" uuid,
	"confidence" real NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "triage_results_confidence_range" CHECK ("triage_results"."confidence" >= 0 AND "triage_results"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_content_hash_unique";--> statement-breakpoint
ALTER TABLE "ticket_messages" DROP CONSTRAINT "ticket_messages_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE "document_chunks" DROP CONSTRAINT "document_chunks_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_drafts" DROP CONSTRAINT "ai_drafts_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE "answer_evaluations" DROP CONSTRAINT "answer_evaluations_draft_id_ai_drafts_id_fk";
--> statement-breakpoint
ALTER TABLE "answer_evaluations" DROP CONSTRAINT "answer_evaluations_query_id_kb_queries_id_fk";
--> statement-breakpoint
ALTER TABLE "citations" DROP CONSTRAINT "citations_draft_id_ai_drafts_id_fk";
--> statement-breakpoint
ALTER TABLE "citations" DROP CONSTRAINT "citations_query_id_kb_queries_id_fk";
--> statement-breakpoint
DROP INDEX "tickets_status_created_idx";--> statement-breakpoint
DROP INDEX "tickets_created_idx";--> statement-breakpoint
DROP INDEX "documents_status_idx";--> statement-breakpoint
DROP INDEX "ai_drafts_status_idx";--> statement-breakpoint
DROP INDEX "kb_queries_created_idx";--> statement-breakpoint
DROP INDEX "audit_logs_created_idx";--> statement-breakpoint
ALTER TABLE "document_chunks" ALTER COLUMN "embedding" SET DATA TYPE vector(384);--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "customer_account_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "incident_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "kind" "document_kind" DEFAULT 'article' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "answer_evaluations" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "answer_evaluations" ADD COLUMN "eval_run_id" uuid;--> statement-breakpoint
ALTER TABLE "citations" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_queries" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
-- Unique (id, tenant_id) targets must exist before the composite same-tenant FKs below.
ALTER TABLE "user" ADD CONSTRAINT "user_id_tenant_uq" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_ref_uq" UNIQUE("tenant_id","external_ref");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_id_tenant_uq" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_id_tenant_uq" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_hash_uq" UNIQUE("tenant_id","content_hash");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_ref_uq" UNIQUE("tenant_id","external_ref");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_id_tenant_uq" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_id_tenant_uq" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "kb_queries" ADD CONSTRAINT "kb_queries_id_tenant_uq" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_same_tenant_fk" FOREIGN KEY ("account_id","tenant_id") REFERENCES "public"."customer_accounts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_started_by_id_user_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_reviewed_by_id_user_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_ticket_same_tenant_fk" FOREIGN KEY ("ticket_id","tenant_id") REFERENCES "public"."tickets"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_draft_same_tenant_fk" FOREIGN KEY ("draft_id","tenant_id") REFERENCES "public"."ai_drafts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_results" ADD CONSTRAINT "triage_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_results" ADD CONSTRAINT "triage_results_suggested_document_id_documents_id_fk" FOREIGN KEY ("suggested_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_results" ADD CONSTRAINT "triage_results_ticket_same_tenant_fk" FOREIGN KEY ("ticket_id","tenant_id") REFERENCES "public"."tickets"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_results" ADD CONSTRAINT "triage_results_document_same_tenant_fk" FOREIGN KEY ("suggested_document_id","tenant_id") REFERENCES "public"."documents"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_accounts_tenant_email_idx" ON "customer_accounts" USING btree ("tenant_id","contact_email");--> statement-breakpoint
CREATE INDEX "orders_account_idx" ON "orders" USING btree ("account_id","ordered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_tenant_status_idx" ON "incidents" USING btree ("tenant_id","status","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "eval_runs_tenant_started_idx" ON "eval_runs" USING btree ("tenant_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tool_calls_ticket_idx" ON "tool_calls" USING btree ("ticket_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tool_calls_tenant_status_idx" ON "tool_calls" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "triage_results_ticket_idx" ON "triage_results" USING btree ("ticket_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_same_tenant_fk" FOREIGN KEY ("ticket_id","tenant_id") REFERENCES "public"."tickets"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_account_id_customer_accounts_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_same_tenant_fk" FOREIGN KEY ("assignee_id","tenant_id") REFERENCES "public"."user"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_account_same_tenant_fk" FOREIGN KEY ("customer_account_id","tenant_id") REFERENCES "public"."customer_accounts"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_incident_same_tenant_fk" FOREIGN KEY ("incident_id","tenant_id") REFERENCES "public"."incidents"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_same_tenant_fk" FOREIGN KEY ("document_id","tenant_id") REFERENCES "public"."documents"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_ticket_same_tenant_fk" FOREIGN KEY ("ticket_id","tenant_id") REFERENCES "public"."tickets"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_evaluations" ADD CONSTRAINT "answer_evaluations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_evaluations" ADD CONSTRAINT "answer_evaluations_draft_same_tenant_fk" FOREIGN KEY ("draft_id","tenant_id") REFERENCES "public"."ai_drafts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_evaluations" ADD CONSTRAINT "answer_evaluations_query_same_tenant_fk" FOREIGN KEY ("query_id","tenant_id") REFERENCES "public"."kb_queries"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_evaluations" ADD CONSTRAINT "answer_evaluations_run_same_tenant_fk" FOREIGN KEY ("eval_run_id","tenant_id") REFERENCES "public"."eval_runs"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_draft_same_tenant_fk" FOREIGN KEY ("draft_id","tenant_id") REFERENCES "public"."ai_drafts"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_query_same_tenant_fk" FOREIGN KEY ("query_id","tenant_id") REFERENCES "public"."kb_queries"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_chunk_same_tenant_fk" FOREIGN KEY ("chunk_id","tenant_id") REFERENCES "public"."document_chunks"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_queries" ADD CONSTRAINT "kb_queries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_tenant_idx" ON "user" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tickets_tenant_status_created_idx" ON "tickets" USING btree ("tenant_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tickets_tenant_created_idx" ON "tickets" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tickets_incident_idx" ON "tickets" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "document_chunks_tenant_idx" ON "document_chunks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "documents_tenant_status_idx" ON "documents" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "ai_drafts_tenant_status_idx" ON "ai_drafts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "answer_evaluations_run_idx" ON "answer_evaluations" USING btree ("eval_run_id");--> statement-breakpoint
CREATE INDEX "kb_queries_tenant_created_idx" ON "kb_queries" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_idx" ON "audit_logs" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
-- New tables: same reason as 0002 (block the Supabase Data API; the app connects as the owner).
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incidents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "triage_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_runs" ENABLE ROW LEVEL SECURITY;
