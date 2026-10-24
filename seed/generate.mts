/**
 * DEMO DATA generator. Uses Claude to write the fictional "Acme Cloud" dataset into seed/data:
 * 50 accounts (+ invoices, built in code), 40 KB articles, 5 runbooks, 3 incident bundles and
 * 300 tickets (incl. Hinglish / Tanglish, angry customers and 10 prompt-injection attempts).
 *
 *   npm run seed:generate                 # all missing steps
 *   npm run seed:generate -- --only=tickets
 *   npm run seed:generate -- --force      # regenerate everything (costs money again)
 *
 * Needs ANTHROPIC_API_KEY (in .env.local). Costs roughly $1-3 on Sonnet; token usage is printed.
 * Steps are resumable: finished files and ticket batches are reused unless --force is given.
 */
import { rmSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ARTICLES, INCIDENTS } from "./lib/catalog";
import { createClaudeClient } from "./lib/claude";
import {
  hasDataFile,
  PARTIAL_DIR,
  readDataFile,
  readPartial,
  writeDataFile,
  writePartial,
} from "./lib/files";
import {
  generateAccountProfiles,
  generateArticles,
  generateIncident,
  generateRunbooks,
  generateTicketBatch,
} from "./lib/generate";
import { buildAccountsAndOrders, buildTicketSlots } from "./lib/plan";
import type { Ticket } from "./lib/schemas";

const STEPS = ["accounts", "articles", "runbooks", "incidents", "tickets"] as const;
type Step = (typeof STEPS)[number];

const { values: args } = parseArgs({
  options: {
    only: { type: "string" },
    force: { type: "boolean", default: false },
    concurrency: { type: "string", default: "3" },
  },
});

try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local: rely on the real environment.
}

const env = z
  .object({
    ANTHROPIC_API_KEY: z
      .string({ error: "ANTHROPIC_API_KEY is required (add it to .env.local)" })
      .min(1, "ANTHROPIC_API_KEY is required (add it to .env.local)"),
    SEED_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  })
  .safeParse(process.env);
if (!env.success) {
  console.error(z.prettifyError(env.error));
  process.exit(1);
}

const only = args.only as Step | undefined;
if (only && !STEPS.includes(only)) {
  console.error(`--only must be one of: ${STEPS.join(", ")}`);
  process.exit(1);
}
const concurrency = Math.max(1, Number(args.concurrency) || 3);
const client = createClaudeClient({
  apiKey: env.data.ANTHROPIC_API_KEY,
  model: env.data.SEED_MODEL,
});
const meta = { generator: "seed/generate.mts", model: client.model };
const wanted = (step: Step) => !only || only === step;
const fileFor = {
  accounts: "accounts",
  articles: "kbArticles",
  runbooks: "runbooks",
  incidents: "incidents",
  tickets: "tickets",
} as const;
const skip = (step: Step) => {
  if (!wanted(step)) return true;
  if (!args.force && hasDataFile(fileFor[step])) {
    console.log(`skip     ${step} (exists; use --force to regenerate)`);
    return true;
  }
  return false;
};

if (args.force) rmSync(PARTIAL_DIR, { recursive: true, force: true });

async function inBatches<T, R>(
  items: T[],
  size: number,
  run: (batch: T[], index: number) => Promise<R>,
) {
  const batches = Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );
  const results: R[] = new Array(batches.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (next < batches.length) {
        const index = next++;
        results[index] = await run(batches[index], index);
      }
    }),
  );
  return results;
}

const started = Date.now();

if (!skip("accounts")) {
  console.log("generate accounts (profiles via Claude, plans and invoices in code)");
  const profiles = await generateAccountProfiles(client);
  const { accounts, orders } = buildAccountsAndOrders(profiles);
  writeDataFile("accounts", accounts, meta);
  writeDataFile("orders", orders, { ...meta, model: null, generator: "seed/lib/plan.ts" });
  console.log(`  wrote ${accounts.length} accounts, ${orders.length} invoices`);
}

if (!skip("articles")) {
  console.log(`generate ${ARTICLES.length} KB articles`);
  const batches = await inBatches(ARTICLES, 5, async (specs, i) => {
    const cached = readPartial<Awaited<ReturnType<typeof generateArticles>>>(`articles-${i}`);
    if (cached) return cached;
    const articles = await generateArticles(client, specs);
    writePartial(`articles-${i}`, articles);
    console.log(`  batch ${i + 1}: ${specs.map((s) => s.ref).join(" ")}`);
    return articles;
  });
  writeDataFile("kbArticles", batches.flat(), meta);
}

if (!skip("runbooks")) {
  console.log("generate 5 runbooks");
  writeDataFile("runbooks", await generateRunbooks(client), meta);
}

if (!skip("incidents")) {
  console.log(`generate ${INCIDENTS.length} incident bundles`);
  const incidents = [];
  for (const spec of INCIDENTS) {
    incidents.push(await generateIncident(client, spec));
    console.log(`  ${spec.ref}`);
  }
  writeDataFile("incidents", incidents, meta);
}

if (!skip("tickets")) {
  const { items: accounts } = readDataFile("accounts");
  const { items: orders } = readDataFile("orders");
  const slots = buildTicketSlots(accounts, orders);
  console.log(`generate ${slots.length} tickets`);
  const batches = await inBatches(slots, 15, async (batch, i) => {
    const cached = readPartial<Ticket[]>(`tickets-${i}`);
    if (cached) return cached;
    const tickets = await generateTicketBatch(client, batch, accounts, orders);
    writePartial(`tickets-${i}`, tickets);
    console.log(`  batch ${i + 1}: ${batch[0].label.ref}..${batch.at(-1)!.label.ref}`);
    return tickets;
  });
  writeDataFile("tickets", batches.flat(), meta);
  // The labels each ticket was written to satisfy: used to pre-fill the golden eval set only.
  writeDataFile(
    "ticketLabels",
    slots.map((s) => s.label),
    { ...meta, model: null, generator: "seed/lib/plan.ts" },
  );
}

const usage = client.usage();
console.log(
  `done in ${Math.round((Date.now() - started) / 1000)}s. Tokens (${client.model}): input ${usage.inputTokens}, output ${usage.outputTokens}, cache read ${usage.cacheReadTokens}, cache write ${usage.cacheWriteTokens}. See Anthropic's pricing page for cost.`,
);
