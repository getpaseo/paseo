import { expect, test } from "../support/fixtures";

test("settings search renders only matching settings groups", async ({ page }) => {
  await page.goto("/settings");

  const search = page.getByTestId("settings-search");
  await expect(search).toBeVisible();
  await search.fill("Send");

  const results = page.getByTestId("settings-search-results");
  await expect(results).toBeVisible();
  await expect(results.getByText("Sending", { exact: true })).toBeVisible();
  await expect(results.getByText("Send shortcut", { exact: true })).toBeVisible();
  await expect(results.getByText("Projects & Workspaces", { exact: true })).not.toBeVisible();
  await expect(results.getByText("Open project", { exact: true })).not.toBeVisible();
  await expect(results.getByText("Appearance", { exact: true })).not.toBeVisible();
  await expect(results.getByText("Danger zone", { exact: true })).not.toBeVisible();

  await search.fill("Plan");
  await expect(results.getByText("Plan usage", { exact: true })).toBeVisible();
  await expect(results.getByText("Metadata generation", { exact: true })).not.toBeVisible();
  await expect(results.getByText("Sending", { exact: true })).not.toBeVisible();

  await search.fill("Profile");
  await expect(results.getByText("Agent profiles", { exact: true })).toBeVisible();
  await expect(results.getByText("Terminal agents", { exact: true })).not.toBeVisible();
  await expect(results.getByText("Plan usage", { exact: true })).not.toBeVisible();
});
