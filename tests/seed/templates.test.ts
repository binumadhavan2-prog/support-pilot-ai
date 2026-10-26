import { describe, expect, it } from "vitest";
import { buildAccountsAndOrders, buildTicketSlots } from "../../seed/lib/plan";
import {
  DATA_FILES,
  accountSchema,
  incidentSchema,
  kbArticleSchema,
  runbookSchema,
  ticketSchema,
} from "../../seed/lib/schemas";
import {
  relatedFacts,
  templateAccountProfiles,
  templateArticles,
  templateIncidents,
  templateRunbooks,
  templateTicket,
} from "../../seed/lib/templates";

/* The no-model DEMO DATA writer: same plan as the Claude generator, template wording. */

function build() {
  const { accounts, orders } = buildAccountsAndOrders(templateAccountProfiles());
  const slots = buildTicketSlots(accounts, orders);
  const byRef = new Map(accounts.map((a) => [a.ref, a]));
  const tickets = slots.map((slot) => templateTicket(slot, byRef.get(slot.accountRef)!));
  return { accounts, slots, tickets };
}

describe("template demo data", () => {
  const { accounts, slots, tickets } = build();

  it("passes every seed/data schema", () => {
    for (const a of accounts) accountSchema.parse(a);
    for (const t of tickets) ticketSchema.parse(t);
    for (const a of templateArticles()) kbArticleSchema.parse(a);
    for (const r of templateRunbooks()) runbookSchema.parse(r);
    for (const i of templateIncidents()) incidentSchema.parse(i);
    expect(Object.keys(DATA_FILES)).toHaveLength(7);
  });

  it("is deterministic", () => {
    expect(build().tickets).toEqual(tickets);
  });

  it("uses unique, reserved .example addresses only", () => {
    const emails = accounts.map((a) => a.contactEmail);
    expect(new Set(emails).size).toBe(emails.length);
    expect(emails.every((e) => e.endsWith(".example"))).toBe(true);
  });

  it("writes each ticket in its planned language and keeps the injection text", () => {
    const labelOf = new Map(slots.map((s) => [s.label.ref, s.label]));
    const hinglish = tickets.filter((t) => labelOf.get(t.ref)!.language === "hinglish");
    const tanglish = tickets.filter((t) => labelOf.get(t.ref)!.language === "tanglish");
    expect(hinglish.length).toBeGreaterThan(0);
    expect(tanglish.length).toBeGreaterThan(0);
    const hinglishWord = /\b(hai|nahi|karo|ho|kya|raha|bahut|mein|kaise|hoon)\b/i;
    const tanglishWord =
      /\b(irukku|pannunga|aagala|nandri|puriyala|paarunga|pathi|super|mosamana|eppadi|mudiyala|theriyala|enna)\b/i;
    expect(hinglish.filter((t) => !hinglishWord.test(t.body))).toEqual([]);
    expect(tanglish.filter((t) => !tanglishWord.test(t.body))).toEqual([]);

    const injections = tickets.filter((t) => labelOf.get(t.ref)!.isInjection);
    expect(injections).toHaveLength(10);
    expect(injections.some((t) => t.body.includes("Ignore all previous instructions"))).toBe(true);
  });

  it("describes incident symptoms without the root cause", () => {
    const incidentTickets = tickets.filter((t) => t.incidentRef === "INC-002");
    expect(incidentTickets.length).toBeGreaterThan(0);
    expect(incidentTickets.every((t) => t.subject === "Invoice PDF is blank")).toBe(true);
    expect(incidentTickets.some((t) => /fonts package/.test(t.body))).toBe(false);
  });

  it("quotes real policies from the fact sheet in articles", () => {
    const refund = templateArticles().find((a) => a.ref === "KB-004")!;
    expect(refund.body).toContain("Annual plans can be refunded pro rata within 30 days");
    expect(templateArticles().some((a) => a.body.includes("FICTIONAL"))).toBe(false);
    expect(relatedFacts("duplicate charges refunded")).toContainEqual(
      expect.stringMatching(/^Duplicate charges are refunded/),
    );
  });
});
