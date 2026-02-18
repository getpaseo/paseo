import { test, expect } from "./fixtures";
import { ensureHostSelected, gotoHome, setWorkingDirectory } from "./helpers/app";
import { createTempGitRepo } from "./helpers/workspace";

test("draft enables explorer after selecting a working directory", async ({ page }) => {
  const repo = await createTempGitRepo("paseo-e2e-draft-explorer-");

  try {
    await gotoHome(page);
    await ensureHostSelected(page);

    const newAgentButton = page.getByTestId("sidebar-new-agent").first();
    await expect(newAgentButton).toBeVisible({ timeout: 30000 });
    await newAgentButton.click();
    await expect(page).toHaveURL(/\/agent\/?$/, { timeout: 30000 });

    await setWorkingDirectory(page, repo.path);

    const toggle = page
      .getByRole("button", {
        name: /open explorer|close explorer|toggle explorer/i,
      })
      .first();
    await expect(toggle).toBeVisible({ timeout: 30000 });

    await toggle.click();
    await expect(
      page.locator('[data-testid="explorer-header"]:visible').first()
    ).toBeVisible({ timeout: 30000 });

    const terminalsTab = page
      .locator('[data-testid="explorer-tab-terminals"]:visible')
      .first();
    await expect(terminalsTab).toBeVisible({ timeout: 30000 });
    await terminalsTab.click();
    await expect(
      page.locator('[data-testid="terminal-surface"]:visible').first()
    ).toBeVisible({ timeout: 30000 });
  } finally {
    await repo.cleanup();
  }
});
