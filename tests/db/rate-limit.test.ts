import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consumeRateLimit } from "@/server/rate-limit";
import { createTestDb, type TestDb } from "./test-db";

/* Fixed-window rate limiting on PGlite. */

let db: TestDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close?.();
});

const at = (iso: string) => ({ now: new Date(iso) });

describe("consumeRateLimit", () => {
  it("allows up to the limit, then throws RATE_LIMITED with Retry-After until the window ends", async () => {
    const t = "2026-10-21T10:00:15Z";
    expect(await consumeRateLimit(db, "k1", 3, at(t))).toMatchObject({ remaining: 2 });
    await consumeRateLimit(db, "k1", 3, at(t));
    expect(await consumeRateLimit(db, "k1", 3, at(t))).toMatchObject({ remaining: 0 });
    await expect(consumeRateLimit(db, "k1", 3, at(t))).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      retryAfterSeconds: 45, // the window started at 10:00:00 and lasts 60 s
    });
    // The next window starts fresh.
    expect(await consumeRateLimit(db, "k1", 3, at("2026-10-21T10:01:00Z"))).toMatchObject({
      remaining: 2,
    });
  });

  it("counts each key separately", async () => {
    const t = "2026-10-21T11:00:00Z";
    await consumeRateLimit(db, "a", 1, at(t));
    await expect(consumeRateLimit(db, "a", 1, at(t))).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    await expect(consumeRateLimit(db, "b", 1, at(t))).resolves.toMatchObject({ remaining: 0 });
  });

  it("is atomic: concurrent requests never share a count", async () => {
    const t = "2026-10-21T12:00:00Z";
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit(db, "burst", 100, at(t))),
    );
    expect(new Set(results.map((r) => r.remaining)).size).toBe(20);
    expect(Math.min(...results.map((r) => r.remaining))).toBe(80);
  });
});
