import type { Page } from "@playwright/test";
import { expect } from "./model-visibility-fixture";
import {
  closeModelPicker,
  drillIntoProvider,
  expectComposerModel,
  openModelPicker,
  searchAllModels,
} from "./agent-profiles";
import { expectComposerVisible } from "./composer";
import { clickNewChat, gotoWorkspace } from "./launcher";

export const PROVIDER = {
  id: "mock-visibility",
  label: "Mock Visibility",
  models: [
    { id: "vis-default", label: "Visible default", description: "The provider default" },
    { id: "vis-second", label: "Visible second", description: "The other one" },
  ],
};

export const HIDDEN_MODEL = PROVIDER.models[0];
export const REMAINING_MODEL = PROVIDER.models[1];

export function pickerViewport(page: Page) {
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
export async function showProviderRoot(page: Page) {
  const back = pickerViewport(page).getByRole("button", { name: "Back" });
  await expect(back).toBeVisible();
  await back.click();
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

export async function selectDefaultModel(page: Page, workspace: { workspaceId: string }) {
  await openDraftPicker(page, workspace.workspaceId);
  await openProviderModels(page);
  await expect(modelRow(page, HIDDEN_MODEL.id)).toBeVisible({ timeout: 30_000 });
  await expect(modelRow(page, REMAINING_MODEL.id)).toBeVisible();
  await modelRow(page, HIDDEN_MODEL.id).click();
  await expectComposerModel(page, HIDDEN_MODEL.label);
}

export async function hideDefaultModel(page: Page) {
  await openModelPicker(page);
  await openProviderModels(page);
  await openProviderSettingsFromPicker(page);
  const toggle = visibilitySwitch(page, HIDDEN_MODEL.id);
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toHaveAttribute("role", "switch");
  await expect(toggle).toHaveAccessibleName("Show vis-default in model pickers");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("a");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
}

export async function expectHiddenModelRestorable(page: Page) {
  // Scoped: the composer trigger also names the selected model.
  await expect(
    page.getByTestId("provider-settings-sheet").getByText(HIDDEN_MODEL.label, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(visibilitySwitch(page, HIDDEN_MODEL.id)).toHaveAttribute("aria-checked", "false");
  await closeProviderSettings(page);
}

export async function expectHiddenModelAbsent(page: Page) {
  await expect(modelRow(page, HIDDEN_MODEL.id)).toHaveCount(0, { timeout: 30_000 });
  await expect(modelRow(page, REMAINING_MODEL.id)).toBeVisible();
}

export async function expectHiddenModelAbsentFromSearch(page: Page) {
  await closeModelPicker(page);
  await openModelPicker(page);
  // Cross-provider search lives on the picker root, not a provider detail view.
  await showProviderRoot(page);
  await searchAllModels(page, "Visible");
  await expect(modelRow(page, REMAINING_MODEL.id)).toBeVisible({ timeout: 30_000 });
  await expect(modelRow(page, HIDDEN_MODEL.id)).toHaveCount(0);
  await closeModelPicker(page);
}

export async function expectFreshVisibleDefault(page: Page) {
  // In-session, so this tests the fresh-default rule itself rather than
  // how long a remembered composer preference takes to persist. The
  // hidden model is both this provider's isDefault and the remembered
  // preference, so both fallback paths are exercised at once.
  await clickNewChat(page);
  await expectComposerVisible(page);
  await expectComposerModel(page, REMAINING_MODEL.label);
}

export async function expectHiddenModelAfterReload(page: Page, workspace: { workspaceId: string }) {
  // Visibility lives in daemon config, so it has to survive a reload
  // independently of any client-side draft state.
  await page.reload();
  await openDraftPicker(page, workspace.workspaceId);
  await openProviderModels(page);
  await expect(modelRow(page, HIDDEN_MODEL.id)).toHaveCount(0, { timeout: 30_000 });
  await expect(modelRow(page, REMAINING_MODEL.id)).toBeVisible();
}

export async function restoreDefaultModel(page: Page) {
  await openProviderSettingsFromPicker(page);
  const toggle = visibilitySwitch(page, HIDDEN_MODEL.id);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await closeProviderSettings(page);
  await expect(modelRow(page, HIDDEN_MODEL.id)).toBeVisible({ timeout: 30_000 });
  // Leave the picker closed so teardown can remove the project without the
  // open popover holding the workspace.
  await closeModelPicker(page);
}
