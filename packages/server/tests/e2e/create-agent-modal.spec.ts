import { test, expect } from "@playwright/test";

test("opens the create agent modal", async ({ page }) => {
  await page.goto("/?modal=create");

  await expect(page.getByText("Create New Agent")).toBeVisible();
  await expect(page.getByText("Initial Prompt")).toBeVisible();
  await expect(
    page.getByPlaceholder("Describe what you want the agent to do")
  ).toBeVisible();
  await expect(page.getByText("Working Directory")).toBeVisible();
  await expect(page.getByText("Create Agent")).toBeVisible();
});
