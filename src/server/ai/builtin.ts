import type { ModelCall } from "./claude";
import type { DraftModel, DraftOutput, DraftSource } from "./drafts";
import type { TriageModel, TriageOutput } from "./triage";

/*
 * Built-in, no-model mode: used when no Claude key is set. Free, instant and predictable, but
 * not AI. Triage is keyword rules; a draft reply quotes the best-matching help article. Both
 * implement the same interfaces as the Claude models, so every other step (routing, the human
 * approval, citations, audit) is unchanged. Their model names start with BUILTIN_PREFIX so the
 * UI labels the output as rules / template instead of AI.
 */

export const BUILTIN_PREFIX = "builtin-";
export const RULES_TRIAGE_MODEL = "builtin-rules-v1";
export const TEMPLATE_DRAFT_MODEL = "builtin-template-v1";

export function isBuiltinModel(model: string) {
  return model.startsWith(BUILTIN_PREFIX);
}

type Category = TriageOutput["category"];

// Word lists are matched on whole words, case-insensitively. Hinglish and Tanglish terms sit
// next to English ones because the same ticket often mixes them.
const CATEGORY_WORDS: Record<Exclude<Category, "other">, string[]> = {
  billing: [
    "invoice",
    "invoices",
    "bill",
    "billing",
    "billed",
    "charge",
    "charged",
    "charges",
    "refund",
    "refunds",
    "payment",
    "payments",
    "paid",
    "pay",
    "card",
    "subscription",
    "plan",
    "price",
    "pricing",
    "receipt",
    "tax",
    "gst",
    "upi",
    "paisa",
    "paise",
    "kat gaya",
    "kata",
    "do baar",
    "rendu thadava",
    "panam",
  ],
  technical: [
    "error",
    "errors",
    "bug",
    "crash",
    "crashes",
    "broken",
    "fails",
    "failed",
    "failing",
    "not working",
    "doesn't work",
    "does nothing",
    "timeout",
    "slow",
    "export",
    "import",
    "api",
    "webhook",
    "sync",
    "integration",
    "500",
    "404",
    "kaam nahi",
    "nahi chal",
    "work aagala",
    "velai seiyala",
    "load nahi",
  ],
  account: [
    "login",
    "log in",
    "sign in",
    "signin",
    "password",
    "reset",
    "locked",
    "2fa",
    "otp",
    "verification",
    "account",
    "email change",
    "access",
    "permission",
    "permissions",
    "user",
    "users",
    "seat",
    "seats",
    "delete my account",
  ],
  feature_request: [
    "feature",
    "feature request",
    "would be nice",
    "would love",
    "please add",
    "can you add",
    "suggestion",
    "wish",
    "roadmap",
    "support for",
    "integration with",
    "could you add",
    "would really help",
    "any plans",
    "add kar",
    "add panna",
  ],
};

/**
 * Strong signals that outweigh topic words. This is billing software, so "invoice" turns up in
 * bug reports and feature requests too; a symptom or an explicit request decides the category.
 */
const STRONG_WORDS: Partial<Record<Category, { words: string[]; weight: number }>> = {
  technical: {
    words: [
      "bug",
      "error",
      "crash",
      "broken",
      "not working",
      "doesn't work",
      "does nothing",
      "blank",
      "timed out",
      "not generating",
      "not loading",
      "kaam nahi",
      "work aagala",
      "fails",
    ],
    weight: 2,
  },
  feature_request: {
    words: [
      "feature",
      "please add",
      "can you add",
      "could you add",
      "add kar",
      "add panna",
      "would be nice",
    ],
    weight: 3,
  },
};

const URGENT_WORDS = [
  "urgent",
  "asap",
  "immediately",
  "outage",
  "down",
  "all users",
  "everyone",
  "production",
  "data loss",
  "security",
  "hacked",
  "breach",
  "emergency",
  "turant",
  "jaldi",
  "udane",
];
const HIGH_WORDS = [
  "cannot",
  "can't",
  "unable",
  "blocked",
  "stuck",
  "not working",
  "failed",
  "charged twice",
  "do baar",
  "deadline",
  "today",
];
const LOW_WORDS = ["question", "how do i", "how to", "curious", "wondering", "feature request"];

