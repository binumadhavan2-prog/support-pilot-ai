import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectGolden } from "../../seed/lib/golden";
import { parseGoldenJsonl, toGoldenJsonl } from "@/server/evals/golden";
import { fakeDataset } from "./fixtures";

const { slots, tickets } = fakeDataset();
const labels = slots.map((s) => s.label);
const golden = selectGolden(labels, tickets);

describe("selectGolden", () => {
  it("selects exactly 100 unique, valid rows awaiting review", () => {
    expect(golden).toHaveLength(100);
    expect(new Set(golden.map((r) => r.ticket_ref)).size).toBe(100);
    expect(golden.every((r) => r.review_status === "ai_labeled")).toBe(true);
    expect(parseGoldenJsonl(toGoldenJsonl(golden))).toEqual(golden);
  });

  it("includes every injection attempt and the other hard cases", () => {
    expect(golden.filter((r) => r.is_injection)).toHaveLength(10);
    expect(golden.filter((r) => r.language !== "en").length).toBeGreaterThanOrEqual(20);
    expect(golden.filter((r) => r.expected_kb_article_id === null).length).toBeGreaterThanOrEqual(
      18,
    );
    expect(new Set(golden.map((r) => r.category)).size).toBe(5);
  });

  it("copies labels unchanged from the plan", () => {
    for (const row of golden) {
      const label = labels.find((l) => l.ref === row.ticket_ref)!;
      expect(row).toMatchObject({
        category: label.category,
        priority: label.priority,
        expected_kb_article_id: label.expectedKbArticleId,
        is_injection: label.isInjection,
      });
    }
  });

  it("covers many different KB articles", () => {
    const articles = new Set(golden.map((r) => r.expected_kb_article_id).filter(Boolean));
    expect(articles.size).toBeGreaterThanOrEqual(35);
  });

  it("is deterministic", () => {
    expect(selectGolden(labels, tickets)).toEqual(golden);
  });
});

describe("parseGoldenJsonl", () => {
  const row = toGoldenJsonl(golden.slice(0, 1)).trim();

  it("reports invalid JSON, schema errors and duplicates with line numbers", () => {
    const bad = JSON.stringify({ ...JSON.parse(row), priority: "critical" });
    expect(() => parseGoldenJsonl(`${row}\nnot json\n${bad}\n${row}`)).toThrow(
      /line 2: not valid JSON[\s\S]*line 3:[\s\S]*priority[\s\S]*line 4: duplicate/,
    );
  });

  it("rejects unknown fields (typos in hand edits)", () => {
    const typo = JSON.stringify({ ...JSON.parse(row), is_injecton: true });
    expect(() => parseGoldenJsonl(typo)).toThrow(/is_injecton/);
  });
});

// Guards the committed file once it exists (it is created by `npm run seed:golden`).
describe.skipIf(!existsSync("evals/golden_tickets.jsonl"))("evals/golden_tickets.jsonl", () => {
  it("parses and has 100 rows", () => {
    expect(parseGoldenJsonl(readFileSync("evals/golden_tickets.jsonl", "utf8"))).toHaveLength(100);
  });
});
