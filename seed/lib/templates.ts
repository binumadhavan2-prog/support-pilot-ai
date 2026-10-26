import { ARTICLES, INCIDENTS, RUNBOOKS, type ArticleSpec } from "./catalog";
import { COMPANY_FACTS } from "./facts";
import { ACCOUNT_QUOTAS, createRng, type TicketSlot } from "./plan";
import type { Account, Incident, KbArticle, Runbook, Ticket } from "./schemas";

/*
 * DEMO DATA written from templates: the free alternative to seed/lib/generate.ts (which has
 * Claude write the text). Everything about WHAT to create (accounts, invoices, labels, scenarios)
 * still comes from seed/lib/plan.ts and catalog.ts; only the wording is templated, so the text is
 * plainer and more repetitive than the Claude version, but deterministic and costs nothing.
 */

const SEED = "acme-cloud-v1:templates";
type Language = "en" | "hinglish" | "tanglish";
type Region = keyof typeof ACCOUNT_QUOTAS;

// --- Account profiles ---

const PEOPLE: Record<Region, { first: string[]; last: string[]; places: [string, string][] }> = {
  north_india: {
    first: [
      "Priya",
      "Rahul",
      "Ankit",
      "Neha",
      "Vikram",
      "Pooja",
      "Arjun",
      "Sneha",
      "Rohit",
      "Kavya",
      "Aman",
      "Ritu",
      "Saurabh",
      "Divya",
      "Karan",
      "Meera",
      "Nikhil",
      "Anjali",
    ],
    last: [
      "Sharma",
      "Verma",
      "Gupta",
      "Agarwal",
      "Singh",
      "Mehta",
      "Kapoor",
      "Joshi",
      "Malhotra",
      "Bansal",
      "Saxena",
      "Chauhan",
    ],
    places: [
      ["India", "Delhi"],
      ["India", "Gurugram"],
      ["India", "Noida"],
      ["India", "Jaipur"],
      ["India", "Lucknow"],
      ["India", "Indore"],
      ["India", "Chandigarh"],
      ["India", "Bhopal"],
    ],
  },
  tamil_nadu: {
    first: [
      "Karthik",
      "Lakshmi",
      "Arun",
      "Deepa",
      "Senthil",
      "Meena",
      "Vignesh",
      "Revathi",
      "Suresh",
      "Anitha",
      "Ramesh",
      "Kavitha",
    ],
    last: [
      "Raman",
      "Subramanian",
      "Krishnan",
      "Murugan",
      "Venkatesh",
      "Natarajan",
      "Pandian",
      "Sundaram",
    ],
    places: [
      ["India", "Chennai"],
      ["India", "Coimbatore"],
      ["India", "Madurai"],
      ["India", "Trichy"],
      ["India", "Salem"],
      ["India", "Tirunelveli"],
    ],
  },
  international: {
    first: [
      "Emma",
      "Lukas",
      "Sophie",
      "Daniel",
      "Olivia",
      "Noah",
      "Mia",
      "Liam",
      "Chloe",
      "Ethan",
      "Ava",
      "Lucas",
      "Isla",
      "Omar",
      "Grace",
      "Jack",
      "Hannah",
      "Leo",
      "Zoe",
      "Ryan",
    ],
    last: [
      "Clarke",
      "Becker",
      "Martin",
      "Kim",
      "Brown",
      "Wilson",
      "Fischer",
      "Walsh",
      "Dubois",
      "Tan",
      "Jansen",
      "Meyer",
      "Thompson",
      "Haddad",
      "Lee",
      "Taylor",
      "Schmidt",
      "Wright",
      "Campbell",
      "Patel",
    ],
    places: [
      ["United States", "Austin"],
      ["United Kingdom", "Manchester"],
      ["Germany", "Berlin"],
      ["France", "Lyon"],
      ["Netherlands", "Utrecht"],
      ["Singapore", "Singapore"],
      ["Australia", "Melbourne"],
      ["Canada", "Toronto"],
      ["United Arab Emirates", "Dubai"],
    ],
  },
};

