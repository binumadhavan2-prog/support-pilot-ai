import { z } from "zod";
import { ticketCategory, ticketPriority, ticketSentiment } from "@/db/schema/enums";

/*
 * DEMO DATA schemas. Every file in seed/data is validated with these on write (generate) and on
 * read (load), so a hand edit or a model mistake fails loudly instead of loading bad rows.
 */

export const categorySchema = z.enum(ticketCategory.enumValues);
export const prioritySchema = z.enum(ticketPriority.enumValues);
export const sentimentSchema = z.enum(ticketSentiment.enumValues);
export const languageSchema = z.enum(["en", "hinglish", "tanglish"]);

export const kbRefSchema = z.string().regex(/^KB-\d{3}$/);
export const runbookRefSchema = z.string().regex(/^RB-\d{3}$/);
export const ticketRefSchema = z.string().regex(/^T-\d{4}$/);
export const accountRefSchema = z.string().regex(/^ACC-\d{4}$/);
export const orderRefSchema = z.string().regex(/^INV-\d{5}$/);
export const incidentRefSchema = z.string().regex(/^INC-\d{3}$/);

/** Every data file is `{ meta, items }` so the demo label travels with the data. */
export const metaSchema = z.object({
  notice: z.string(),
  generator: z.string(),
  model: z.string().nullable(),
  generatedAt: z.iso.datetime(),
});
export const dataFile = <T extends z.ZodType>(item: T) =>
  z.object({ meta: metaSchema, items: z.array(item) });

// --- Model output (what Claude writes) ---

export const articleBodySchema = z.object({
  ref: kbRefSchema,
  // Markdown, using ## headings for sections.
  body: z.string().min(400).max(6000),
});

export const runbookBodySchema = z.object({
  ref: runbookRefSchema,
  body: z.string().min(600).max(8000),
});

export const accountProfileSchema = z.object({
  companyName: z.string().min(2).max(80),
  contactName: z.string().min(3).max(60),
  contactEmail: z.email(),
  country: z.string().min(2).max(40),
  city: z.string().min(2).max(40),
  industry: z.string().min(2).max(60),
});

export const ticketTextSchema = z.object({
  ref: ticketRefSchema,
  subject: z.string().min(3).max(140),
  body: z.string().min(20).max(3000),
  // Optional second customer message (e.g. "any update??"), sent hours later.
  followUp: z.string().min(5).max(1500).nullable(),
});

export const incidentTextSchema = z.object({
  ref: incidentRefSchema,
  title: z.string().min(5).max(140),
  summary: z.string().min(50).max(2000),
  alert: z.record(z.string(), z.unknown()),
  logs: z.string().min(500).max(12000),
});

// --- Files in seed/data ---

export const kbArticleSchema = z.object({
  ref: kbRefSchema,
  title: z.string(),
  category: categorySchema,
  body: z.string(),
});

export const runbookSchema = z.object({
  ref: runbookRefSchema,
  title: z.string(),
  body: z.string(),
});

/** Drives ticket language: Hinglish from north India, Tanglish from Tamil Nadu. */
export const regionSchema = z.enum(["north_india", "tamil_nadu", "international"]);

export const accountSchema = accountProfileSchema.extend({
  ref: accountRefSchema,
  region: regionSchema,
  plan: z.enum(["starter", "growth", "scale", "enterprise"]),
  billingCycle: z.enum(["monthly", "annual"]),
  status: z.enum(["active", "trialing", "past_due", "suspended", "canceled"]),
  currency: z.enum(["USD", "INR", "EUR", "GBP"]),
  mrrCents: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});

export const orderSchema = z.object({
  ref: orderRefSchema,
  accountRef: accountRefSchema,
  description: z.string(),
  amountCents: z.number().int().nonnegative(),
  currency: accountSchema.shape.currency,
  status: z.enum(["paid", "pending", "failed", "refunded"]),
  orderedAt: z.iso.datetime(),
});

export const ticketSchema = ticketTextSchema.extend({
  accountRef: accountRefSchema,
  customerName: z.string(),
  customerEmail: z.email(),
  incidentRef: incidentRefSchema.nullable(),
  createdAt: z.iso.datetime(),
});

export const incidentSchema = incidentTextSchema.extend({
  severity: z.enum(["sev1", "sev2", "sev3", "sev4"]),
  runbookRef: runbookRefSchema,
  startedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime(),
});

/**
 * The labels each ticket was generated to satisfy. Kept out of the database (tickets load
 * untriaged) and used only to pre-fill the golden eval set.
 */
export const ticketLabelSchema = z.object({
  ref: ticketRefSchema,
  category: categorySchema,
  priority: prioritySchema,
  sentiment: sentimentSchema,
  language: languageSchema,
  expectedKbArticleId: kbRefSchema.nullable(),
  isInjection: z.boolean(),
  incidentRef: incidentRefSchema.nullable(),
  scenario: z.string(),
});

export type KbArticle = z.infer<typeof kbArticleSchema>;
export type Runbook = z.infer<typeof runbookSchema>;
export type Account = z.infer<typeof accountSchema>;
export type Order = z.infer<typeof orderSchema>;
export type Ticket = z.infer<typeof ticketSchema>;
export type Incident = z.infer<typeof incidentSchema>;
export type TicketLabel = z.infer<typeof ticketLabelSchema>;
export type Meta = z.infer<typeof metaSchema>;

export const DATA_FILES = {
  kbArticles: { file: "kb_articles.json", schema: dataFile(kbArticleSchema) },
  runbooks: { file: "runbooks.json", schema: dataFile(runbookSchema) },
  accounts: { file: "accounts.json", schema: dataFile(accountSchema) },
  orders: { file: "orders.json", schema: dataFile(orderSchema) },
  tickets: { file: "tickets.json", schema: dataFile(ticketSchema) },
  ticketLabels: { file: "ticket_labels.json", schema: dataFile(ticketLabelSchema) },
  incidents: { file: "incidents.json", schema: dataFile(incidentSchema) },
} as const;

export type SeedData = {
  [K in keyof typeof DATA_FILES]: z.infer<(typeof DATA_FILES)[K]["schema"]>;
};
