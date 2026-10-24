import { pgEnum } from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["admin", "agent", "viewer"]);

export const ticketStatus = pgEnum("ticket_status", ["open", "pending", "resolved", "closed"]);
export const ticketPriority = pgEnum("ticket_priority", ["low", "normal", "high", "urgent"]);
export const ticketCategory = pgEnum("ticket_category", [
  "billing",
  "technical",
  "account",
  "feature_request",
  "other",
]);
export const ticketSentiment = pgEnum("ticket_sentiment", ["positive", "neutral", "negative"]);
export const messageAuthorType = pgEnum("message_author_type", ["customer", "agent", "system"]);
/**
 * Delivery of an agent reply to the customer by email. `skipped`: deliberately not sent (email not
 * configured, demo ticket, or a reserved test address); the reason is in `email_detail`.
 */
export const emailStatus = pgEnum("email_status", ["queued", "sent", "failed", "skipped"]);

export const draftStatus = pgEnum("draft_status", ["pending", "approved", "edited", "rejected"]);
/** Whether retrieved evidence was sufficient; `insufficient_evidence` triggers the fallback reply. */
export const groundingStatus = pgEnum("grounding_status", ["grounded", "insufficient_evidence"]);

export const documentStatus = pgEnum("document_status", ["processing", "ready", "failed"]);
export const evaluator = pgEnum("evaluator", ["llm_judge", "human"]);

/** Knowledge-base content type. Runbooks are internal procedures; articles can be cited to customers. */
export const documentKind = pgEnum("document_kind", ["article", "runbook"]);

/**
 * Lifecycle of an action the AI proposes (e.g. a refund). Nothing executes without a human
 * approval: pending -> approved -> executed, or pending -> rejected.
 */
export const toolCallStatus = pgEnum("tool_call_status", [
  "pending",
  "approved",
  "rejected",
  "executed",
]);

export const incidentStatus = pgEnum("incident_status", [
  "open",
  "investigating",
  "mitigated",
  "resolved",
]);
export const incidentSeverity = pgEnum("incident_severity", ["sev1", "sev2", "sev3", "sev4"]);

export const evalRunStatus = pgEnum("eval_run_status", ["running", "completed", "failed"]);

/**
 * Queues tickets are routed to. The model suggests one of the first five; routing rules can
 * escalate to `lead` (urgent or angry customers).
 */
export const supportTeam = pgEnum("support_team", [
  "billing",
  "technical",
  "account",
  "product",
  "general",
  "lead",
]);

export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed"]);
