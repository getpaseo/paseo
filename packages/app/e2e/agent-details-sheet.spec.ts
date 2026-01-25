import { test, expect } from "./fixtures";
import { createAgent, ensureHostSelected, gotoHome, setWorkingDirectory } from "./helpers/app";
import { createTempGitRepo } from "./helpers/workspace";

test("agent details sheet shows IDs and copy toast", async ({ page }) => {
  const repo = await createTempGitRepo();
  const prompt = "Respond with exactly: Hello";

  try {
    await gotoHome(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, prompt);

    await page.getByTestId("agent-overflow-menu").click();
    await page.getByTestId("agent-menu-details").click();

    await expect(page.getByTestId("agent-details-sheet")).toBeVisible();

    await expect(page.getByTestId("agent-details-agent-id")).toBeVisible();
    await expect(page.getByTestId("agent-details-agent-id-value")).not.toHaveText(
      "Not available"
    );

    await expect(page.getByTestId("agent-details-persistence-session-id")).toBeVisible();
    await expect(
      page.getByTestId("agent-details-persistence-session-id-value")
    ).not.toHaveText("Not available");

    await page.getByTestId("agent-details-agent-id").click();
    await expect(page.getByTestId("app-toast")).toBeVisible();
    await expect(page.getByTestId("app-toast-message")).toHaveText(/copied/i);
  } finally {
    await repo.cleanup();
  }
});

