/**
 * PII redaction before text is sent to a model. Each distinct value becomes a numbered token
 * (`[EMAIL_1]`, `[PHONE_2]`), the same value always gets the same token, and the map is kept so
 * model output can be turned back into the original values for agents.
 *
 * Regexes, so this is best-effort: it targets well-formed values and errs toward redacting
 * (a 12-digit order number may be redacted as Aadhaar). It is a data-minimization layer, not a
 * guarantee that no personal data reaches the model.
 */

export type PiiKind = "EMAIL" | "CARD" | "AADHAAR" | "PAN" | "PHONE";

interface Rule {
  kind: PiiKind;
  pattern: RegExp;
  /** Extra check on a match, to cut false positives (e.g. Luhn for cards). */
  accept?: (match: string) => boolean;
  /** Canonical form, so "98765 43210" and "9876543210" share one token. */
  normalize?: (match: string) => string;
}

const digitsOnly = (s: string) => s.replace(/\D/g, "");

/** Luhn checksum: real card numbers pass it, most random digit runs do not. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// Order matters: emails first (they contain digits), then the longest digit formats, so a card
// number is never half-consumed by the phone rule.
const RULES: Rule[] = [
  {
    kind: "EMAIL",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    normalize: (m) => m.toLowerCase(),
  },
  {
    kind: "CARD",
    // 13-19 digits, optionally grouped with spaces or dashes.
    pattern: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    accept: (m) => luhnValid(digitsOnly(m)),
    normalize: digitsOnly,
  },
  {
    kind: "AADHAAR",
    // 12 digits, first digit 2-9, usually written 4-4-4.
    pattern: /(?<![\d-])[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?![\d-])/g,
    normalize: digitsOnly,
  },
  {
    kind: "PAN",
    // Indian PAN: 5 letters, 4 digits, 1 letter (ABCDE1234F).
    pattern: /\b[A-Za-z]{5}\d{4}[A-Za-z]\b/g,
    normalize: (m) => m.toUpperCase(),
  },
  {
    kind: "PHONE",
    pattern: new RegExp(
      [
        // Indian mobile: optional +91 / 91 / 0 prefix, 10 digits starting 6-9, optional 5+5 split.
        String.raw`(?<![\w+])(?:(?:\+|00)?91[ -]?|0)?[6-9]\d{4}[ -]?\d{5}(?!\d)`,
        // International: + or 00, country code, then 6-14 more digits in groups.
        String.raw`(?<![\w+])(?:\+|00)[1-9]\d{0,2}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?!\d)`,
      ].join("|"),
      "g",
    ),
    accept: (m) => {
      const n = digitsOnly(m).length;
      return n >= 10 && n <= 15;
    },
    normalize: (m) => {
      const d = digitsOnly(m);
      // +91 98765 43210, 098765 43210 and 9876543210 are the same Indian number.
      return d.length > 10 && /^(91|0)[6-9]\d{9}$/.test(d) ? d.slice(-10) : d;
    },
  },
];

const TOKEN = /\[(EMAIL|CARD|AADHAAR|PAN|PHONE)_(\d+)\]/g;

/**
 * Redacts one or more texts with a shared map, so a value repeated in the subject and the body
 * gets the same token in both.
 */
export class Redactor {
  private readonly tokens = new Map<string, string>(); // `${kind}:${normalized}` -> token
  private readonly originals = new Map<string, string>(); // token -> first original spelling
  private readonly counts = new Map<PiiKind, number>();

  redact(text: string): string {
    let out = text;
    for (const rule of RULES) {
      out = out.replace(rule.pattern, (match) => {
        if (rule.accept && !rule.accept(match)) return match;
        const key = `${rule.kind}:${rule.normalize ? rule.normalize(match) : match}`;
        let token = this.tokens.get(key);
        if (!token) {
          const n = (this.counts.get(rule.kind) ?? 0) + 1;
          this.counts.set(rule.kind, n);
          token = `[${rule.kind}_${n}]`;
          this.tokens.set(key, token);
          this.originals.set(token, match);
        }
        return token;
      });
    }
    return out;
  }

  /** Puts original values back. Unknown tokens (e.g. invented by a model) are left as they are. */
  restore(text: string): string {
    return text.replace(TOKEN, (token) => this.originals.get(token) ?? token);
  }

  /** Token -> original value. Never log this or send it to a model. */
  get map(): ReadonlyMap<string, string> {
    return this.originals;
  }

  /** How many values of each kind were redacted (safe to log). */
  get stats(): Partial<Record<PiiKind, number>> {
    return Object.fromEntries(this.counts);
  }
}
