/**
 * DEMO DATA from templates: writes the same seed/data files as `seed:generate`, but with no
 * model, no API key and no cost. Same accounts, invoices, labels and scenarios (seed/lib/plan.ts);
 * plainer, more repetitive wording. Deterministic: running it twice gives the same data.
 *
 *   npm run seed:templates              # writes files that don't exist yet
 *   npm run seed:templates -- --force   # overwrites seed/data (including Claude-written files)
 *
 * Then `npm run seed:load` loads it, exactly as with the generated dataset.
 */
import { parseArgs } from "node:util";
import { hasDataFile, writeDataFile } from "./lib/files";
import { buildAccountsAndOrders, buildTicketSlots } from "./lib/plan";
import { DATA_FILES } from "./lib/schemas";
import {
  templateAccountProfiles,
  templateArticles,
  templateIncidents,
  templateRunbooks,
  templateTicket,
} from "./lib/templates";

const { values: args } = parseArgs({ options: { force: { type: "boolean", default: false } } });

const existing = (Object.keys(DATA_FILES) as (keyof typeof DATA_FILES)[]).filter((key) =>
  hasDataFile(key),
);
if (existing.length > 0 && !args.force) {
  console.error(
    `seed/data already has ${existing.join(", ")}. Use --force to replace it with template data.`,
  );
  process.exit(1);
}

const meta = { generator: "seed/templates.mts", model: null };
const { accounts, orders } = buildAccountsAndOrders(templateAccountProfiles());
const slots = buildTicketSlots(accounts, orders);
const byRef = new Map(accounts.map((a) => [a.ref, a]));

writeDataFile("accounts", accounts, meta);
writeDataFile("orders", orders, { ...meta, generator: "seed/lib/plan.ts" });
writeDataFile("kbArticles", templateArticles(), meta);
writeDataFile("runbooks", templateRunbooks(), meta);
writeDataFile("incidents", templateIncidents(), meta);
writeDataFile(
  "tickets",
  slots.map((slot) => templateTicket(slot, byRef.get(slot.accountRef)!)),
  meta,
);
// Labels each ticket was written to satisfy: for the golden eval set only, never the database.
writeDataFile(
  "ticketLabels",
  slots.map((s) => s.label),
  { ...meta, generator: "seed/lib/plan.ts" },
);

console.log(
  `wrote ${accounts.length} accounts, ${orders.length} invoices, ${templateArticles().length} articles, ` +
    `${templateRunbooks().length} runbooks, ${templateIncidents().length} incidents, ${slots.length} tickets (template text, no AI)`,
);
