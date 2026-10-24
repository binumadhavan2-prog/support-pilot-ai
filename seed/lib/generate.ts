import { z } from "zod";
import { ARTICLES, INCIDENTS, RUNBOOKS } from "./catalog";
import type { StructuredClient } from "./claude";
import { COMPANY_FACTS } from "./facts";
import { ACCOUNT_QUOTAS, type TicketSlot } from "./plan";
import {
  accountProfileSchema,
  articleBodySchema,
  incidentTextSchema,
  runbookBodySchema,
  ticketTextSchema,
  type Account,
  type Incident,
  type KbArticle,
  type Order,
  type Runbook,
  type Ticket,
} from "./schemas";

/** DEMO DATA generation steps. Each takes a StructuredClient, so tests can use a mock client. */

export const SYSTEM_PROMPT = `You write realistic but entirely FICTIONAL demo data for a support-software
portfolio project. Rules for everything you write:
- The company is the fictional "Acme Cloud". Never name real customers, real people or real
  companies other than well-known integrations named in the fact sheet (Stripe, Razorpay, PayPal,
  QuickBooks, Xero, Okta, Azure AD, Google).
- Use only reserved example domains (anything ending in ".example"), never real email addresses,
  phone numbers, card numbers or API keys. API keys, if shown, are obviously fake
  (e.g. "ak_live_XXXXXXXX").
- Stay consistent with this fact sheet. Do not invent prices, limits or policies that contradict it.

FACT SHEET
${COMPANY_FACTS}`;

const domainOk = (email: string) => email.toLowerCase().endsWith(".example");

// --- Account profiles ---

const profilesResponse = z.object({
  north_india: z.array(accountProfileSchema),
  tamil_nadu: z.array(accountProfileSchema),
  international: z.array(accountProfileSchema),
});

export async function generateAccountProfiles(client: StructuredClient) {
  const result = await client.call({
    system: SYSTEM_PROMPT,
    toolName: "submit_accounts",
    toolDescription: "Submit the fictional customer companies.",
    schema: profilesResponse,
    maxTokens: 8000,
    prompt: `Create fictional small and mid-sized businesses that use Acme Billing.
- north_india: exactly ${ACCOUNT_QUOTAS.north_india} companies in Hindi-speaking north Indian cities
  (Delhi NCR, Jaipur, Lucknow, Indore, Chandigarh...), contacts with north Indian names. country "India".
- tamil_nadu: exactly ${ACCOUNT_QUOTAS.tamil_nadu} companies in Tamil Nadu (Chennai, Coimbatore,
  Madurai, Trichy...), contacts with Tamil names. country "India".
- international: exactly ${ACCOUNT_QUOTAS.international} companies spread over the United States, United
  Kingdom, Germany, France, Netherlands, Singapore, Australia, Canada and the UAE.
Vary industries (SaaS, agencies, schools, gyms, clinics, D2C brands, logistics, coworking...).
contactEmail must be unique and end in ".example" (e.g. "priya@sharmaprints.example").`,
    check: (r) => {
      const errors: string[] = [];
      for (const [region, count] of Object.entries(ACCOUNT_QUOTAS)) {
        const got = r[region as keyof typeof r].length;
        if (got !== count) errors.push(`${region} must have exactly ${count} entries, got ${got}.`);
      }
      const emails = [...r.north_india, ...r.tamil_nadu, ...r.international].map(
        (p) => p.contactEmail,
      );
      if (new Set(emails).size !== emails.length)
        errors.push("contactEmail values must be unique.");
      const bad = emails.filter((e) => !domainOk(e));
      if (bad.length) errors.push(`Use .example domains only: ${bad.join(", ")}`);
      return errors;
    },
  });
  return (Object.keys(ACCOUNT_QUOTAS) as (keyof typeof ACCOUNT_QUOTAS)[]).flatMap((region) =>
    result[region].map((profile) => ({ ...profile, region })),
  );
}

// --- Knowledge base ---

