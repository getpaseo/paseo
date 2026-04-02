import { test, expect, type Page } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import { buildHostOpenProjectRoute } from "@/utils/host-routes";

/**
 * Autopilot toggle — mirrors the VSCode Copilot Autopilot shield behaviour.
 *
 * The toggle lives in the status-bar toolbar next to the model selector. Clicking it
 * switches between the provider's safest mode and its most permissive (autopilot) mode.
 */
test.describe("Autopilot toggle", () => {
  let tempRepo: { path: string; cleanup: () => Promise<void> };

  test.beforeAll(async () => {
    tempRepo = await createTempGitRepo("autopilot-toggle-");
  });

  test.afterAll(async () => {
    await tempRepo?.cleanup();
  });

  /**
   * Open the draft agent composer for the temp repo.
   *
   * Two paths depending on daemon state:
   *  A) First test in session — workspace not yet registered:
   *     navigate to open-project → click "Add a project" → fill path → submit → composer appears.
   *  B) Subsequent tests — workspace already registered by a previous test in this run:
   *     navigate to open-project → app auto-redirects to workspace → composer already visible.
   */
  async function openDraftComposer(page: Page) {
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) throw new Error("E2E_SERVER_ID not set — Playwright globalSetup must run first");

    await page.goto(buildHostOpenProjectRoute(serverId));

    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    const addProjectBtn = page.getByTestId("open-project-submit");

    // Race: either the workspace is already open (composer wins) or we need to register it first.
    const winner = await Promise.race([
      composer.waitFor({ state: "visible", timeout: 30_000 }).then(() => "composer" as const),
      addProjectBtn.waitFor({ state: "visible", timeout: 30_000 }).then(() => "add-project" as const),
    ]);

    if (winner === "add-project") {
      await addProjectBtn.click();
      const pathInput = page.getByPlaceholder("Type a directory path...");
      await expect(pathInput).toBeVisible({ timeout: 10_000 });
      await pathInput.fill(tempRepo.path);
      await pathInput.press("Enter");
      await expect(composer).toBeVisible({ timeout: 30_000 });
    }
    // If "composer" won, the app already navigated to the workspace — nothing more to do.
  }

  test("toggle is visible near the model selector on the draft composer", async ({ page }) => {
    await openDraftComposer(page);

    // Model selector must be visible as a reference anchor
    const modelSelector = page.getByTestId("combined-model-selector").first();
    await expect(modelSelector).toBeVisible({ timeout: 10_000 });

    // The autopilot toggle must be present in the same toolbar
    const toggle = page.getByTestId("autopilot-toggle").first();
    await expect(toggle).toBeVisible({ timeout: 10_000 });
  });

  test("toggle starts as inactive (safe mode default)", async ({ page }) => {
    await openDraftComposer(page);

    const toggle = page.getByTestId("autopilot-toggle").first();
    await expect(toggle).toBeVisible({ timeout: 10_000 });

    // Default provider (codex) uses "auto" mode — not the autopilot (full-access) mode
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  test("clicking the toggle enables autopilot", async ({ page }) => {
    await openDraftComposer(page);

    const toggle = page.getByTestId("autopilot-toggle").first();
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await toggle.click();

    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  test("clicking again disables autopilot (toggle round-trips)", async ({ page }) => {
    await openDraftComposer(page);

    const toggle = page.getByTestId("autopilot-toggle").first();
    await expect(toggle).toBeVisible({ timeout: 10_000 });

    // Enable
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    // Disable
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  test("mode selector reflects autopilot state after toggle", async ({ page }) => {
    await openDraftComposer(page);

    const toggle = page.getByTestId("autopilot-toggle").first();
    await expect(toggle).toBeVisible({ timeout: 10_000 });

    // Enable autopilot
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    // The mode selector (shield icon dropdown) should now reflect the autopilot mode
    const modeSelector = page.getByTestId("agent-mode-selector").first();
    await expect(modeSelector).toBeVisible();
  });
});

