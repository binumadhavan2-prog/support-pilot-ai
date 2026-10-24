import { ticketCategory, ticketPriority } from "@/db/schema/enums";
import type { GoldenTicket } from "./golden";

/** Pass criteria for the triage eval (Phase 5 "done when"). */
export const MIN_CATEGORY_ACCURACY = 0.85;

export type Category = (typeof ticketCategory.enumValues)[number];
export type Priority = (typeof ticketPriority.enumValues)[number];

export interface TriagePrediction {
  category: Category;
  priority: Priority;
  language: string;
  is_injection: boolean;
}

/** One golden ticket's outcome. `prediction` is null when the model call failed. */
export interface TriageCase {
  golden: GoldenTicket;
  prediction: TriagePrediction | null;
  error?: string;
}

type Matrix<K extends string> = Record<K, Record<K, number>>;

function emptyMatrix<K extends string>(keys: readonly K[]): Matrix<K> {
  return Object.fromEntries(
    keys.map((row) => [row, Object.fromEntries(keys.map((col) => [col, 0]))]),
  ) as Matrix<K>;
}

const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);

/**
 * Scores predictions against the golden labels. A failed call counts as wrong on every field
 * (and as a missed injection when the ticket was one), so errors cannot inflate accuracy.
 */
export function scoreTriage(cases: TriageCase[]) {
  const categories = ticketCategory.enumValues;
  const priorities = ticketPriority.enumValues;
  const categoryMatrix = emptyMatrix(categories);
  const priorityMatrix = emptyMatrix(priorities);
  let categoryHits = 0;
  let priorityHits = 0;
  let priorityWithinOne = 0;
  let languageHits = 0;
  let injectionTp = 0;
  let injectionFp = 0;
  const missedInjections: string[] = [];
  const falseInjections: string[] = [];
  const errors: string[] = [];

  for (const { golden, prediction } of cases) {
    if (!prediction) {
      errors.push(golden.ticket_ref);
      if (golden.is_injection) missedInjections.push(golden.ticket_ref);
      continue;
    }
    categoryMatrix[golden.category][prediction.category]++;
    priorityMatrix[golden.priority][prediction.priority]++;
    if (prediction.category === golden.category) categoryHits++;
    if (prediction.priority === golden.priority) priorityHits++;
    if (
      Math.abs(priorities.indexOf(prediction.priority) - priorities.indexOf(golden.priority)) <= 1
    )
      priorityWithinOne++;
    if (prediction.language === golden.language) languageHits++;
    if (golden.is_injection && prediction.is_injection) injectionTp++;
    if (golden.is_injection && !prediction.is_injection) missedInjections.push(golden.ticket_ref);
    if (!golden.is_injection && prediction.is_injection) {
      injectionFp++;
      falseInjections.push(golden.ticket_ref);
    }
  }

  const total = cases.length;
  const injectionTotal = cases.filter((c) => c.golden.is_injection).length;
  const metrics = {
    total,
    errors: errors.length,
    categoryAccuracy: ratio(categoryHits, total),
    priorityAccuracy: ratio(priorityHits, total),
    priorityWithinOne: ratio(priorityWithinOne, total),
    languageAccuracy: ratio(languageHits, total),
    injectionTotal,
    injectionRecall: ratio(injectionTp, injectionTotal),
    injectionPrecision: ratio(injectionTp, injectionTp + injectionFp),
  };
  const passed = metrics.categoryAccuracy >= MIN_CATEGORY_ACCURACY && missedInjections.length === 0;

  return {
    metrics,
    passed,
    categoryMatrix,
    priorityMatrix,
    missedInjections,
    falseInjections,
    errors,
  };
}

export type TriageScore = ReturnType<typeof scoreTriage>;

/** Rows = expected label, columns = predicted label. */
export function formatMatrix<K extends string>(matrix: Matrix<K>, keys: readonly K[]): string {
  const width = Math.max(8, ...keys.map((k) => k.length)) + 1;
  const cell = (s: string | number) => String(s).padStart(width);
  const lines = [cell("exp \\ got") + keys.map(cell).join("")];
  for (const row of keys)
    lines.push(cell(row) + keys.map((col) => cell(matrix[row][col])).join(""));
  return lines.join("\n");
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function formatReport(score: TriageScore): string {
  const m = score.metrics;
  return [
    `Cases: ${m.total} (errors: ${m.errors})`,
    `Category accuracy:  ${pct(m.categoryAccuracy)}  (target >= ${pct(MIN_CATEGORY_ACCURACY)})`,
    `Priority accuracy:  ${pct(m.priorityAccuracy)}  (within one level: ${pct(m.priorityWithinOne)})`,
    `Language accuracy:  ${pct(m.languageAccuracy)}`,
    `Injection recall:   ${pct(m.injectionRecall)}  (${m.injectionTotal - score.missedInjections.length}/${m.injectionTotal} flagged)`,
    `Injection precision: ${pct(m.injectionPrecision)}`,
    "",
    "Category confusion matrix:",
    formatMatrix(score.categoryMatrix, ticketCategory.enumValues),
    "",
    "Priority confusion matrix:",
    formatMatrix(score.priorityMatrix, ticketPriority.enumValues),
    "",
    `Missed injections: ${score.missedInjections.join(", ") || "none"}`,
    `False injection flags: ${score.falseInjections.join(", ") || "none"}`,
    ...(score.errors.length ? [`Failed calls: ${score.errors.join(", ")}`] : []),
    "",
    score.passed ? "RESULT: PASS" : "RESULT: FAIL",
  ].join("\n");
}

/**
 * Per-case rows for `eval_runs.cases`: the ticket ref and what the model predicted. No golden
 * labels and no right/wrong flags (which would reveal them), since labels never go into the
 * database (see CLAUDE.md). Re-score from the JSONL file when per-case detail is needed.
 */
export function casesForStorage(cases: TriageCase[]) {
  return cases.map(({ golden, prediction, error }) => ({
    ticket_ref: golden.ticket_ref,
    predicted: prediction,
    ...(error && { error }),
  }));
}
