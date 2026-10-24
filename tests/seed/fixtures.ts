import type { StructuredClient, StructuredRequest } from "../../seed/lib/claude";
import { ACCOUNT_QUOTAS, buildAccountsAndOrders, buildTicketSlots } from "../../seed/lib/plan";
import type { SeedData, Ticket } from "../../seed/lib/schemas";
import type { z } from "zod";

/** Stand-in for Claude-written account profiles (same shape and regional quotas). */
export function fakeProfiles() {
  return (Object.entries(ACCOUNT_QUOTAS) as [keyof typeof ACCOUNT_QUOTAS, number][]).flatMap(
    ([region, count]) =>
      Array.from({ length: count }, (_, i) => ({
        region,
        companyName: `${region} company ${i}`,
        contactName: `Contact ${region} ${i}`,
        contactEmail: `contact${i}@${region.replace("_", "")}.example`,
        country: region === "international" ? "United States" : "India",
        city: "City",
        industry: "Retail",
      })),
  );
}

/** Plan + MOCK ticket text for every slot (what generate.mts would produce, minus Claude). */
export function fakeDataset() {
  const { accounts, orders } = buildAccountsAndOrders(fakeProfiles());
  const slots = buildTicketSlots(accounts, orders);
  const tickets: Ticket[] = slots.map((slot) => {
    const account = accounts.find((a) => a.ref === slot.accountRef)!;
    return {
      ref: slot.label.ref,
      subject: `MOCK subject ${slot.label.ref}`,
      body: `MOCK body for ${slot.label.ref} ${slot.orderRef ?? ""}`.trim(),
      followUp: slot.followUp ? "MOCK follow-up" : null,
      accountRef: account.ref,
      customerName: account.contactName,
      customerEmail: account.contactEmail,
      incidentRef: slot.label.incidentRef,
      createdAt: slot.createdAt,
    };
  });
  return { accounts, orders, slots, tickets };
}

const meta = {
  notice: "MOCK",
  generator: "test",
  model: null,
  generatedAt: new Date(0).toISOString(),
};

/** A small but complete SeedData object for loader tests. */
export function smallSeedData(): SeedData {
  const { accounts, orders, slots, tickets } = fakeDataset();
  const someTickets = tickets
    .filter((t) => t.incidentRef)
    .slice(0, 2)
    .concat(tickets.slice(0, 3));
  return {
    accounts: { meta, items: accounts },
    orders: { meta, items: orders },
    kbArticles: {
      meta,
      items: [
        {
          ref: "KB-005",
          title: "Duplicate charges",
          category: "billing",
          body: "Overview.\n\n## Refunds\n\nWe refund duplicates within 5-7 business days.",
        },
        {
          ref: "KB-015",
          title: "Resetting your password",
          category: "account",
          body: "## Steps\n\nUse the reset link. It is valid for one hour.",
        },
      ],
    },
    runbooks: {
      meta,
      items: [
        {
          ref: "RB-001",
          title: "Runbook: Refunding a duplicate charge",
          body: "## Steps\n\n1. Verify both charges.\n2. Refund the later one.",
        },
      ],
    },
    incidents: {
      meta,
      items: [
        {
          ref: "INC-001",
          title: "Razorpay webhooks failing",
          summary:
            "Signature verification failed after a secret rotation, so paid invoices stayed open.",
          alert: { alert: "webhook_failures_high" },
          logs: "log line\n".repeat(80),
          severity: "sev1",
          runbookRef: "RB-002",
          startedAt: "2026-09-08T06:10:00.000Z",
          resolvedAt: "2026-09-08T09:45:00.000Z",
        },
      ],
    },
    tickets: { meta, items: someTickets },
    ticketLabels: { meta, items: slots.map((s) => s.label) },
  };
}

/** MOCK StructuredClient: answers each call with `respond(request)`. No network, no cost. */
export function mockStructuredClient(
  respond: (request: StructuredRequest<z.ZodType>) => unknown,
): StructuredClient & { requests: StructuredRequest<z.ZodType>[] } {
  const requests: StructuredRequest<z.ZodType>[] = [];
  return {
    model: "mock-model",
    requests,
    usage: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    async call(request) {
      requests.push(request as StructuredRequest<z.ZodType>);
      const value = request.schema.parse(respond(request as StructuredRequest<z.ZodType>));
      const errors = request.check?.(value) ?? [];
      if (errors.length) throw new Error(errors.join("\n"));
      return value;
    },
  };
}