const BUSINESSES: [industry: string, noun: string][] = [
  ["Printing", "Prints"],
  ["SaaS", "Labs"],
  ["Digital agency", "Digital"],
  ["Education", "Academy"],
  ["Fitness", "Fitness"],
  ["Healthcare", "Clinic"],
  ["D2C brand", "Goods"],
  ["Logistics", "Logistics"],
  ["Coworking", "Spaces"],
  ["Consulting", "Advisors"],
  ["Retail", "Stores"],
  ["Media", "Media"],
];

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function templateAccountProfiles() {
  const rng = createRng(`${SEED}:accounts`);
  const usedCompanies = new Set<string>();
  return (Object.keys(ACCOUNT_QUOTAS) as Region[]).flatMap((region) => {
    const people = PEOPLE[region];
    return Array.from({ length: ACCOUNT_QUOTAS[region] }, (_, i) => {
      const first = people.first[i % people.first.length];
      const last = people.last[i % people.last.length];
      const [industry, noun] = BUSINESSES[(i * 5 + region.length) % BUSINESSES.length];
      let companyName = `${last} ${noun}`;
      for (let n = 2; usedCompanies.has(companyName); n++) companyName = `${last} ${noun} ${n}`;
      usedCompanies.add(companyName);
      const [country, city] = rng.pick(people.places);
      return {
        companyName,
        contactName: `${first} ${last}`,
        contactEmail: `${first.toLowerCase()}@${slug(companyName)}.example`,
        country,
        city,
        industry,
        region,
      };
    });
  });
}

// --- Knowledge base and runbooks ---

/**
 * Fact-sheet lines (one per bullet or sentence), so articles quote real policies. The intro
 * paragraph describes the company, not a policy, so it is skipped; wrapped lines are indented
 * continuations and are joined back first.
 */
