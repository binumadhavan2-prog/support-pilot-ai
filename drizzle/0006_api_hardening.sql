CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE INDEX "rate_limits_window_idx" ON "rate_limits" USING btree ("window_start");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_idempotency_uq" UNIQUE("tenant_id","idempotency_key");--> statement-breakpoint
-- Deny-by-default for the Supabase Data API, as in migration 0002.
ALTER TABLE "rate_limits" ENABLE ROW LEVEL SECURITY;
