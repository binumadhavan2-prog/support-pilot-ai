import { expect, test } from "@playwright/test";
import { authFile, emailFor } from "./global-setup";

test.describe("signed out", () => {
  test("protected pages redirect to the login page", async ({ page }) => {
    await page.goto("/inbox");
    await expect(page).toHaveURL(/\/login\?next=%2Finbox/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("a wrong password shows a generic error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(emailFor("agent"));
    await page.getByLabel("Password").fill("definitely-not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // Next.js also renders a (hidden) route announcer with role="alert"; match ours by its text.
    await expect(
      page.getByRole("alert").filter({ hasText: "Invalid email or password." }),
    ).toBeVisible();
  });

  test("an admin can sign in with the form", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(emailFor("admin"));
    await page.getByLabel("Password").fill(process.env.DEMO_USER_PASSWORD!);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  });

  test("Try as Guest signs in as the read-only viewer", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Try as Guest" }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    // Viewers can't review drafts, so Approvals is not in their navigation.
    const nav = page.getByRole("navigation").or(page.locator("[data-sidebar=content]"));
    await expect(nav.getByRole("link", { name: "Inbox" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Approvals" })).toHaveCount(0);
  });
});

test.describe("viewer", () => {
  test.use({ storageState: authFile("viewer") });

  test("cannot open admin or review pages", async ({ page }) => {
    for (const path of ["/settings/users", "/approvals"]) {
      await page.goto(path);
      await expect(page.getByText(/permission|forbidden|403/i).first()).toBeVisible();
    }
  });
});

test("every page sends the security headers", async ({ request }) => {
  const res = await request.get("/login");
  const headers = res.headers();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-powered-by"]).toBeUndefined();
});
