import { describe, expect, it } from "vitest";
import { ARTICLES, INCIDENTS } from "../../seed/lib/catalog";
import {
  ACCOUNT_QUOTAS,
  buildAccountsAndOrders,
  buildTicketSlots,
  createRng,
} from "../../seed/lib/plan";
import { accountSchema, orderSchema, ticketLabelSchema } from "../../seed/lib/schemas";

// Stand-in for the Claude-written account profiles: same shape and regional quotas.
const profiles = (
  Object.entries(ACCOUNT_QUOTAS) as [keyof typeof ACCOUNT_QUOTAS, number][]
).flatMap(([region, count]) =>
  Array.from({ length: count }, (_, i) => ({
    region,
    companyName: `${region} company ${i}`,
    contactName: `Contact ${i}`,
    contactEmail: `contact${i}@${region.replace("_", "")}.example`,
    country: region === "international" ? (i % 2 ? "United States" : "Germany") : "India",
    city: "City",
    industry: "Retail",
  })),
);

const { accounts, orders } = buildAccountsAndOrders(profiles);
const slots = buildTicketSlots(accounts, orders);

describe("createRng", () => {
  it("is deterministic per seed", () => {
    const a = createRng("x");
    const b = createRng("x");
    const c = createRng("y");
    const seqA = [a.next(), a.next(), a.next()];
    expect([b.next(), b.next(), b.next()]).toEqual(seqA);
    expect([c.next(), c.next(), c.next()]).not.toEqual(seqA);
  });
});

describe("accounts and orders", () => {
  it("produce 50 valid accounts and valid, uniquely numbered orders", () => {
    expect(accounts).toHaveLength(50);
    for (const account of accounts) accountSchema.parse(account);
    for (const order of orders) orderSchema.parse(order);
    expect(new Set(orders.map((o) => o.ref)).size).toBe(orders.length);
  });

  it("bill Indian accounts in INR and German ones in EUR", () => {
    expect(
      accounts.filter((a) => a.region !== "international").every((a) => a.currency === "INR"),
    ).toBe(true);
    expect(accounts.filter((a) => a.country === "Germany").every((a) => a.currency === "EUR")).toBe(
      true,
    );
  });

  it("include real duplicate charges (same amount, minutes apart)", () => {
    const duplicates = orders.filter((o) => o.description.endsWith("(duplicate charge)"));
    expect(duplicates.length).toBeGreaterThan(0);
    for (const dup of duplicates) {
      const original = orders.find(
        (o) =>
          o.accountRef === dup.accountRef &&
          o.ref !== dup.ref &&
          o.amountCents === dup.amountCents &&
          Math.abs(Date.parse(o.orderedAt) - Date.parse(dup.orderedAt)) <= 5 * 60 * 1000,
      );
      expect(original, dup.ref).toBeDefined();
    }
  });

  it("are reproducible", () => {
    expect(buildAccountsAndOrders(profiles)).toEqual({ accounts, orders });
  });
});

describe("ticket slots", () => {
  it("plan exactly 300 tickets with unique sequential refs and valid labels", () => {
    expect(slots).toHaveLength(300);
    expect(slots.map((s) => s.label.ref)).toEqual(
      Array.from({ length: 300 }, (_, i) => `T-${String(i + 1).padStart(4, "0")}`),
    );
    for (const slot of slots) ticketLabelSchema.parse(slot.label);
  });

  it("number tickets in creation order", () => {
    const times = slots.map((s) => s.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  it("include exactly 10 injection attempts, including Hinglish and Tanglish ones", () => {
    const injections = slots.filter((s) => s.label.isInjection);
    expect(injections).toHaveLength(10);
    expect(injections.every((s) => s.injection)).toBe(true);
    expect(new Set(injections.map((s) => s.label.language))).toEqual(
      new Set(["en", "hinglish", "tanglish"]),
    );
  });

  it("give code-mixed languages only to customers from the matching region", () => {
    const regionOf = (ref: string) => accounts.find((a) => a.ref === ref)!.region;
    const organic = slots.filter((s) => !s.label.isInjection);
    for (const s of organic.filter((s) => s.label.language === "hinglish"))
      expect(regionOf(s.accountRef)).toBe("north_india");
    for (const s of organic.filter((s) => s.label.language === "tanglish"))
      expect(regionOf(s.accountRef)).toBe("tamil_nadu");
    expect(slots.filter((s) => s.label.language !== "en").length).toBeGreaterThan(20);
  });

  it("place incident tickets inside their incident window", () => {
    for (const incident of INCIDENTS) {
      const linked = slots.filter((s) => s.label.incidentRef === incident.ref);
      expect(linked).toHaveLength(8);
      for (const s of linked) {
        expect(s.createdAt >= incident.startedAt && s.createdAt <= incident.resolvedAt).toBe(true);
      }
    }
  });

  it("make duplicate-charge tickets cite an invoice that really is a duplicate", () => {
    const duplicateTickets = slots.filter((s) => s.label.expectedKbArticleId === "KB-005");
    expect(duplicateTickets.length).toBeGreaterThan(0);
    for (const s of duplicateTickets) {
      const order = orders.find((o) => o.ref === s.orderRef);
      expect(order?.accountRef).toBe(s.accountRef);
      expect(order?.description).toMatch(/duplicate charge/);
    }
  });

  it("cover every article and leave feature requests unanswered by the KB", () => {
    const cited = new Set(slots.map((s) => s.label.expectedKbArticleId));
    for (const article of ARTICLES) expect(cited.has(article.ref), article.ref).toBe(true);
    expect(
      slots
        .filter((s) => s.label.category === "feature_request")
        .every((s) => s.label.expectedKbArticleId === null),
    ).toBe(true);
  });

  it("are reproducible", () => {
    expect(buildTicketSlots(accounts, orders)).toEqual(slots);
  });
});
