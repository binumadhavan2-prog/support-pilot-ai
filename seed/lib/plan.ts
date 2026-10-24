import { ARTICLES, BUGS, FEATURE_REQUESTS, INCIDENTS, INJECTIONS, OTHER } from "./catalog";
import type { z } from "zod";
import type { Account, accountProfileSchema, Order, regionSchema, TicketLabel } from "./schemas";

/*
 * DEMO DATA planner. Decides, deterministically, everything about the dataset except the prose:
 * account plans and invoices (from code, so numbers are consistent) and, for every ticket, the
 * labels it must satisfy (category, priority, language, the article that answers it, injection).
 * Claude then writes text to fit each slot. Same seed => same plan.
 */

/** "Now" for the dataset. Fixed so re-generation is reproducible. */
export const ANCHOR = new Date("2026-09-30T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** mulberry32: tiny, fast, good enough for test data. Not for anything security-related. */
export function createRng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
    weighted: <T extends string>(weights: Record<T, number>): T => {
      const entries = Object.entries(weights) as [T, number][];
      let roll = next() * entries.reduce((sum, [, w]) => sum + w, 0);
      for (const [key, weight] of entries) {
        roll -= weight;
        if (roll < 0) return key;
      }
      return entries[entries.length - 1][0];
    },
    shuffle: <T>(items: T[]): T[] => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
  };
  return rng;
}

// --- Accounts and orders ---

export const ACCOUNT_QUOTAS = { north_india: 18, tamil_nadu: 12, international: 20 } as const;

const MONTHLY_PRICE = {
  USD: { starter: 2900, growth: 9900, scale: 29900, enterprise: 120000 },
  EUR: { starter: 2900, growth: 9900, scale: 29900, enterprise: 120000 },
  GBP: { starter: 2500, growth: 8500, scale: 25900, enterprise: 100000 },
  INR: { starter: 239900, growth: 799900, scale: 2499900, enterprise: 9999900 },
} as const;

const EUR_COUNTRIES = ["germany", "france", "netherlands", "spain", "italy", "ireland", "portugal"];

function currencyFor(region: Account["region"], country: string): Account["currency"] {
  if (region !== "international" || country.toLowerCase() === "india") return "INR";
  const c = country.toLowerCase();
  if (c === "united kingdom" || c === "uk") return "GBP";
  return EUR_COUNTRIES.includes(c) ? "EUR" : "USD";
}

type Profile = z.infer<typeof accountProfileSchema> & { region: z.infer<typeof regionSchema> };

