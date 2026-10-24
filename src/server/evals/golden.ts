import { z } from "zod";
import { ticketCategory, ticketPriority } from "@/db/schema/enums";

/**
 * One row of evals/golden_tickets.jsonl: a ticket with the triage answer we expect. The ticket
 * text is included so the file is self-contained for human review. See evals/README.md for the
 * labeling rules.
 */
export const goldenTicketSchema = z.strictObject({
  ticket_ref: z.string().regex(/^T-\d{4}$/),
  subject: z.string().min(1),
  body: z.string().min(1),
  language: z.enum(["en", "hinglish", "tanglish"]),
  category: z.enum(ticketCategory.enumValues),
  priority: z.enum(ticketPriority.enumValues),
  /** The KB article that answers the ticket, or null when none does (feature requests, bugs...). */
  expected_kb_article_id: z
    .string()
    .regex(/^KB-\d{3}$/)
    .nullable(),
  is_injection: z.boolean(),
  /** ai_labeled until a person has checked the row; only human_verified rows are trusted fully. */
  review_status: z.enum(["ai_labeled", "human_verified"]),
  notes: z.string().nullable(),
});

export type GoldenTicket = z.infer<typeof goldenTicketSchema>;

/** Parses JSONL text, reporting the line number of every invalid or duplicate row. */
export function parseGoldenJsonl(text: string): GoldenTicket[] {
  const rows: GoldenTicket[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      errors.push(`line ${i + 1}: not valid JSON`);
      return;
    }
    const parsed = goldenTicketSchema.safeParse(json);
    if (!parsed.success) {
      errors.push(`line ${i + 1}: ${z.prettifyError(parsed.error).replace(/\n/g, "; ")}`);
      return;
    }
    if (seen.has(parsed.data.ticket_ref))
      errors.push(`line ${i + 1}: duplicate ${parsed.data.ticket_ref}`);
    seen.add(parsed.data.ticket_ref);
    rows.push(parsed.data);
  });
  if (errors.length) throw new Error(`Invalid golden set:\n${errors.join("\n")}`);
  return rows;
}

export function toGoldenJsonl(rows: GoldenTicket[]): string {
  return rows.map((row) => JSON.stringify(goldenTicketSchema.parse(row))).join("\n") + "\n";
}
