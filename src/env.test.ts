import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv } from "./env";

const valid = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
};

describe("parseEnv", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(env.NODE_ENV).toBe("development");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.BETTER_AUTH_URL).toBe("http://localhost:3000");
  });

  it("rejects a missing BETTER_AUTH_SECRET", () => {
    expect(() => parseEnv({ DATABASE_URL: valid.DATABASE_URL })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("requires BETTER_AUTH_URL in production", () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: "production" })).toThrow(/BETTER_AUTH_URL/);
    const env = parseEnv({
      ...valid,
      NODE_ENV: "production",
      BETTER_AUTH_URL: "https://app.example",
    });
    expect(env.BETTER_AUTH_URL).toBe("https://app.example");
  });

  it("accepts the postgresql:// scheme", () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: "postgresql://localhost/db" })).not.toThrow();
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => parseEnv({})).toThrow(EnvValidationError);
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: "mysql://localhost/db" })).toThrow(/postgres/);
  });

  it("treats empty strings as unset for optional keys", () => {
    const env = parseEnv({ ...valid, ANTHROPIC_API_KEY: "", LOG_LEVEL: "", BETTER_AUTH_URL: "" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.LOG_LEVEL).toBeUndefined();
    // Empty BETTER_AUTH_URL falls back to the development default.
    expect(env.BETTER_AUTH_URL).toBe("http://localhost:3000");
  });

  it("rejects a short BETTER_AUTH_SECRET", () => {
    expect(() => parseEnv({ ...valid, BETTER_AUTH_SECRET: "too-short" })).toThrow(/32/);
  });

  it("accepts an absolute MODEL_CACHE_DIR and rejects a relative one", () => {
    expect(parseEnv({ ...valid, MODEL_CACHE_DIR: "/tmp/transformers" }).MODEL_CACHE_DIR).toBe(
      "/tmp/transformers",
    );
    expect(() => parseEnv({ ...valid, MODEL_CACHE_DIR: "cache" })).toThrow(/MODEL_CACHE_DIR/);
  });

  it("rejects an invalid LOG_LEVEL", () => {
    expect(() => parseEnv({ ...valid, LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });

  it("never includes secret values in the error message", () => {
    const secret = "sk-ant-should-never-appear-in-errors";
    try {
      parseEnv({
        DATABASE_URL: "not-a-url",
        ANTHROPIC_API_KEY: secret,
        BETTER_AUTH_SECRET: secret,
      });
      expect.unreachable("parseEnv should have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain("not-a-url");
    }
  });
});