const NEGATIVE_WORDS = [
  "angry",
  "furious",
  "terrible",
  "worst",
  "unacceptable",
  "ridiculous",
  "disappointed",
  "frustrated",
  "useless",
  "cancel",
  "scam",
  "refund now",
  "bakwas",
  "bekaar",
  "pathetic",
  "mosam",
  "waste",
];
const POSITIVE_WORDS = [
  "thanks",
  "thank you",
  "great",
  "love",
  "awesome",
  "appreciate",
  "shukriya",
  "nandri",
];

const HINGLISH_WORDS = [
  "hai",
  "nahi",
  "nahin",
  "kya",
  "mera",
  "meri",
  "mujhe",
  "kar",
  "karo",
  "ho gaya",
  "gaya",
  "kaise",
  "kyun",
  "bhai",
  "abhi",
  "kab",
  "hua",
  "raha",
  "rahi",
  "chahiye",
];
const TANGLISH_WORDS = [
  "illa",
  "enna",
  "panna",
  "pannunga",
  "irukku",
  "vandhu",
  "aagala",
  "romba",
  "konjam",
  "eppadi",
  "sollunga",
  "theriyala",
  "seiyala",
  "venum",
];

// Text that tries to instruct an AI: flagged so agents treat the ticket with care.
const INJECTION_PATTERNS = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|messages|rules)/i,
  /disregard (all |the )?(previous|prior|above) /i,
  /\b(system prompt|developer message|jailbreak)\b/i,
  /\byou are now\b/i,
  /\bact as (an? )?(admin|administrator|developer|system)\b/i,
  /&lt;!--[\s\S]*?(instruction|assistant|ai|model)[\s\S]*?--&gt;/i,
  /\b(assistant|ai|model)\s*:\s*(approve|refund|grant|reveal)/i,
  /\b(reveal|print|show) (your|the) (instructions|prompt|rules|internal notes)\b/i,
  /\bsystem override\b/i,
  /\b(note|message|instructions?) (to|for) (the |any )?(ai|assistant|agent|bot|model)\b/i,
  /\bpretend (you are|to be)\b/i,
  /\bskip (the )?(human )?(approval|review)\b/i,
  /\bwhen you (draft|write) (the|your) reply\b/i,
  /\b(other (customers|companies|users)'?s?)\b[\s\S]{0,80}\b(emails?|tickets?|api keys?|data)\b/i,
  // Hinglish / Tanglish: "forget / ignore the previous instructions".
  /\b(instructions?|rules?)\b[\s\S]{0,20}\b(bhool jao|ignore karo|ignore pannunga)\b/i,
  /\bignore pannunga\b/i,
];

const TEAM_BY_CATEGORY: Record<Category, TriageOutput["suggested_team"]> = {
  billing: "billing",
  technical: "technical",
  account: "account",
  feature_request: "product",
  other: "general",
};

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matches(text: string, words: string[]) {
  return words.filter((w) =>
    new RegExp(`(^|[^a-z0-9])${escapeRegExp(w)}($|[^a-z0-9])`, "i").test(text),
  );
}

/** The ticket's subject and body, from the escaped message built by buildTriageMessage. */
function ticketText(userMessage: string) {
  const subject = /<subject>([\s\S]*?)<\/subject>/.exec(userMessage)?.[1] ?? "";
  const body = /<body>([\s\S]*?)<\/body>/.exec(userMessage)?.[1] ?? userMessage;
  return { subject: subject.trim(), body: body.trim() };
}

function firstSentence(text: string, max = 160) {
  const sentence =
    text
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<=[.!?])\s/)[0] ?? "";
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

