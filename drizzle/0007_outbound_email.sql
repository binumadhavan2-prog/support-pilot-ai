CREATE TYPE "public"."email_status" AS ENUM('queued', 'sent', 'failed', 'skipped');--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "email_status" "email_status";--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "email_detail" text;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "email_provider_id" text;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "email_sent_at" timestamp with time zone;