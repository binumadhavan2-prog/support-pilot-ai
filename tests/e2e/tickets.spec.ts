import { expect, test, type Page } from "@playwright/test";
import { authFile } from "./global-setup";

test.use({ storageState: authFile("agent") });

/** Creates a ticket through the API with the agent's session, as a webhook would. */
async function createTicket(page: Page, subject: string) {
  const res = await page.request.post("/api/tickets", {
    headers: { origin: new URL(page.url() || "http://localhost:3000").origin },
    data: {
      subject,
      body: "The export button does nothing when I click it. [E2E test data]",
      customer: { name: "E2E Customer", email: "e2e.customer@example.test" },
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).ticket as { id: string; number: number };
}

test("an agent finds a new ticket, assigns it, replies, and changes its status", async ({
  page,
}) => {
  const subject = `[E2E] Export broken ${Date.now()}`;
  await page.goto("/inbox");
  const ticket = await createTicket(page, subject);

  // Search finds it in the inbox.
  await page.getByLabel("Search").fill(subject);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/search=/);
  const link = page.getByRole("link", { name: subject });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/tickets/${ticket.id}$`));
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();

  // Next.js keeps the previous page (the inbox, with its own "Status" filter) mounted but hidden,
  // so the ticket's controls are addressed by id.
  const status = page.locator("#ticket-status");
  const assignee = page.locator("#ticket-assignee");

  // Assign to me.
  await page.getByRole("button", { name: "Assign to me" }).click();
  await expect(assignee).toHaveValue(/.+/);
  await expect(page.getByRole("button", { name: "Assign to me" })).toHaveCount(0);

  // Reply: it appears in the conversation as the agent, and the ticket moves to pending.
  await page.getByLabel("Reply").fill("Thanks, we've reproduced it and are fixing the export.");
  await page.getByRole("button", { name: "Add reply" }).click();
  await expect(page.getByText("Reply added to the conversation.")).toBeVisible();
  const conversation = page.getByRole("region", { name: "Conversation" });
  await expect(conversation.getByText("we've reproduced it")).toBeVisible();
  await expect(status).toHaveValue("pending");

  // Resolve it.
  await status.selectOption("resolved");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(status).toHaveValue("resolved");

  // The "Mine" filter shows it.
  await page.goto("/inbox?assignee=me&status=resolved");
  await expect(page.getByRole("link", { name: subject })).toBeVisible();
});

test("without a Claude key, drafting is explained instead of offered", async ({ page }) => {
  const ticket = await createTicket(page, `[E2E] Draft check ${Date.now()}`);
  await page.goto(`/tickets/${ticket.id}`);
  await expect(page.getByText("AI drafting is off until a Claude API key is set.")).toBeVisible();
});