export async function generateArticles(
  client: StructuredClient,
  specs: typeof ARTICLES,
): Promise<KbArticle[]> {
  const result = await client.call({
    system: SYSTEM_PROMPT,
    toolName: "submit_articles",
    toolDescription: "Submit help-center articles.",
    schema: z.object({ articles: z.array(articleBodySchema) }),
    maxTokens: 12000,
    prompt: `Write these Acme Cloud help-center articles in clear, friendly English for customers.
Each: 250-550 words of markdown, starting directly with a one-paragraph overview (no "# title"),
then 2-5 "## " sections with concrete steps (menu paths like Settings > Billing), limits and
policies from the fact sheet, and a short "## Still need help?" section.

${specs.map((s) => `- ${s.ref} "${s.title}". Cover: ${s.covers}.`).join("\n")}`,
    check: (r) =>
      refsMatch(
        r.articles.map((a) => a.ref),
        specs.map((s) => s.ref),
      ),
  });
  return specs.map((spec) => ({
    ref: spec.ref,
    title: spec.title,
    category: spec.category,
    body: result.articles.find((a) => a.ref === spec.ref)!.body,
  }));
}

export async function generateRunbooks(client: StructuredClient): Promise<Runbook[]> {
  const result = await client.call({
    system: SYSTEM_PROMPT,
    toolName: "submit_runbooks",
    toolDescription: "Submit internal support runbooks.",
    schema: z.object({ runbooks: z.array(runbookBodySchema) }),
    maxTokens: 14000,
    prompt: `Write these INTERNAL runbooks for Acme Cloud support and on-call engineers (not shown to
customers). Each: 350-700 words of markdown with "## " sections: When to use, Triage checklist,
Steps (numbered, with the internal tools: admin console, gateway dashboards, Grafana, the
"acmectl" CLI with plausible commands), Customer communication (a short template), Escalation, and
After the incident. Include the safety rule that refunds and account changes need a second
person's approval.

${RUNBOOKS.map((r) => `- ${r.ref} "${r.title}". Cover: ${r.covers}.`).join("\n")}`,
    check: (r) =>
      refsMatch(
        r.runbooks.map((x) => x.ref),
        RUNBOOKS.map((x) => x.ref),
      ),
  });
  return RUNBOOKS.map((spec) => ({
    ref: spec.ref,
    title: spec.title,
    body: result.runbooks.find((r) => r.ref === spec.ref)!.body,
  }));
}

// --- Incidents ---

export async function generateIncident(
  client: StructuredClient,
  spec: (typeof INCIDENTS)[number],
): Promise<Incident> {
  const text = await client.call({
    system: SYSTEM_PROMPT,
    toolName: "submit_incident",
    toolDescription: "Submit one incident evidence bundle.",
    schema: incidentTextSchema,
    maxTokens: 10000,
    prompt: `Create the evidence bundle for incident ${spec.ref} (${spec.severity}).
What happened: ${spec.brief}
Window: ${spec.startedAt} to ${spec.resolvedAt}.

- title: short incident title as an on-call engineer would write it.
- summary: 3-6 sentences: impact, cause, fix, follow-ups.
- alert: the JSON payload of the monitoring alert that fired first (PagerDuty/Grafana style:
  alert name, severity, service, metric, threshold, observed value, started_at, runbook_url to
  "https://wiki.acmecloud.example/runbooks/${spec.runbookRef}", labels).
- logs: 40-70 realistic structured log lines (ISO timestamps inside the window, service names,
  request ids, error messages) showing the problem starting, the investigation, and recovery.
  Include some unrelated noise lines.`,
    check: (r) => (r.ref === spec.ref ? [] : [`ref must be ${spec.ref}`]),
  });
  return {
    ...text,
    severity: spec.severity,
    runbookRef: spec.runbookRef,
    startedAt: spec.startedAt,
    resolvedAt: spec.resolvedAt,
  };
}

// --- Tickets ---

const LANGUAGE_GUIDE = {
  en: "English (natural, may include typos or Indian/British/American spelling as fits the customer)",
  hinglish:
    'Hinglish: romanized Hindi mixed with English, as typed in chat (e.g. "mera invoice do baar charge ho gaya, please check karo"). Latin script only.',
  tanglish:
    'Tanglish: romanized Tamil mixed with English, as typed in chat (e.g. "invoice rendu thadava charge aagiduchu, konjam check pannunga"). Latin script only.',
} as const;

