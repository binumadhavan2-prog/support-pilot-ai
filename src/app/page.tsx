import Link from "next/link";
import { Button } from "@/components/ui/button";

const phases = [
  { name: "Foundation", detail: "Schema, migrations, env validation, logging, CI", done: true },
  { name: "Auth & roles", detail: "Sign-in, sessions, admin / agent / viewer", done: true },
  { name: "Tickets", detail: "Inbox, ticket detail, status workflow", done: false },
  { name: "Knowledge base", detail: "Upload, chunking, hybrid retrieval, citations", done: false },
  { name: "AI copilot", detail: "Classification and human-approved draft replies", done: false },
  { name: "Analytics & evals", detail: "Ticket metrics and answer quality scoring", done: false },
  { name: "Hardening", detail: "E2E tests, rate limits, Docker, deployment", done: false },
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-10 px-4 py-16 sm:px-6">
      <header className="flex flex-col gap-3">
        <p className="text-sm font-medium text-muted-foreground">Support Pilot AI</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          AI Support &amp; Operations Copilot
        </h1>
        <p className="text-base leading-7 text-muted-foreground">
          Ticket triage, retrieval-grounded reply drafts with citations, and human approval before
          anything reaches a customer.
        </p>
        <div>
          <Button asChild size="lg">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </header>

      <section aria-labelledby="progress-heading" className="flex flex-col gap-4">
        <h2
          id="progress-heading"
          className="text-sm font-semibold tracking-wide text-muted-foreground uppercase"
        >
          Build progress
        </h2>
        <ol className="flex flex-col divide-y rounded-lg border">
          {phases.map((phase, index) => (
            <li key={phase.name} className="flex items-start gap-3 px-4 py-3">
              <span
                className={
                  phase.done
                    ? "mt-0.5 text-sm font-semibold text-emerald-600 dark:text-emerald-400"
                    : "mt-0.5 text-sm font-semibold text-muted-foreground"
                }
                aria-label={phase.done ? "Done" : "Not started"}
              >
                {phase.done ? "✓" : index + 1}
              </span>
              <div className="flex flex-col">
                <span className="font-medium">{phase.name}</span>
                <span className="text-sm text-muted-foreground">{phase.detail}</span>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
