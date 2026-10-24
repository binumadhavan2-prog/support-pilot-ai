import { expect, test } from "@playwright/test";
import { authFile } from "./global-setup";

test.use({ storageState: authFile("viewer") });

test("analytics shows the headline numbers, the trend chart and range switching", async ({
  page,
}) => {
  await page.goto("/analytics");
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  for (const label of ["Tickets created", "Open backlog", "Median first response"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  const chart = page.getByRole("img", { name: /Tickets created and resolved per day/ });
  await expect(chart).toBeVisible();

  // Hovering the chart shows a tooltip with both series.
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
  await expect(page.getByText(/^Created: \d+$/)).toBeVisible();

  // The table view lists one row per day.
  await page.getByText("View as table").click();
  await expect(page.getByRole("columnheader", { name: "Day (UTC)" })).toBeVisible();

  await page.getByRole("link", { name: "7 days" }).click();
  await expect(page).toHaveURL(/days=7/);
  await expect(page.getByText("Created and resolved, last 7 days.")).toBeVisible();
});