export function buildAccountsAndOrders(profiles: Profile[], seed = "acme-cloud-v1") {
  const rng = createRng(`${seed}:accounts`);
  const accounts: Account[] = [];
  const orders: Order[] = [];
  let invoiceNumber = 10001;

  profiles.forEach((profile, i) => {
    const plan = rng.weighted({ starter: 40, growth: 35, scale: 20, enterprise: 5 });
    const status = rng.weighted({
      active: 80,
      trialing: 6,
      past_due: 6,
      suspended: 4,
      canceled: 4,
    });
    const billingCycle = plan !== "enterprise" && rng.chance(0.25) ? "annual" : "monthly";
    const currency = currencyFor(profile.region, profile.country);
    const monthly = MONTHLY_PRICE[currency][plan];
    const ageMonths = status === "trialing" ? 0 : rng.int(2, 18);
    const createdAt = new Date(ANCHOR.getTime() - (ageMonths * 30 + rng.int(1, 12)) * DAY);
    const ref = `ACC-${String(i + 1).padStart(4, "0")}`;

    accounts.push({
      ...profile,
      ref,
      plan,
      billingCycle,
      status,
      currency,
      mrrCents: status === "trialing" || status === "canceled" ? 0 : monthly,
      createdAt: createdAt.toISOString(),
    });

    // Invoice history: one per month (or one per year), most recent last, capped at 12.
    const periods = billingCycle === "annual" ? Math.ceil(ageMonths / 12) : Math.min(ageMonths, 12);
    for (let p = periods - 1; p >= 0; p--) {
      const months = billingCycle === "annual" ? p * 12 : p;
      const orderedAt = new Date(ANCHOR.getTime() - (months * 30 + rng.int(0, 5)) * DAY);
      const isLatest = p === 0;
      let orderStatus: Order["status"] = "paid";
      if (isLatest && (status === "past_due" || status === "suspended")) orderStatus = "failed";
      else if (isLatest && rng.chance(0.05)) orderStatus = "pending";
      else if (rng.chance(0.03)) orderStatus = "refunded";
      const period = orderedAt.toLocaleString("en-US", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
      orders.push({
        ref: `INV-${invoiceNumber++}`,
        accountRef: ref,
        description: `${capitalize(plan)} plan, ${billingCycle} (${period})`,
        amountCents: billingCycle === "annual" ? monthly * 10 : monthly,
        currency,
        status: orderStatus,
        orderedAt: orderedAt.toISOString(),
      });
    }
  });

  // A few genuine duplicate charges, so "I was charged twice" tickets are true and verifiable.
  const payers = accounts.filter((a) =>
    orders.some((o) => o.accountRef === a.ref && o.status === "paid"),
  );
  for (const account of rng.shuffle(payers).slice(0, 6)) {
    const original = orders.findLast((o) => o.accountRef === account.ref && o.status === "paid")!;
    orders.push({
      ...original,
      ref: `INV-${invoiceNumber++}`,
      description: `${original.description} (duplicate charge)`,
      orderedAt: new Date(new Date(original.orderedAt).getTime() + 2 * 60 * 1000).toISOString(),
    });
  }

  return { accounts, orders };
}

// --- Ticket slots ---

const TONES = { calm: 45, confused: 20, angry: 20, anxious: 10, happy: 5 } as const;
type Tone = keyof typeof TONES;
const SENTIMENT: Record<Tone, TicketLabel["sentiment"]> = {
  calm: "neutral",
  confused: "neutral",
  angry: "negative",
  anxious: "negative",
  happy: "positive",
};

/**
 * Situation -> priority. Priority reflects business impact, never tone: an angry how-to question
 * is still low. The same rules are written up in evals/README.md for human labelers.
 */
const SITUATIONS = {
  how_to: { weight: 30, describe: "a how-to question", priority: { low: 60, normal: 40 } },
  policy: {
    weight: 15,
    describe: "wants to understand or confirm a policy",
    priority: { low: 50, normal: 50 },
  },
  broken: {
    weight: 25,
    describe: "something is not working as expected",
    priority: { normal: 70, high: 30 },
  },
  confusing_charge: {
    weight: 10,
    describe: "confused by an amount, charge or number",
    priority: { normal: 100 },
  },
  blocked: {
    weight: 12,
    describe: "blocked, losing money or time right now",
    priority: { high: 70, urgent: 30 },
  },
  complaint: {
    weight: 8,
    describe: "complaining after a bad experience",
    priority: { normal: 60, high: 40 },
  },
} as const;
type Situation = keyof typeof SITUATIONS;

// Articles whose topic implies a situation regardless of the roll.
const FORCED_SITUATION: Partial<Record<string, Situation>> = {
  "KB-005": "blocked", // a duplicate charge is money taken in error
  "KB-012": "blocked", // a suspended account is read-only
};
// Extra tickets for the topics real support teams see most.
const POPULAR = [
  "KB-005",
  "KB-007",
  "KB-003",
  "KB-025",
  "KB-012",
  "KB-015",
  "KB-031",
  "KB-022",
  "KB-023",
  "KB-026",
];

export interface TicketSlot {
  label: TicketLabel;
  accountRef: string;
  /** An invoice the ticket should mention, when relevant. */
  orderRef: string | null;
  tone: Tone;
  situation: string;
  /** What the ticket is about, for the writer. */
  topic: string;
  /** Injection technique, for the 10 injection tickets. */
  injection: string | null;
  followUp: boolean;
  createdAt: string;
}

export function buildTicketSlots(accounts: Account[], orders: Order[], seed = "acme-cloud-v1") {
  const rng = createRng(`${seed}:tickets`);
  const ordersFor = (ref: string) => orders.filter((o) => o.accountRef === ref);
  const duplicateAccounts = [
    ...new Set(
      orders.filter((o) => o.description.includes("(duplicate charge)")).map((o) => o.accountRef),
    ),
  ];
  const failedAccounts = [
    ...new Set(orders.filter((o) => o.status === "failed").map((o) => o.accountRef)),
  ];
  const payingAccounts = accounts.filter((a) => ordersFor(a.ref).length > 0).map((a) => a.ref);

  const randomCreatedAt = () => new Date(ANCHOR.getTime() - rng.next() * 60 * DAY).toISOString();

  function languageFor(accountRef: string): TicketLabel["language"] {
    const region = accounts.find((a) => a.ref === accountRef)!.region;
    if (region === "north_india" && rng.chance(0.35)) return "hinglish";
    if (region === "tamil_nadu" && rng.chance(0.4)) return "tanglish";
    return "en";
  }

  function pickPriority(situation: Situation): TicketLabel["priority"] {
    return rng.weighted(SITUATIONS[situation].priority as Record<TicketLabel["priority"], number>);
  }

  function orderFor(accountRef: string, kb: string | null): string | null {
    const list = ordersFor(accountRef);
    if (list.length === 0) return null;
    if (kb === "KB-005")
      return list.findLast((o) => o.description.includes("(duplicate charge)"))?.ref ?? null;
    if (kb === "KB-007" || kb === "KB-012")
      return list.findLast((o) => o.status === "failed")?.ref ?? list.at(-1)!.ref;
    return list.at(-1)!.ref;
  }

  type DraftSlot = Omit<TicketSlot, "label"> & { label: Omit<TicketLabel, "ref"> };
  const slots: DraftSlot[] = [];
  const add = (slot: DraftSlot) => slots.push(slot);

  // 1. Article-backed tickets: 5 per article plus 2 extra for popular topics (220).
  for (const article of ARTICLES) {
    const count = 5 + (POPULAR.includes(article.ref) ? 2 : 0);
    for (let n = 0; n < count; n++) {
      let accountRef = rng.pick(accounts).ref;
      if (article.ref === "KB-005") accountRef = rng.pick(duplicateAccounts);
      else if ((article.ref === "KB-007" || article.ref === "KB-012") && failedAccounts.length)
        accountRef = rng.pick(failedAccounts);
      else if (article.category === "billing") accountRef = rng.pick(payingAccounts);

      const situation =
        FORCED_SITUATION[article.ref] ??
        rng.weighted(
          Object.fromEntries(Object.entries(SITUATIONS).map(([k, v]) => [k, v.weight])) as Record<
            Situation,
            number
          >,
        );
      const tone = rng.weighted(TONES);
      add({
        label: {
          category: article.category,
          priority: pickPriority(situation),
          sentiment: SENTIMENT[tone],
          language: languageFor(accountRef),
          expectedKbArticleId: article.ref,
          isInjection: false,
          incidentRef: null,
          scenario: `${SITUATIONS[situation].describe} about "${article.title}"`,
        },
        accountRef,
        orderRef: article.category === "billing" ? orderFor(accountRef, article.ref) : null,
        tone,
        situation: SITUATIONS[situation].describe,
        topic: `${article.title}: ${article.covers}`,
        injection: null,
        followUp: rng.chance(tone === "angry" || tone === "anxious" ? 0.35 : 0.08),
        createdAt: randomCreatedAt(),
      });
    }
  }

  // 2. Incident tickets: 8 per incident, created during the incident window (24).
  for (const incident of INCIDENTS) {
    const start = new Date(incident.startedAt).getTime();
    const end = new Date(incident.resolvedAt).getTime();
    for (let n = 0; n < 8; n++) {
      const accountRef = rng.pick(payingAccounts);
      const tone = rng.weighted({ angry: 40, anxious: 40, calm: 20 });
      const priority =
        incident.severity === "sev1"
          ? n < 5
            ? "urgent"
            : "high"
          : incident.severity === "sev2"
            ? n < 2
              ? "urgent"
              : "high"
            : n < 5
              ? "high"
              : "normal";
      add({
        label: {
          category: "technical",
          priority,
          sentiment: SENTIMENT[tone],
          language: languageFor(accountRef),
          expectedKbArticleId: incident.kbRef,
          isInjection: false,
          incidentRef: incident.ref,
          scenario: `symptom of incident ${incident.ref}`,
        },
        accountRef,
        orderRef: null,
        tone,
        situation:
          "noticing the symptoms of an ongoing outage; the customer does not know it is an incident",
        topic: `Symptoms only (do not explain the root cause): ${incident.brief}`,
        injection: null,
        followUp: rng.chance(0.4),
        createdAt: new Date(start + rng.next() * (end - start)).toISOString(),
      });
    }
  }

  // 3. Prompt-injection attempts (10).
  for (const injection of INJECTIONS) {
    const accountRef = rng.pick(payingAccounts);
    add({
      label: {
        category: injection.category,
        priority: injection.priority,
        sentiment: "neutral",
        language: injection.language,
        expectedKbArticleId: injection.kb,
        isInjection: true,
        incidentRef: null,
        scenario: "prompt-injection attempt",
      },
      accountRef,
      orderRef: injection.category === "billing" ? orderFor(accountRef, null) : null,
      tone: "calm",
      situation: "a support request that also tries to manipulate an AI assistant",
      topic: injection.kb
        ? ARTICLES.find((a) => a.ref === injection.kb)!.title
        : "other customers' data",
      injection: injection.technique,
      followUp: false,
      createdAt: randomCreatedAt(),
    });
  }

  // 4. Feature requests (20), 5. bugs with no article (16), 6. other (10).
  const unanswered = [
    ...FEATURE_REQUESTS.map((topic) => ({
      topic,
      category: "feature_request" as const,
      priority: rng.chance(0.15) ? ("normal" as const) : ("low" as const),
      situation: "asking for a feature that does not exist yet",
    })),
    ...BUGS.map((topic) => ({
      topic,
      category: "technical" as const,
      priority: rng.chance(0.3) ? ("high" as const) : ("normal" as const),
      situation: "reporting a bug",
    })),
    ...OTHER.map((topic) => ({
      topic,
      category: "other" as const,
      priority: "low" as const,
      situation: "a message that is not a support problem",
    })),
  ];
  for (const item of unanswered) {
    const accountRef = rng.pick(accounts).ref;
    const tone =
      item.category === "other" ? rng.weighted({ calm: 70, happy: 30 }) : rng.weighted(TONES);
    add({
      label: {
        category: item.category,
        priority: item.priority,
        sentiment: SENTIMENT[tone],
        language: languageFor(accountRef),
        expectedKbArticleId: null,
        isInjection: false,
        incidentRef: null,
        scenario: `${item.situation}: ${item.topic}`,
      },
      accountRef,
      orderRef: null,
      tone,
      situation: item.situation,
      topic: item.topic,
      injection: null,
      followUp: rng.chance(0.05),
      createdAt: randomCreatedAt(),
    });
  }

  // Number tickets in creation order, like a real helpdesk.
  return slots
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((slot, i): TicketSlot => {
      const ref = `T-${String(i + 1).padStart(4, "0")}`;
      return { ...slot, label: { ...slot.label, ref } };
    });
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
