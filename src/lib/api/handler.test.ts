import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, notFound } from "@/lib/errors";
import { type ApiErrorBody, parseJsonBody, resolveRequestId, withApiHandler } from "./handler";

const request = (init?: RequestInit) => new Request("http://localhost/api/test", init);

describe("resolveRequestId", () => {
  it("reuses a well-formed incoming x-request-id", () => {
    const headers = new Headers({ "x-request-id": "req_abc123-XYZ" });
    expect(resolveRequestId(headers)).toBe("req_abc123-XYZ");
  });

  it.each(["short", "has spaces in it", "inject\nnewline-value", "x".repeat(200)])(
    "replaces an unsafe incoming id (%j) with a fresh UUID",
    (value) => {
      // A lookalike object, because the real Headers class rejects raw newlines itself.
      const headers = { get: () => value } as unknown as Headers;
      const id = resolveRequestId(headers);
      expect(id).not.toBe(value);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    },
  );
});

describe("withApiHandler", () => {
  it("passes through successful responses and adds x-request-id", async () => {
    const handler = withApiHandler(async () => Response.json({ ok: true }));
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("resolves dynamic route params", async () => {
    const handler = withApiHandler<{ id: string }>(async (_req, { params }) =>
      Response.json({ id: params.id }),
    );
    const response = await handler(request(), { params: Promise.resolve({ id: "42" }) });
    expect(await response.json()).toEqual({ id: "42" });
  });

  it("maps AppError to its status and a uniform error body", async () => {
    const handler = withApiHandler(async () => {
      throw notFound("Ticket");
    });
    const response = await handler(request({ headers: { "x-request-id": "req_test_0001" } }));
    const body = (await response.json()) as ApiErrorBody;
    expect(response.status).toBe(404);
    expect(body.error).toEqual({
      code: "NOT_FOUND",
      message: "Ticket not found",
      requestId: "req_test_0001",
    });
  });

  it("maps ZodError to 400 with field details", async () => {
    const handler = withApiHandler(async () => {
      z.object({ subject: z.string().min(1) }).parse({ subject: "" });
      return Response.json({});
    });
    const response = await handler(request());
    const body = (await response.json()) as ApiErrorBody;
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toMatchObject({ fieldErrors: { subject: expect.any(Array) } });
  });

  it("hides the message of unexpected errors behind a generic 500", async () => {
    const handler = withApiHandler(async () => {
      throw new Error("connection to db-internal.example:5432 failed, password=hunter2");
    });
    const response = await handler(request());
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("db-internal");
  });

  it("does not expose the cause of a 5xx AppError", async () => {
    const handler = withApiHandler(async () => {
      throw new AppError("UPSTREAM_ERROR", "AI provider unavailable", {
        cause: new Error("secret upstream detail"),
      });
    });
    const response = await handler(request());
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).not.toContain("secret upstream detail");
  });
});

describe("parseJsonBody", () => {
  const schema = z.object({ name: z.string() });

  it("returns parsed data for a valid body", async () => {
    const req = request({ method: "POST", body: JSON.stringify({ name: "Ada" }) });
    await expect(parseJsonBody(req, schema)).resolves.toEqual({ name: "Ada" });
  });

  it("throws a VALIDATION_ERROR AppError for malformed JSON", async () => {
    const req = request({ method: "POST", body: "{not json" });
    await expect(parseJsonBody(req, schema)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    });
  });

  it("throws a ZodError for a schema mismatch", async () => {
    const req = request({ method: "POST", body: JSON.stringify({ name: 1 }) });
    await expect(parseJsonBody(req, schema)).rejects.toBeInstanceOf(z.ZodError);
  });
});
