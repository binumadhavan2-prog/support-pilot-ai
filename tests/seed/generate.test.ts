import { describe, expect, it } from "vitest";
import { ARTICLES } from "../../seed/lib/catalog";
import {
  describeSlot,
  generateArticles,
  generateTicketBatch,
  refsMatch,
  SYSTEM_PROMPT,
} from "../../seed/lib/generate";
import { fakeDataset, mockStructuredClient } from "./fixtures";

const { accounts, orders, slots } = fakeDataset();

describe("refsMatch", () => {
  it("reports missing, unrequested and duplicated refs", () => {
    expect(refsMatch(["A", "B"], ["A", "B"])).toEqual([]);
    expect(refsMatch(["A", "A", "C"], ["A", "B"])).toEqual([
      "Missing: B.",
      "Not requested: C.",
      "Duplicated: A.",
    ]);
  });
});

describe("describeSlot", () => {
  it("tells the writer the language, priority and invoice, but never the category", () => {
    const slot = slots.find((s) => s.orderRef && s.label.language === "hinglish")!;
    const text = describeSlot(slot, accounts, orders);
    expect(text).toContain(slot.label.ref);
    expect(text).toContain(slot.orderRef!);
    expect(text).toContain("Hinglish");
    expect(text).toContain(`Priority to convey: ${slot.label.priority}`);
    expect(text).not.toMatch(/category/i);
  });

  it("flags injection slots as eval test cases", () => {
    const slot = slots.find((s) => s.label.isInjection)!;
    expect(describeSlot(slot, accounts, orders)).toContain("PROMPT-INJECTION TEST CASE");
  });
});

describe("SYSTEM_PROMPT", () => {
  it("requires fictional data on reserved .example domains and embeds the fact sheet", () => {
    expect(SYSTEM_PROMPT).toContain('".example"');
    expect(SYSTEM_PROMPT).toContain("FICTIONAL");
    expect(SYSTEM_PROMPT).toContain("Starter: $29/month");
  });
});

describe("generateArticles (MOCK client)", () => {
  it("keeps title and category from the catalog, body from the model", async () => {
    const specs = ARTICLES.slice(0, 2);
    const client = mockStructuredClient(() => ({
      articles: specs.map((s) => ({ ref: s.ref, body: `MOCK ${"x".repeat(400)}` })),
    }));
    const articles = await generateArticles(client, specs);
    expect(articles.map((a) => [a.ref, a.title, a.category])).toEqual(
      specs.map((s) => [s.ref, s.title, s.category]),
    );
  });

  it("rejects an answer that skips a requested article", async () => {
    const specs = ARTICLES.slice(0, 2);
    const client = mockStructuredClient(() => ({
      articles: [{ ref: specs[0].ref, body: `MOCK ${"x".repeat(400)}` }],
    }));
    await expect(generateArticles(client, specs)).rejects.toThrow(/Missing: KB-002/);
  });
});

describe("generateTicketBatch (MOCK client)", () => {
  const batch = slots.filter((s) => s.orderRef).slice(0, 3);
  const answer = (mentionInvoice: boolean) => ({
    tickets: batch.map((s) => ({
      ref: s.label.ref,
      subject: "MOCK subject",
      body: `MOCK body ${mentionInvoice ? s.orderRef : ""} with enough length`,
      followUp: s.followUp ? "MOCK follow-up" : null,
    })),
  });

  it("attaches the account's customer details and the planned timestamp", async () => {
    const tickets = await generateTicketBatch(
      mockStructuredClient(() => answer(true)),
      batch,
      accounts,
      orders,
    );
    for (const [i, ticket] of tickets.entries()) {
      const account = accounts.find((a) => a.ref === batch[i].accountRef)!;
      expect(ticket.customerEmail).toBe(account.contactEmail);
      expect(ticket.createdAt).toBe(batch[i].createdAt);
    }
  });

  it("rejects tickets that do not mention the planned invoice", async () => {
    await expect(
      generateTicketBatch(
        mockStructuredClient(() => answer(false)),
        batch,
        accounts,
        orders,
      ),
    ).rejects.toThrow(/must mention invoice/);
  });
});