const FACT_LINES = COMPANY_FACTS.slice(COMPANY_FACTS.indexOf("\n\n") + 2)
  .replace(/\n\s+(?=[a-z(\d])/g, " ")
  .split("\n")
  .map((line) => line.replace(/^-\s*/, "").trim())
  .filter((line) => line.length > 30 && !line.endsWith(":"));

const STOPWORDS = new Set([
  "your",
  "with",
  "what",
  "when",
  "from",
  "that",
  "this",
  "where",
  "about",
  "after",
  "into",
  "their",
  "them",
  "does",
  "have",
  "acme",
  "cloud",
  "how",
]);

function keywords(text: string) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

export function relatedFacts(text: string, max = 4, minShared = 1) {
  const words = keywords(text);
  return FACT_LINES.map((line) => ({
    line,
    score: [...keywords(line)].filter((w) => words.has(w)).length,
  }))
    .filter((f) => f.score >= minShared)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((f) => f.line);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Lowercases the first letter for use mid-sentence, unless the first word is an acronym (API). */
const lowerFirst = (s: string) =>
  /^[A-Z0-9]{2,}\b/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
const topicsOf = (covers: string) =>
  covers
    .split(/,\s*|;\s*/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 5);

export function templateArticle(spec: ArticleSpec): KbArticle {
  const facts = relatedFacts(`${spec.title} ${spec.covers}`);
  const sections = topicsOf(spec.covers).map((topic, i) => {
    // Prefer a fact-sheet line about this topic; else a short, varied pointer (one boilerplate
    // sentence repeated in every section would make all chunks look alike to search).
    const fact = relatedFacts(`${topic} ${spec.title}`, 3, 2).find((line) => !facts.includes(line));
    const pointers = [
      `${capitalize(topic)} is managed in the Acme Billing dashboard.`,
      `For ${topic}, open the matching page under Settings and check the details there.`,
      `If ${topic} doesn't look right, contact support with your account ID.`,
    ];
    return `## ${capitalize(topic)}\n\n${fact ?? pointers[i % pointers.length]}`;
  });
  const body = [
    `This article explains ${spec.title.charAt(0).toLowerCase()}${spec.title.slice(1)}: ${spec.covers}.`,
    facts.length > 0 ? `## Key facts\n\n${facts.map((f) => `- ${f}`).join("\n")}` : null,
    ...sections,
    "## Still need help?\n\nReply to your ticket or email support. Support hours are 24x5 (Monday 00:00 to Friday 23:59 UTC), with weekend coverage on Scale and above.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { ref: spec.ref, title: spec.title, category: spec.category, body };
}

export function templateRunbook(spec: (typeof RUNBOOKS)[number]): Runbook {
  const steps = topicsOf(spec.covers);
  const body = [
    `INTERNAL. ${spec.title.replace(/^Runbook:\s*/, "")}: use this when a ticket or alert points to this problem.`,
    "## Triage checklist\n\n- Confirm the account ID and the affected invoices or users.\n- Check status.acmecloud.example and the on-call channel for a known incident.\n- Note the time the problem started.",
    `## Steps\n\n${steps.map((s, i) => `${i + 1}. ${capitalize(s)}.`).join("\n")}`,
    "## Customer communication\n\nAcknowledge the problem, say what we are doing and when the customer will hear from us next. Never promise a refund or account change before it is approved.",
    "## Safety rule\n\nRefunds and account changes need a second person's approval, recorded in the admin console.",
    "## Escalation\n\nEscalate to the on-call engineer if more than one customer is affected or the problem lasts longer than 30 minutes.",
  ].join("\n\n");
  return { ref: spec.ref, title: spec.title, body };
}

// --- Incidents ---

const INCIDENT_TEXT: Record<
  string,
  {
    title: string;
    service: string;
    metric: string;
    error: string;
    fix: string;
    symptom: Record<Language, string>;
    subject: string;
  }
> = {
  "INC-001": {
    title: "Razorpay webhooks failing signature verification",
    service: "payments-webhooks",
    metric: "webhook_signature_failures_per_min",
    error: 'level=error msg="webhook signature mismatch" gateway=razorpay event=payment.captured',
    fix: 'level=info msg="webhook secret restored; replaying failed events" gateway=razorpay',
    subject: "Invoice still unpaid but we already paid",
    symptom: {
      en: "Our customer paid through Razorpay but the invoice still shows as open, and they got a payment reminder anyway.",
      hinglish:
        "Customer ne Razorpay se payment kar diya, phir bhi invoice open dikh raha hai aur unko reminder email bhi gaya.",
      tanglish:
        "Customer Razorpay la pay pannitaanga, aana invoice innum open nu kaatudhu, reminder email vera poyirukku.",
    },
  },
  "INC-002": {
    title: "Invoice PDF renderer out of memory",
    service: "pdf-renderer",
    metric: "pdf_render_failures_per_min",
    error: 'level=error msg="Rendering timed out" worker=pdf-renderer reason=oom',
    fix: 'level=info msg="renderer workers restarted with previous fonts package; regenerating PDFs"',
    subject: "Invoice PDF is blank",
    symptom: {
      en: "Invoice PDFs come out blank or fail with 'Rendering timed out', and our invoice emails went out without the attachment.",
      hinglish:
        "Invoice ka PDF blank aa raha hai ya 'Rendering timed out' error aata hai, aur email bina attachment ke chala gaya.",
      tanglish:
        "Invoice PDF blank-a varudhu illana 'Rendering timed out' error varudhu, email attachment illama poyirukku.",
    },
  },
  "INC-003": {
    title: "Transactional email delayed by provider throttling",
    service: "email-sender",
    metric: "email_queue_age_seconds",
    error: 'level=warn msg="provider throttled sending pool" retry_in=300s',
    fix: 'level=info msg="throttling lifted; email backlog drained"',
    subject: "Invoice emails arriving hours late",
    symptom: {
      en: "Invoice and reminder emails are reaching our customers hours late today.",
      hinglish: "Aaj invoice aur reminder emails customers ko ghanton late pahunch rahe hain.",
      tanglish: "Innikku invoice, reminder emails customers-ku romba late-a poguthu.",
    },
  },
};

export function templateIncident(spec: (typeof INCIDENTS)[number]): Incident {
  const text = INCIDENT_TEXT[spec.ref];
  const rng = createRng(`${SEED}:${spec.ref}`);
  const start = new Date(spec.startedAt).getTime();
  const end = new Date(spec.resolvedAt).getTime();
  const lines: string[] = [];
  for (let i = 0; i < 40; i++) {
    const at = new Date(start + Math.round(((end - start) * i) / 39)).toISOString();
    const request = `req_${rng.int(100000, 999999)}`;
    const line =
      i < 3
        ? `level=info msg="normal traffic" service=${text.service}`
        : i < 30
          ? i % 4 === 0
            ? `level=info msg="healthcheck ok" service=api-gateway`
            : `${text.error} service=${text.service}`
          : i === 30
            ? text.fix
            : `level=info msg="recovered" service=${text.service}`;
    lines.push(`${at} ${line} request_id=${request}`);
  }
  return {
    ref: spec.ref,
    title: text.title,
    summary: `${spec.brief} Resolved after ${Math.round((end - start) / 60000)} minutes; follow-ups are tracked in ${spec.runbookRef}.`,
    alert: {
      alert: `${text.metric} above threshold`,
      severity: spec.severity,
      service: text.service,
      metric: text.metric,
      threshold: 5,
      observed: rng.int(20, 400),
      started_at: spec.startedAt,
      runbook_url: `https://wiki.acmecloud.example/runbooks/${spec.runbookRef}`,
      labels: { team: "billing-platform", env: "production" },
    },
    logs: lines.join("\n"),
    severity: spec.severity,
    runbookRef: spec.runbookRef,
    startedAt: spec.startedAt,
    resolvedAt: spec.resolvedAt,
  };
}

// --- Tickets ---

type Phrase = Record<Language, (x: string) => string>;

const SITUATION_PHRASES: Record<string, Phrase> = {
  "a how-to question": {
    en: (x) => `How do I handle this: ${x}? I couldn't find it in the dashboard.`,
    hinglish: (x) => `${x} kaise karna hai? Dashboard mein mil nahi raha.`,
    tanglish: (x) => `${x} eppadi pannanum? Dashboard la kandupidikka mudiyala.`,
  },
  "wants to understand or confirm a policy": {
    en: (x) => `Can you confirm how your policy works for this: ${x}?`,
    hinglish: (x) => `${x} ke baare mein aapki policy kya hai, confirm kar do please.`,
    tanglish: (x) => `${x} pathi unga policy enna nu sollunga.`,
  },
  "something is not working as expected": {
    en: (x) => `Something is not working as expected with ${x}.`,
    hinglish: (x) => `${x} theek se kaam nahi kar raha hai.`,
    tanglish: (x) => `${x} sariya work aagala.`,
  },
  "confused by an amount, charge or number": {
    en: (x) => `I'm confused by an amount related to ${x}.`,
    hinglish: (x) => `${x} mein jo amount dikh raha hai woh samajh nahi aa raha.`,
    tanglish: (x) => `${x} la irukka amount puriyala.`,
  },
  "blocked, losing money or time right now": {
    en: (x) => `We are blocked right now because of ${x}, and it is costing us money.`,
    hinglish: (x) => `${x} ki wajah se hum abhi blocked hain, nuksaan ho raha hai.`,
    tanglish: (x) => `${x} naala ippo blocked-a irukkom, loss aagudhu.`,
  },
  "complaining after a bad experience": {
    en: (x) => `I'm unhappy with how ${x} was handled.`,
    hinglish: (x) => `${x} ko leke bahut bura experience raha.`,
    tanglish: (x) => `${x} vishayathula romba mosamana experience.`,
  },
  "asking for a feature that does not exist yet": {
    en: (x) => `Could you add ${x}? It would really help our team.`,
    hinglish: (x) => `Kya aap ${x} add kar sakte ho? Bahut help hogi.`,
    tanglish: (x) => `${x} add panna mudiyuma? Romba useful-a irukkum.`,
  },
  "reporting a bug": {
    en: (x) => `I think there is a bug: ${x}.`,
    hinglish: (x) => `Lagta hai bug hai: ${x}.`,
    tanglish: (x) => `Oru bug irukku nu nenaikkiren: ${x}.`,
  },
  "a support request that also tries to manipulate an AI assistant": {
    en: (x) => `I have a question about ${x}.`,
    hinglish: (x) => `Mujhe ${x} ke baare mein poochna hai.`,
    tanglish: (x) => `${x} pathi oru doubt irukku.`,
  },
  "a message that is not a support problem": {
    en: (x) => `I'm reaching out about ${x}.`,
    hinglish: (x) => `Main ${x} ke baare mein contact kar raha hoon.`,
    tanglish: (x) => `${x} pathi contact panren.`,
  },
};

const TONE_LINES: Record<TicketSlot["tone"], Record<Language, string>> = {
  calm: { en: "Thanks in advance.", hinglish: "Thanks.", tanglish: "Nandri." },
  confused: {
    en: "I'm not sure what I'm missing here.",
    hinglish: "Samajh nahi aa raha kya miss ho raha hai.",
    tanglish: "Enna miss panren nu theriyala.",
  },
  angry: {
    en: "This is really frustrating. Please fix it today.",
    hinglish: "Bahut frustrating hai, aaj hi theek karo.",
    tanglish: "Romba frustrating-a irukku, inniki fix pannunga.",
  },
  anxious: {
    en: "I'm worried about this, please reply soon.",
    hinglish: "Thoda tension ho raha hai, jaldi reply karo.",
    tanglish: "Konjam tension-a irukku, seekiram reply pannunga.",
  },
  happy: {
    en: "Thanks a lot, you've been great so far!",
    hinglish: "Thanks, aap log bahut helpful ho!",
    tanglish: "Romba thanks, neenga super!",
  },
};

const FOLLOW_UPS: Record<Language, string> = {
  en: "Any update on this? I haven't heard back yet.",
  hinglish: "Koi update hai? Abhi tak reply nahi aaya.",
  tanglish: "Edhavadhu update irukka? Innum reply varala.",
};

const ORDER_LINES: Record<Language, (ref: string) => string> = {
  en: (ref) => `The invoice in question is ${ref}.`,
  hinglish: (ref) => `Invoice ${ref} dekh lo please.`,
  tanglish: (ref) => `Invoice ${ref} paarunga.`,
};

/** "Title: covers" topics keep only the title; everything is trimmed to fit a subject line. */
function shortTopic(topic: string) {
  const head = topic.split(": ")[0];
  return head.length > 90 ? `${head.slice(0, 89)}…` : head;
}

/** Quoted passages from an injection technique: the text the attacker actually writes. */
function injectedText(technique: string) {
  return [...technique.matchAll(/"([^"]+)"/g)].map((m) => m[1]).join(" ");
}

export function templateTicket(slot: TicketSlot, account: Account): Ticket {
  const language = slot.label.language as Language;
  const first = account.contactName.split(" ")[0];
  const incident = slot.label.incidentRef ? INCIDENT_TEXT[slot.label.incidentRef] : null;

  let subject: string;
  let core: string;
  if (incident) {
    subject = incident.subject;
    core = incident.symptom[language];
  } else {
    const topic = shortTopic(slot.topic);
    subject = capitalize(topic);
    const phrase = SITUATION_PHRASES[slot.situation];
    // Phrases that open with the topic would otherwise start the sentence in lowercase.
    core = phrase ? capitalize(phrase[language](lowerFirst(topic))) : `${capitalize(topic)}.`;
    if (slot.injection) core = `${core}\n\n${injectedText(slot.injection)}`;
  }

  const body = [
    language === "en" ? "Hi Acme team," : "Hi team,",
    "",
    core,
    slot.orderRef ? ORDER_LINES[language](slot.orderRef) : null,
    "",
    TONE_LINES[slot.tone][language],
    "",
    first,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return {
    ref: slot.label.ref,
    subject: subject.slice(0, 140),
    body,
    followUp: slot.followUp ? FOLLOW_UPS[language] : null,
    accountRef: account.ref,
    customerName: account.contactName,
    customerEmail: account.contactEmail,
    incidentRef: slot.label.incidentRef,
    createdAt: slot.createdAt,
  };
}

export const templateArticles = () => ARTICLES.map(templateArticle);
export const templateRunbooks = () => RUNBOOKS.map(templateRunbook);
export const templateIncidents = () => INCIDENTS.map(templateIncident);
