import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { authFile } from "./global-setup";

test.use({ storageState: authFile("admin") });

test("an admin uploads a document, finds it by asking, and deletes it", async ({ page }) => {
  const stamp = Date.now();
  const title = `E2E Refund policy ${stamp}`;
  const markdown = [
    `# ${title}`,
    "",
    "## Duplicate charges",
    "",
    "If a customer was charged twice, open Billing, select the duplicate invoice and click Refund.",
    "The money reaches the card in 5 to 7 business days.",
    "",
    "<!-- [E2E test data] -->",
  ].join("\n");

  await page.goto("/knowledge");
  await page.getByLabel(/^File/).setInputFiles({
    name: `e2e-refunds-${stamp}.md`,
    mimeType: "text/markdown",
    buffer: Buffer.from(markdown),
  });
  await page.getByRole("button", { name: "Upload" }).click();
  // The first upload loads the local embedding model, which can take a while.
  await expect(page.getByText(`Added "${title}"`)).toBeVisible({ timeout: 90_000 });
  const row = page.getByRole("row").filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Help article");

  // Uploading the same file again is refused.
  await page.getByLabel(/^File/).setInputFiles({
    name: `copy-${stamp}.md`,
    mimeType: "text/markdown",
    buffer: Buffer.from(markdown),
  });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByText("already in the knowledge base")).toBeVisible();

  // Asking (search-only without a Claude key) returns the new section, including in Hinglish.
  for (const question of [
    "customer was charged twice, how do I refund?",
    "mera payment do baar kat gaya, refund kaise milega?",
  ]) {
    await page.getByLabel("Question").fill(question);
    await page.getByRole("button", { name: "Ask" }).click();
    await expect(page.locator("#source-1")).toContainText(title);
  }

  // Delete it (confirming the browser dialog).
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("row").filter({ hasText: title })).toHaveCount(0);
});

for (const [label, file, mimeType] of [
  ["PDF", "refund-policy.pdf", "application/pdf"],
  [
    "Word document",
    "refund-policy.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
] as const) {
  test(`an admin uploads a ${label} and finds its text`, async ({ page }) => {
    const title = `E2E ${label} ${Date.now()}`;
    await page.goto("/knowledge");
    await page.getByLabel(/^File/).setInputFiles({
      name: `e2e-${file}`,
      mimeType,
      buffer: readFileSync(`tests/fixtures/${file}`),
    });
    await page.getByLabel("Title (optional)").fill(title);
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByText(`Added "${title}"`)).toBeVisible({ timeout: 90_000 });

    await page.getByLabel("Question").fill("is a duplicate charge refunded automatically?");
    await page.getByRole("button", { name: "Ask" }).click();
    await expect(page.locator("#source-1")).toContainText(title);

    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("row")
      .filter({ hasText: title })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(page.getByRole("row").filter({ hasText: title })).toHaveCount(0);
  });
}

test("a viewer can ask but not upload", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: authFile("viewer") });
  const page = await ctx.newPage();
  await page.goto("/knowledge");
  await expect(page.getByRole("heading", { name: "Knowledge Base" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload" })).toHaveCount(0);
  await ctx.close();
});
