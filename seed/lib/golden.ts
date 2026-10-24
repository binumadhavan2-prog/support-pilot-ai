import type { GoldenTicket } from "@/server/evals/golden";
import type { Ticket, TicketLabel } from "./schemas";

/**
 * Picks 100 tickets for the golden eval set, stratified so the hard cases are all represented:
 * every injection attempt, incident symptoms, code-mixed languages, tickets with no KB answer,
 * then article-backed tickets spread across as many different articles as possible.
 * Deterministic: the same inputs always give the same selection.
 */
export function selectGolden(labels: TicketLabel[], tickets: Ticket[], size = 100): GoldenTicket[] {
  const chosen = new Set<string>();
  const take = (pool: TicketLabel[], count: number) => {
    for (const label of pool) {
      if (count <= 0 || chosen.size >= size) break;
      if (chosen.has(label.ref)) continue;
      chosen.add(label.ref);
      count--;
    }
  };
  const organic = labels.filter((l) => !l.isInjection);
  // Spread picks across the timeline instead of taking the first N.
  const spread = (pool: TicketLabel[]) =>
    pool.filter((_, i) => i % 2 === 0).concat(pool.filter((_, i) => i % 2 === 1));

  take(
    labels.filter((l) => l.isInjection),
    Infinity,
  );
  for (const ref of new Set(organic.map((l) => l.incidentRef).filter(Boolean))) {
    take(spread(organic.filter((l) => l.incidentRef === ref)), 3);
  }
  take(spread(organic.filter((l) => l.language !== "en" && !l.incidentRef)), 20);
  take(spread(organic.filter((l) => l.category === "feature_request")), 8);
  take(spread(organic.filter((l) => !l.expectedKbArticleId && l.category === "technical")), 6);
  take(spread(organic.filter((l) => l.category === "other" && !l.expectedKbArticleId)), 4);

  // Fill: round-robin over articles so coverage is as wide as possible.
  const byArticle = new Map<string, TicketLabel[]>();
  for (const l of organic.filter((l) => l.expectedKbArticleId && !l.incidentRef)) {
    byArticle.set(l.expectedKbArticleId!, [...(byArticle.get(l.expectedKbArticleId!) ?? []), l]);
  }
  const queues = [...byArticle.keys()]
    .sort()
    .map((k) => byArticle.get(k)!.filter((l) => !chosen.has(l.ref)));
  while (chosen.size < size && queues.some((q) => q.length)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next && chosen.size < size) chosen.add(next.ref);
    }
  }

  return labels
    .filter((l) => chosen.has(l.ref))
    .map((label) => {
      const ticket = tickets.find((t) => t.ref === label.ref);
      if (!ticket) throw new Error(`No generated ticket for ${label.ref}`);
      return {
        ticket_ref: label.ref,
        subject: ticket.subject,
        body: ticket.followUp ? `${ticket.body}\n\n[follow-up] ${ticket.followUp}` : ticket.body,
        language: label.language,
        category: label.category,
        priority: label.priority,
        expected_kb_article_id: label.expectedKbArticleId,
        is_injection: label.isInjection,
        review_status: "ai_labeled" as const,
        notes: null,
      };
    });
}