export function classifyByRules(userMessage: string): TriageOutput {
  const { subject, body } = ticketText(userMessage);
  const text = `${subject}\n${body}`.toLowerCase();

  const scored = (Object.keys(CATEGORY_WORDS) as Exclude<Category, "other">[])
    .map((category) => {
      const hits = matches(text, CATEGORY_WORDS[category]);
      const strong = STRONG_WORDS[category];
      const bonus = strong ? matches(text, strong.words).length * (strong.weight - 1) : 0;
      return { category, hits, score: hits.length + bonus };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const category: Category = best.score > 0 ? best.category : "other";

  const urgent = matches(text, URGENT_WORDS);
  const high = matches(text, HIGH_WORDS);
  const low = matches(text, LOW_WORDS);
  const priority: TriageOutput["priority"] =
    urgent.length > 0
      ? "urgent"
      : high.length > 0
        ? "high"
        : low.length > 0 || category === "feature_request"
          ? "low"
          : "normal";

  const negative = matches(text, NEGATIVE_WORDS).length + (/!{3,}/.test(text) ? 1 : 0);
  const positive = matches(text, POSITIVE_WORDS).length;
  const sentiment: TriageOutput["sentiment"] =
    negative > positive ? "negative" : positive > negative ? "positive" : "neutral";

  const hinglish = matches(text, HINGLISH_WORDS).length;
  const tanglish = matches(text, TANGLISH_WORDS).length;
  const language: TriageOutput["language"] =
    hinglish >= 2 && hinglish >= tanglish ? "hinglish" : tanglish >= 2 ? "tanglish" : "en";

  const injection = INJECTION_PATTERNS.some((p) => p.test(userMessage));

  // Confidence grows with the margin between the top two categories; rules are never certain.
  const margin = best.score - (scored[1]?.score ?? 0);
  const confidence = category === "other" ? 0.3 : Math.min(0.85, 0.45 + 0.1 * margin);

  const reasons = [
    best.hits.length > 0
      ? `${category} words: ${best.hits.slice(0, 5).join(", ")}`
      : "no category words matched",
    urgent.length > 0 ? `urgent words: ${urgent.slice(0, 3).join(", ")}` : null,
    injection ? "text that tries to instruct an AI" : null,
  ].filter(Boolean);

  return {
    category,
    priority,
    sentiment,
    language,
    summary: firstSentence(body) || subject || "(empty ticket)",
    suggested_team: TEAM_BY_CATEGORY[category],
    is_injection_attempt: injection,
    confidence,
    reasoning: `Keyword rules (no AI): ${reasons.join("; ")}.`,
  };
}

function timed<T>(model: string, run: () => T): ModelCall<T> {
  const startedAt = performance.now();
  const output = run();
  return {
    output,
    model,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: Math.round(performance.now() - startedAt),
  };
}

export function createRulesTriageModel(): TriageModel {
  return {
    model: RULES_TRIAGE_MODEL,
    classify: async (userMessage) => timed(RULES_TRIAGE_MODEL, () => classifyByRules(userMessage)),
  };
}

/** The article's opening sentences, without its headings, as a short quote. */
export function articleExcerpt(content: string, maxChars = 600) {
  const prose = content
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (prose.length <= maxChars) return prose;
  const cut = prose.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return lastStop > maxChars / 3 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}

export function templateReply(
  context: { customerName: string; subject: string },
  source: DraftSource,
): DraftOutput {
  const name = context.customerName.trim().split(/\s+/)[0] || "there";
  return {
    status: "answered",
    reply: [
      `Hi ${name},`,
      "",
      `Thanks for reaching out about "${context.subject}". Our help article "${source.documentTitle}" covers this:`,
      "",
      `${articleExcerpt(source.content)} [1]`,
      "",
      "If that doesn't solve it, reply to this email and we'll take a closer look.",
      "",
      "Best regards,",
    ].join("\n"),
    cited_sources: [1],
  };
}

/** Quotes the top-ranked help article. Agents check that it fits before approving. */
export function createTemplateDraftModel(): DraftModel {
  return {
    model: TEMPLATE_DRAFT_MODEL,
    draft: async (_userMessage, context) => {
      if (!context || context.sources.length === 0) {
        return timed(TEMPLATE_DRAFT_MODEL, () => ({
          status: "insufficient_evidence" as const,
          reply: "",
          cited_sources: [],
        }));
      }
      return timed(TEMPLATE_DRAFT_MODEL, () => templateReply(context, context.sources[0]));
    },
  };
}