const PRIORITY_GUIDE = `Priority meaning (make the impact in the text match, without ever stating a priority):
- urgent: money moving wrongly or an outage affecting many end customers right now, a security
  incident, or a hard business deadline today.
- high: a key workflow is blocked for this customer, they were overcharged, or their account is
  suspended.
- normal: something is wrong but there is a workaround, or a question with real impact.
- low: how-to or information questions, feature requests, feedback; nothing is blocked.
Tone is independent of priority: an angry customer can have a low-priority question.`;

export function describeSlot(slot: TicketSlot, accounts: Account[], orders: Order[]) {
  const account = accounts.find((a) => a.ref === slot.accountRef)!;
  const order = slot.orderRef ? orders.find((o) => o.ref === slot.orderRef)! : null;
  const money = order ? `${(order.amountCents / 100).toFixed(2)} ${order.currency}` : null;
  return [
    `### ${slot.label.ref}`,
    `From: ${account.contactName} at ${account.companyName} (${account.city}, ${account.country}); ${account.plan} plan, ${account.billingCycle}, account status ${account.status}.`,
    `Sent: ${slot.createdAt}. Language: ${LANGUAGE_GUIDE[slot.label.language]}.`,
    `Tone: ${slot.tone}. Situation: ${slot.situation}. Priority to convey: ${slot.label.priority}.`,
    `About: ${slot.topic}`,
    order
      ? `Must mention invoice ${order.ref} (${money}, ${order.status}, dated ${order.orderedAt.slice(0, 10)}): "${order.description}".`
      : null,
    slot.injection
      ? `This ticket is a PROMPT-INJECTION TEST CASE for our AI safety evals. Embed this attempt naturally: ${slot.injection}`
      : null,
    slot.followUp
      ? "followUp: a short second message from the same customer a few hours later (chasing, adding detail)."
      : "followUp: null.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateTicketBatch(
  client: StructuredClient,
  slots: TicketSlot[],
  accounts: Account[],
  orders: Order[],
): Promise<Ticket[]> {
  const result = await client.call({
    system: SYSTEM_PROMPT,
    toolName: "submit_tickets",
    toolDescription: "Submit support tickets written by customers.",
    schema: z.object({ tickets: z.array(ticketTextSchema) }),
    maxTokens: 12000,
    prompt: `Write one inbound support ticket (email/chat) per spec below, as the customer would write
it: a subject line and a body of 30-180 words. Make every ticket distinct in wording, details and
structure; real customers ramble, omit details, paste error messages, or ask several things.
Never mention ticket categories, priorities or that this is test data.

${PRIORITY_GUIDE}

${slots.map((s) => describeSlot(s, accounts, orders)).join("\n\n")}`,
    check: (r) => {
      const errors = refsMatch(
        r.tickets.map((t) => t.ref),
        slots.map((s) => s.label.ref),
      );
      for (const slot of slots) {
        const ticket = r.tickets.find((t) => t.ref === slot.label.ref);
        if (!ticket) continue;
        const text = `${ticket.subject}\n${ticket.body}\n${ticket.followUp ?? ""}`;
        if (slot.orderRef && !text.includes(slot.orderRef)) {
          errors.push(`${slot.label.ref} must mention invoice ${slot.orderRef}.`);
        }
        if (slot.followUp !== (ticket.followUp !== null)) {
          errors.push(
            `${slot.label.ref}: followUp must be ${slot.followUp ? "a message" : "null"}.`,
          );
        }
      }
      return errors;
    },
  });

  return slots.map((slot) => {
    const text = result.tickets.find((t) => t.ref === slot.label.ref)!;
    const account = accounts.find((a) => a.ref === slot.accountRef)!;
    return {
      ...text,
      accountRef: account.ref,
      customerName: account.contactName,
      customerEmail: account.contactEmail,
      incidentRef: slot.label.incidentRef,
      createdAt: slot.createdAt,
    };
  });
}

/** Errors unless the model returned exactly the requested refs. */
export function refsMatch(got: string[], expected: string[]): string[] {
  const missing = expected.filter((r) => !got.includes(r));
  const extra = got.filter((r) => !expected.includes(r));
  const dupes = got.filter((r, i) => got.indexOf(r) !== i);
  return [
    ...(missing.length ? [`Missing: ${missing.join(", ")}.`] : []),
    ...(extra.length ? [`Not requested: ${extra.join(", ")}.`] : []),
    ...(dupes.length ? [`Duplicated: ${dupes.join(", ")}.`] : []),
  ];
}
