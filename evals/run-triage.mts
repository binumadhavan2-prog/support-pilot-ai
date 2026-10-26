/**
 * Triage eval: runs the production triage path (redact -> model -> restore) on every ticket in
 * evals/golden_tickets.jsonl, prints accuracy, confusion matrices and injection recall, and saves
 * the run to `eval_runs` in the demo tenant. Exits 1 if the pass criteria are not met.
 *
 *   npm run eval:triage                         # all cases, saved to the database
 *   npm run eval:triage -- --limit 10 --no-save # quick check, nothing written
 *
 * PAID: one Claude API request per golden ticket (needs ANTHROPIC_API_KEY). Set TRIAGE_MODEL to
 * compare models. FREE with --rules: scores the built-in keyword triage instead (no key, no AI).
 *
 *   npm run eval:triage -- --rules --no-save
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { z } from "zod";
import { createRulesTriageModel } from "@/server/ai/builtin";
import { createClaudeTriageModel, DEFAULT_TRIAGE_MODEL, triageText } from "@/server/ai/triage";
import { parseGoldenJsonl } from "@/server/evals/golden";
import {
  casesForStorage,
  formatReport,
  scoreTriage,
  type TriageCase,
} from "@/server/evals/triage-eval";
import { ensureTenant } from "@/server/tenants";
import { DEMO_TENANT } from "../seed/lib/demo-tenant";

const DATASET = "evals/golden_tickets.jsonl";

const { values: args } = parseArgs({
  options: {
    limit: { type: "string" },
    concurrency: { type: "string", default: "4" },
    "no-save": { type: "boolean", default: false },
    rules: { type: "boolean", default: false },
  },
});

try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local: rely on the real environment.
}
// Only what the eval itself needs; DATABASE_URL is required only when saving the run.
const env = z
  .object({
    ANTHROPIC_API_KEY: args.rules
      ? z.string().optional()
      : z
          .string({ error: "ANTHROPIC_API_KEY is required (or use --rules for the free eval)" })
          .min(1, "ANTHROPIC_API_KEY is required (or use --rules for the free eval)"),
    TRIAGE_MODEL: z.string().min(1).default(DEFAULT_TRIAGE_MODEL),
    DATABASE_URL: args["no-save"]
      ? z.string().optional()
      : z
          .string({ error: "DATABASE_URL is required to save the run (or pass --no-save)" })
          .regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgres:// connection string"),
  })
  .safeParse(process.env);
if (!env.success) {
  console.error(z.prettifyError(env.error));
  process.exit(1);
}

let text: string;
try {
  text = readFileSync(DATASET, "utf8");
} catch {
  console.error(
    `${DATASET} not found. Build it with: npm run seed:generate && npm run seed:golden`,
  );
  process.exit(1);
}
const all = parseGoldenJsonl(text);
const golden = args.limit ? all.slice(0, Number(args.limit)) : all;
const model = args.rules
  ? createRulesTriageModel()
  : createClaudeTriageModel({ apiKey: env.data.ANTHROPIC_API_KEY!, model: env.data.TRIAGE_MODEL });
const cost = args.rules ? "free, no AI" : `${golden.length} paid API calls`;
console.log(`Triage eval: ${golden.length} cases, model ${model.model} (${cost})\n`);

const cases: TriageCase[] = new Array(golden.length);
let inputTokens = 0;
let outputTokens = 0;
let next = 0;
let done = 0;
async function worker() {
  while (next < golden.length) {
    const i = next++;
    const g = golden[i];
    try {
      const result = await triageText(model, { subject: g.subject, body: g.body });
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      cases[i] = {
        golden: g,
        prediction: {
          category: result.output.category,
          priority: result.output.priority,
          language: result.output.language,
          is_injection: result.output.is_injection_attempt,
        },
      };
    } catch (error) {
      cases[i] = { golden: g, prediction: null, error: (error as Error).message };
    }
    process.stdout.write(`\r${++done}/${golden.length}`);
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency)) }, worker));
process.stdout.write("\n\n");

const score = scoreTriage(cases);
console.log(formatReport(score));
console.log(`\nTokens: ${inputTokens} input, ${outputTokens} output`);

if (!args["no-save"]) {
  // Validated above whenever the run is saved.
  const client = postgres(env.data.DATABASE_URL!, { max: 1, prepare: false });
  try {
    const db = drizzle(client, { schema });
    const tenant = await ensureTenant(db, DEMO_TENANT);
    const [run] = await db
      .insert(schema.evalRuns)
      .values({
        tenantId: tenant.id,
        name: `triage ${args.limit ? `(first ${golden.length})` : ""}`.trim(),
        datasetName: DATASET,
        datasetHash: createHash("sha256").update(text).digest("hex"),
        model: model.model,
        status: "completed",
        totalCases: golden.length,
        metrics: { ...score.metrics, inputTokens, outputTokens, passed: score.passed ? 1 : 0 },
        cases: casesForStorage(cases),
        finishedAt: new Date(),
      })
      .returning({ id: schema.evalRuns.id });
    console.log(`Saved eval run ${run.id}`);
  } finally {
    await client.end();
  }
}

process.exitCode = score.passed ? 0 : 1;
