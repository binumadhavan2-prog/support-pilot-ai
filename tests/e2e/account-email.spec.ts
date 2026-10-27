import { expect, test } from "@playwright/test";
import { authFile } from "./global-setup";

/*
 * Password reset and email verification pages. These run without RESEND_API_KEY (as in local dev
 * and CI), so they check the "not set up" path and link handling; the full emailed flow is covered
 * by tests/auth/account-email.test.ts with a mock mailer.
 */

test.describe("signed out", () => {
  test("the sign-in page links to password reset, which explains when email is off", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
    await expect(page.getByText(/isn't set up on this server/)).toBeVisible();
  });

  test("a reset link without a valid token is refused", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByText(/invalid or has expired/)).toBeVisible();

    // A made-up token reaches Better Auth, which rejects it.
    await page.goto("/reset-password?token=made-up-token");
    await page.getByLabel("New password", { exact: true }).fill("a-long-enough-password");
    await page.getByLabel("Confirm new password").fill("a-long-enough-password");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText(/invalid or has expired/)).toBeVisible();
  });

  test("mismatched passwords are caught before anything is sent", async ({ page }) => {
    await page.goto("/reset-password?token=made-up-token");
    await page.getByLabel("New password", { exact: true }).fill("a-long-enough-password");
    await page.getByLabel("Confirm new password").fill("something-else-entirely");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText("The passwords don't match")).toBeVisible();
  });
});

test.describe("signed in", () => {
  test.use({ storageState: authFile("agent") });

  test("settings shows the email verification status", async ({ page }) => {
    await page.goto("/settings");
    // Demo accounts use a reserved test domain and are never verified by email.
    await expect(page.getByText("Not verified")).toBeVisible();
    await page.getByRole("button", { name: "Send verification email" }).click();
    await expect(page.getByText(/isn't set up|demo or test address/)).toBeVisible();
  });
});
