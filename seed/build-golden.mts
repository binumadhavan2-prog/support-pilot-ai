/**
 * Builds evals/golden_tickets.jsonl from the generated tickets and the labels they were written
 * to satisfy. Rows start as review_status "ai_labeled"; after reading each ticket, correct any
 * label the text does not support and set "human_verified".
 *
 *   npm run seed:golden            # refuses to overwrite an existing file
 *   npm run seed:golden -- --force # overwrite (discards manual review!)
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { toGoldenJsonl } from "@/server/evals/golden";
import { readDataFile } from "./lib/files";
import { selectGolden } from "./lib/golden";

const GOLDEN_PATH = "evals/golden_tickets.jsonl";
const { values } = parseArgs({ options: { force: { type: "boolean", default: false } } });

if (existsSync(GOLDEN_PATH) && !values.force) {
  console.error(`${GOLDEN_PATH} exists and may contain manual review. Use --force to overwrite.`);
  process.exit(1);
}

const rows = selectGolden(readDataFile("ticketLabels").items, readDataFile("tickets").items);
mkdirSync("evals", { recursive: true });
writeFileSync(GOLDEN_PATH, toGoldenJsonl(rows));

const count = (pick: (r: (typeof rows)[number]) => string) =>
  rows.reduce<Record<string, number>>((m, r) => ({ ...m, [pick(r)]: (m[pick(r)] ?? 0) + 1 }), {});
console.log(`wrote ${rows.length} rows to ${GOLDEN_PATH}`);
console.log({
  injection: rows.filter((r) => r.is_injection).length,
  language: count((r) => r.language),
  category: count((r) => r.category),
  priority: count((r) => r.priority),
  noArticle: rows.filter((r) => !r.expected_kb_article_id).length,
});
