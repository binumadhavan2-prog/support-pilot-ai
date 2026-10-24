import { afterEach, describe, expect, it, vi } from "vitest";
import { createResendMailer } from "./mailer";

/* The Resend client against a MOCK fetch: no network. */

const email = {
  to: "dana@customer-mail.net",
  subject: "Re: Export broken [#1042]",
  text: "Fixed now.",
  idempotencyKey: "msg-1",
};

function mockFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createResendMailer", () => {
  const mailer = createResendMailer({ apiKey: "re_test_key", from: "Support <help@acme.io>" });

  it("posts a plain-text email with the idempotency key", async () => {
    const fetchMock = mockFetch(Response.json({ id: "email_123" }));
    await expect(mailer.send(email)).resolves.toEqual({ providerId: "email_123" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer re_test_key",
      "idempotency-key": "msg-1",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      from: "Support <help@acme.io>",
      to: ["dana@customer-mail.net"],
      subject: email.subject,
      text: "Fixed now.",
    });
  });

  it("keeps the provider's error text out of the error message", async () => {
    mockFetch(new Response("invalid `to` field: dana@customer-mail.net", { status: 422 }));
    const error = await mailer.send(email).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "The email provider rejected the message (HTTP 422)",
    });
  });

  it("rejects an unexpected response body", async () => {
    mockFetch(Response.json({ ok: true }));
    await expect(mailer.send(email)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("reports a network failure as an upstream error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(mailer.send(email)).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Could not reach the email provider",
    });
  });
});
