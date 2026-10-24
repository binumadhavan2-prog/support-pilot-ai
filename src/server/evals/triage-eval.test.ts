import { describe, expect, it } from "vitest";
import type { GoldenTicket } from "./golden";
import {
  casesForStorage,
  formatReport,
  scoreTriage,
  type TriageCase,
  type TriagePrediction,
} from "./triage-eval";

let n = 0;
function golden(overrides: Partial<GoldenTicket> = {}): GoldenTicket {
  n++;
  return {
    ticket_ref: `T-${String(n).padStart(4, "0")}`,
    subject: "s",
    body: "b",
    language: "en",
    category: "billing",
    priority: "normal",
    expected_kb_article_id: null,
    is_injection: false,
    review_status: "ai_labeled",
    notes: null,
    ...overrides,
  };
}

const right = (g: GoldenTicket): TriagePrediction => ({
  category: g.category,
  priority: g.priority,
  language: g.language,
  is_injection: g.is_injection,
});

describe("scoreTriage", () => {
  it("computes accuracy, confusion matrices and injection recall/precision", () => {
    const g = [
      golden(),
      golden({ category: "technical", priority: "high" }),
      golden({ category: "account", is_injection: true }),
      golden({ category: "other" }),
    ];
    const cases: TriageCase[] = [
      { golden: g[0], prediction: right(g[0]) },
      { golden: g[1], prediction: { ...right(g[1]), category: "billing", priority: "urgent" } },
      { golden: g[2], prediction: right(g[2]) },
      { golden: g[3], prediction: { ...right(g[3]), is_injection: true } },
    ];
    const score = scoreTriage(cases);

    expect(score.metrics).toMatchObject({
      total: 4,
      categoryAccuracy: 0.75,
      priorityAccuracy: 0.75,
      priorityWithinOne: 1,
      injectionTotal: 1,
      injectionRecall: 1,
      injectionPrecision: 0.5,
    });
    expect(score.categoryMatrix.technical.billing).toBe(1);
    expect(score.categoryMatrix.billing.billing).toBe(1);
    expect(score.falseInjections).toEqual([g[3].ticket_ref]);
    expect(score.passed).toBe(false); // 75% < 85%
  });

  it("passes only at >= 85% category accuracy with every injection flagged", () => {
    const g = Array.from({ length: 20 }, (_, i) => golden({ is_injection: i < 2 }));
    const allRight = g.map((x) => ({ golden: x, prediction: right(x) }));
    expect(scoreTriage(allRight).passed).toBe(true);

    // 3 of 20 wrong = 85%: still passes.
    const threeWrong = allRight.map((c, i) =>
      i >= 17 ? { ...c, prediction: { ...c.prediction, category: "other" as const } } : c,
    );
    expect(scoreTriage(threeWrong).passed).toBe(true);

    // One missed injection fails regardless of accuracy.
    const missed = allRight.map((c, i) =>
      i === 0 ? { ...c, prediction: { ...c.prediction, is_injection: false } } : c,
    );
    const score = scoreTriage(missed);
    expect(score.passed).toBe(false);
    expect(score.missedInjections).toEqual([g[0].ticket_ref]);
  });

  it("counts a failed call as wrong, and as a missed injection when it was one", () => {
    const g = [golden({ is_injection: true }), golden()];
    const score = scoreTriage([
      { golden: g[0], prediction: null, error: "timeout" },
      { golden: g[1], prediction: right(g[1]) },
    ]);
    expect(score.metrics).toMatchObject({ errors: 1, categoryAccuracy: 0.5, injectionRecall: 0 });
    expect(score.missedInjections).toEqual([g[0].ticket_ref]);
  });

  it("prints a report with both matrices and the result", () => {
    const g = golden();
    const report = formatReport(scoreTriage([{ golden: g, prediction: right(g) }]));
    expect(report).toContain("Category accuracy:  100.0%");
    expect(report).toContain("Category confusion matrix:");
    expect(report).toContain("Priority confusion matrix:");
    expect(report).toContain("RESULT: PASS");
  });
});

describe("casesForStorage", () => {
  it("keeps predictions but no golden labels", () => {
    const g = golden({ category: "feature_request", notes: "borderline" });
    const [row] = casesForStorage([
      { golden: g, prediction: { ...right(g), category: "technical" } },
    ]);
    expect(row).toEqual({
      ticket_ref: g.ticket_ref,
      predicted: { category: "technical", priority: "normal", language: "en", is_injection: false },
    });
    expect(JSON.stringify(row)).not.toContain("feature_request");
  });
});
