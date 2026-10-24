CREATE TYPE "public"."support_team" AS ENUM('billing', 'technical', 'account', 'product', 'general', 'lead');--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "team" "support_team";--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "injection_flagged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_results" ADD COLUMN "suggested_team" "support_team" DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_results" ADD COLUMN "reasoning" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_results" ADD COLUMN "prompt_version" text DEFAULT 'unknown' NOT NULL;