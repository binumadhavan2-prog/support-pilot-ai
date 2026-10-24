import { describe, expect, it } from "vitest";
import { Redactor, luhnValid } from "./redact";

const redact = (text: string) => new Redactor().redact(text);

describe("Redactor", () => {
  it("redacts emails", () => {
    expect(redact("Mail me at Priya.N+billing@Example.co.in please")).toBe(
      "Mail me at [EMAIL_1] please",
    );
  });

  it.each([
    ["9876543210", "bare Indian mobile"],
    ["+91 98765 43210", "+91 with 5+5 split"],
    ["+91-9876543210", "+91 with dash"],
    ["09876543210", "leading 0"],
    ["+1 (415) 555-2671", "US"],
    ["+44 20 7946 0958", "UK"],
    ["+971 50 123 4567", "UAE"],
  ])("redacts phone %s (%s)", (phone) => {
    expect(redact(`call ${phone} today`)).toBe("call [PHONE_1] today");
  });

  it("redacts card numbers that pass Luhn, with or without separators", () => {
    expect(redact("card 4111 1111 1111 1111 declined")).toBe("card [CARD_1] declined");
    expect(redact("card 5500-0000-0000-0004")).toBe("card [CARD_1]");
    expect(redact("card 4111111111111111")).toBe("card [CARD_1]");
  });

  it("redacts Aadhaar and PAN", () => {
    expect(redact("Aadhaar 2345 6789 0123, PAN ABCDE1234F")).toBe(
      "Aadhaar [AADHAAR_1], PAN [PAN_1]",
    );
    expect(redact("pan abcde1234f")).toBe("pan [PAN_1]");
  });

  it("leaves non-PII numbers and ids alone", () => {
    const text =
      "Invoice INV-10388 for order 12345, ₹4,999 on 2026-10-20, ticket #1042, ref KB-005, 16 digits 1234567812345678";
    expect(redact(text)).toBe(text);
  });

  it("gives a repeated value one token, even when formatted differently", () => {
    const r = new Redactor();
    const subject = r.redact("Call back on +91 98765 43210");
    const body = r.redact("My number is 9876543210, alt 9123456780, email a@b.co");
    expect(subject).toBe("Call back on [PHONE_1]");
    expect(body).toBe("My number is [PHONE_1], alt [PHONE_2], email [EMAIL_1]");
    expect(r.stats).toEqual({ EMAIL: 1, PHONE: 2 });
  });

  it("restores tokens to the original text and leaves unknown tokens", () => {
    const r = new Redactor();
    const redacted = r.redact("Refund to a@b.co, card 4111 1111 1111 1111");
    expect(r.restore(redacted)).toBe("Refund to a@b.co, card 4111 1111 1111 1111");
    expect(r.restore("Customer [EMAIL_1] asked about [PHONE_9]")).toBe(
      "Customer a@b.co asked about [PHONE_9]",
    );
  });

  it("does not split a card number into a phone number", () => {
    const r = new Redactor();
    expect(r.redact("4111 1111 1111 1111")).toBe("[CARD_1]");
    expect(r.stats).toEqual({ CARD: 1 });
  });
});

describe("luhnValid", () => {
  it("accepts valid and rejects invalid checksums", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });
});
