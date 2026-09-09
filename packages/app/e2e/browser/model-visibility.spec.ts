import { expect, test, type Page } from "../support/fixtures";
import {
  closeModelPicker,
  drillIntoProvider,
  expectComposerModel,
  openModelPicker,
  searchAllModels,
  seedModelProvider,
} from "../support/helpers/agent-profiles";
import { expectComposerVisible } from "../support/helpers/composer";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";

const PROVIDER = {
  id: "mock-visibility",
  label: "Mock Visibility",
  models: [
    { id: "vis-default", label: "Visible default", description: "The provider default" },
    { id: "vis-second", label: "Visible second", description: "The other one" },
  ],
};

const HIDDEN_MODEL = PROVIDER.models[0];
const REMAINING_MODEL = PROVIDER.models[1];

function pickerViewport(page: Page) {
  return page.getByTestId("combobox-desktop-container");
}

function modelRow(page: Page, modelId: string) {
  return pickerViewport(page).getByTestId(`model-row-${PROVIDER.id}-${modelId}`);
}

async function openProviderSettingsFromPicker(page: Page) {
  await page.getByRole("button", { name: `Open ${PROVIDER.label} settings` }).click();
  await expect(page.getByTestId("provider-settings-sheet")).toBeVisible({ timeout: 30_000 });
}

function visibilitySwitch(page: Page, modelId: string) {
  return page.getByTestId(`provider-model-visibility-${modelId}`);
}

async function closeProviderSettings(page: Page) {
  await page.getByLabel("Close", { exact: true }).last().click({ force: true });
  await expect(page.getByTestId("provider-settings-sheet")).toHaveCount(0, { timeout: 30_000 });
}

/**
 * The picker opens on whichever provider is currently selected, not on the
 * provider list, so reaching another provider means going back first.
 */
async function showProviderRoot(page: Page) {
  const back = pickerViewport(page).getByRole("button", { name: "Back" });
  if (await back.isVisible().catch(() => false)) {
    await back.click();
  }
  await expect(pickerViewport(page).getByTestId(`model-provider-${PROVIDER.id}`)).toBeVisible({
    timeout: 30_000,
  });
}

async function openProviderModels(page: Page) {
  await showProviderRoot(page);
  await drillIntoProvider(page, PROVIDER.id);
}

async function openDraftPicker(page: Page, workspaceId: string) {
  await gotoWorkspace(page, workspaceId);
  await clickNewChat(page);
  await expectComposerVisible(page);
  await openModelPicker(page);
}

test.describe("Per-model visibility", () => {
  test("hiding a model removes it from every selector and restoring brings it back", async ({
    page,
  }) => {
    const provider = await seedModelProvider(PROVIDER);
    const workspace = await seedWorkspace({ repoPrefix: "model-visibility-" });

    try {
      await test.step("select the provider default, so it becomes the remembered model", async () => {
        await openDraftPicker(page, workspace.workspaceId);
        await openProviderModels(page);
        await expect(modelRow(page, HIDDEN_MODEL.id)).toBeVisible({ timeout: 30_000 });
        await expect(modelRow(page, REMAINING_MODEL.id)).toBeVisible();
        await modelRow(page, HIDDEN_MODEL.id).click();
        await expectComposerModel(page, HIDDEN_MODEL.label);
      });

      await test.step("switch the provider default off in provider settings", async () => {
        await openModelPicker(page);
        await openProviderModels(page);
        await openProviderSettingsFromPicker(page);
        const toggle = visibilitySwitch(page, HIDDEN_MODEL.id);
        await expect(toggle).toBeVisible({ timeout: 30_000 });
        await expect(toggle).toHaveAttribute("aria-checked", "true");
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
      });

      await test.step("settings still lists the hidden model so it can be restored", async () => {
        // Scoped: the composer trigger also names the selected model.
        await expect(
          page.getByTestId("provider-settings-sheet").getByText(HIDDEN_MODEL.label, {
            exact: true,
          }),
        ).toBeVisible();
        await expect(visibilitySwitch(page, HIDDEN_MODEL.id)).toHaveAttribute(
          "aria-checked",
          "false",
        );
        await closeProviderSettings(page);
      });

      await test.step("the hidden model is gone from the provider list", async () => {
        await expect(modelRow(page, HIDDEN_MODEL.id)).toHaveCount(0, { timeout: 30_000 });
        await expect(modelRow(page, REMAINING_MODEL.id)).toBeVisible();
      });

      await test.step("the hidden model is gone from cross-provider search too", async () => {
        await closeModelPicker(page);
        await openModelPicker(page);
        // Cross-provider search lives on the picker root, not a provider detail view.
        await showProviderRoot(page);
        await searchAllModels(page, "Visible");
        await expect(modelRow(page, REMAINING_MODEL.id)).toBeVisible({ timeout: 30_000 });
        await expect(modelRow(page, HIDDEN_MODEL.id)).toHaveCount(0);
        await closeModelPicker(page);
      });

      await test.step("a fresh draft preselects a visible model, not the hidden one", async () => {
        // In-session, so this tests the fresh-default rule itself rather than
        // how long a remembered composer preference takes to persist. The
        // hidden model is both this provider's isDefault and the remembered
        // preference, so both fallback paths are exercised at once.
        await clickNewChat(page);
        await expectComposerVisible(page);
        await expectComposerModel(page, REMAINING_MODEL.label);
      });

      await test.step("a reload keeps the model hidden", async () => {
        // Visibility lives in daemon config, so it has to survive a reload
        // independently of any client-side draft state.
        await page.reload();
        await openDraftPicker(page, workspace.workspaceId);
        await openProviderModels(page);
        await expect(modelRow(page, HIDDEN_MODEL.id)).toHaveCount(0, { timeout: 30_000 });
        await expect(modelRow(page, REMAINING_MODEL.id)).toBeVisible();
      });

      await test.step("switching it back on restores it everywhere", async () => {
        await openProviderSettingsFromPicker(page);
        const toggle = visibilitySwitch(page, HIDDEN_MODEL.id);
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
        await closeProviderSettings(page);
        await expect(modelRow(page, HIDDEN_MODEL.id)).toBeVisible({ timeout: 30_000 });
        // Leave the picker closed so teardown can remove the project without the
        // open popover holding the workspace.
        await closeModelPicker(page);
      });
    } finally {
      // seedWorkspace owns a project record and a seed client. Without this the
      // ownership fixture reports a leaked project and fails the run.
      await workspace.cleanup();
      await provider.restore();
    }
  });
});
