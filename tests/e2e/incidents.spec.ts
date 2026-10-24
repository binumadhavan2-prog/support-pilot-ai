import { expect, test } from "@playwright/test";
import { authFile } from "./global-setup";

test.describe("as an agent", () => {
  test.use({ storageState: authFile("agent") });

  test("creates an incident, links a ticket, and resolves it", async ({ page }) => {
    const title = `[E2E] Checkout outage ${Date.now()}`;
    await page.goto("/incidents");

    // A ticket to link, created through the API as a webhook would.
    const res = await page.request.post("/api/tickets", {
      headers: { origin: new URL(page.url()).origin },
      data: {
        subject: `[E2E] Can't pay ${Date.now()}`,
        body: "Checkout fails with an error. [E2E test data]",
        customer: { name: "E2E Customer", email: "e2e.customer@example.test" },
      },
    });
    expect(res.status()).toBe(201);
    const ticket = (await res.json()).ticket as { id: string; number: number };

    await page.getByLabel("Title").fill(title);
    await page.locator("#new-incident-severity").selectOption("sev1");
    await page.getByRole("button", { name: "Create incident" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();

    // Link the ticket by number; it shows in the table and on the ticket page.
    await page.getByLabel("Link a ticket").fill(String(ticket.number));
    await page.getByRole("button", { name: "Link", exact: true }).click();
    await expect(page.getByText("Ticket linked.")).toBeVisible();
    await expect(page.getByText(`#${ticket.number} · E2E Customer`)).toBeVisible();

    // Resolve it (controls addressed by id: Next keeps the list page mounted).
    await page.locator("#incident-status").selectOption("resolved");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(page.getByText(/· resolved /)).toBeVisible();

    await page.goto(`/tickets/${ticket.id}`);
    await expect(page.getByRole("link", { name: title })).toBeVisible();
  });
});

test.describe("as a viewer", () => {
  test.use({ storageState: authFile("viewer") });

  test("sees incidents but can't change them", async ({ page }) => {
    await page.goto("/incidents");
    await expect(page.getByRole("heading", { name: "Incidents" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create incident" })).toHaveCount(0);
  });
});
