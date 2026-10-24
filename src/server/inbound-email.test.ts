import { describe, expect, it } from "vitest";
import { parseInboundEmail } from "./inbound-email";

const email = (headers: string[], body: string) => [...headers, "", body].join("\r\n");

describe("parseInboundEmail", () => {
  it("maps sender, subject and plain-text body to ticket input", async () => {
    const { input } = await parseInboundEmail(
      email(["From: Asha Rao <ASHA@Example.test>", "Subject: Refund please"], "Order 42."),
    );
    expect(input).toEqual({
      subject: "Refund please",
      body: "Order 42.",
      customer: { name: "Asha Rao", email: "asha@example.test" },
    });
  });

  it("decodes encoded headers (e.g. non-English subjects)", async () => {
    const { input } = await parseInboundEmail(
      email(
        ["From: a@example.test", "Subject: =?UTF-8?B?4KSu4KWH4KSw4KS+IOCkrOCkv+Cksg==?="],
        "body",
      ),
    );
    expect(input.subject).toBe("मेरा बिल");
  });

  it("uses the address as the name and a placeholder subject when they are missing", async () => {
    const { input } = await parseInboundEmail(email(["From: bare@example.test"], "hello"));
    expect(input.customer.name).toBe("bare@example.test");
    expect(input.subject).toBe("(no subject)");
  });

  it("falls back to text from the HTML part, dropping scripts and tags", async () => {
    const { input } = await parseInboundEmail(
      email(
        ["From: a@example.test", "Subject: s", "Content-Type: text/html; charset=utf-8"],
        "<p>Hello&nbsp;<b>team</b></p><script>alert(1)</script><p>Tom &amp; Jerry</p>",
      ),
    );
    expect(input.body).toBe("Hello team\nTom & Jerry");
  });

  it("rejects messages without a sender or a body", async () => {
    await expect(parseInboundEmail(email(["Subject: s"], "hi"))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      parseInboundEmail(email(["From: a@example.test", "Subject: s"], "   ")),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("parseInboundEmail message id", () => {
  it("returns the Message-ID for deduplication, or null when absent", async () => {
    const withId = await parseInboundEmail(
      email(["From: a@example.test", "Subject: s", "Message-ID: <abc123@mail.example>"], "hi"),
    );
    expect(withId.messageId).toBe("<abc123@mail.example>");
    const without = await parseInboundEmail(email(["From: a@example.test", "Subject: s"], "hi"));
    expect(without.messageId).toBeNull();
  });
});
