import { expect, test } from "@playwright/test";
import { authFile } from "./global-setup";

test.use({ storageState: authFile("agent") });

test("an agent sees the SLA clocks and adds an internal note the customer never gets", async ({
  page,
}) => {
  await page.goto("/inbox");
  const res = await page.request.post("/api/tickets", {
    headers: { origin: new URL(page.url()).origin },
    data: {
      subject: `[E2E] SLA and notes ${Date.now()}`,
      body: "Our invoices are not sending. [E2E test data]",
      customer: { name: "E2E Customer", email: "e2e.customer@example.test" },
      priority: "urgent",
    },
  });
  expect(res.status()).toBe(201);
  const ticket = (await res.json()).ticket as { id: string };

  await page.goto(`/tickets/${ticket.id}`);
  const serviceLevel = page.getByRole("heading", { name: "Service level" });
  await expect(serviceLevel).toBeVisible();
  await expect(page.getByText("target 1h")).toBeVisible(); // urgent: first reply within 1 hour
  await expect(page.getByText(/Due in \d+m/).first()).toBeVisible();

  await page.getByLabel("Reply or internal note").fill("Escalating to billing ops. [E2E]");
  await page.getByRole("button", { name: "Add internal note" }).click();
  await expect(page.getByText("Internal note added. The customer won't see it.")).toBeVisible();
  const note = page.getByRole("article").filter({ hasText: "Escalating to billing ops." });
  await expect(note.getByText("Internal note")).toBeVisible();
  // Not a reply: no email status, and the ticket is still open (no first response yet).
  await expect(note.getByText(/emailed|Not emailed/i)).toHaveCount(0);
  await expect(page.locator("#ticket-status")).toHaveValue("open");

  // The inbox can filter by SLA.
  await page.goto("/inbox?sla=at_risk");
  await expect(page.locator("#sla")).toHaveValue("at_risk");
});
