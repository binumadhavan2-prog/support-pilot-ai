import { expect, test } from "@playwright/test";
import { authFile } from "./global-setup";

test.use({ storageState: authFile("viewer") });

const html = (page: import("@playwright/test").Page) => page.locator("html");

test("the theme toggle cycles system, light and dark, and remembers the choice", async ({
  page,
}) => {
  // The OS asks for dark: "system" (the default) follows it.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/inbox");
  await expect(html(page)).toHaveClass(/\bdark\b/);

  await page.getByRole("button", { name: /^Theme: System/ }).click();
  await expect(html(page)).not.toHaveClass(/\bdark\b/); // light, despite the OS

  await page.getByRole("button", { name: /^Theme: Light/ }).click();
  await expect(html(page)).toHaveClass(/\bdark\b/);

  // Remembered across a reload, and applied before the page is interactive.
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(html(page)).toHaveClass(/\bdark\b/);
  await expect(page.getByRole("button", { name: /^Theme: Dark/ })).toBeVisible();

  // Back to system, which now follows the (light) OS setting.
  await page.getByRole("button", { name: /^Theme: Dark/ }).click();
  await expect(html(page)).not.toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html(page)).toHaveClass(/\bdark\b/);
});
