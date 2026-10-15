import { expect, test } from "../support/fixtures";
import {
  applyProfileFromPicker,
  closeModelPicker,
  expectComposerDoesNotName,
  expectAgentProfilesEmptyPrompt,
  expectProfileEditTooltip,
  expectComposerMode,
  expectCreateProfileFromModelRow,
  expectComposerModel,
  expectModelRowProfileActionBesideRow,
  expectModelRowSelected,
  expectProfileEditIsPencilOnly,
  expectProfileVisibleForProvider,
  openModelPicker,
  openAgentProfilesFromEmptyPrompt,
  seedAgentProfiles,
  seedModelProvider,
  selectModelRow,
} from "../support/helpers/agent-profiles";
import { expectWorkspaceAgentConfiguration } from "../support/helpers/command-center-agent-controls";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
} from "../support/helpers/new-workspace";

const PROFILE = {
  id: "agent_profile_e2e_ui_work",
  name: "UI work",
  icon: "🎨",
  provider: "mock",
  model: "one-minute-stream",
  modeId: "approval-test",
  notes: "Use for UI work.",
};

const PROFILE_SUMMARY = "Mock Load Test · One minute stream · Approval test";

test.describe("Agent profiles in the model picker", () => {
  test("Shift+Tab still toggles plan after Tab and leaves the background agent unchanged", async ({
    page,
  }, testInfo) => {
    const provider = await seedModelProvider({
      id: "shortcut-models",
      label: "Shortcut models",
      models: [{ id: "fast", label: "Fast model", description: "Keyboard test model" }],
    });
    const seed = await seedAgentProfiles([
      {
        id: "shortcut-profile",
        name: "Fast work",
        provider: "shortcut-models",
        model: "fast",
        modeId: "bypassPermissions",
      },
    ]);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "profile-tab-background-",
      title: "Background agent",
      model: "ten-second-stream",
    });
    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, workspace);
      await openModelPicker(page);
      await expect(page.getByText("Fast work", { exact: true })).toBeVisible();
      await closeModelPicker(page);
      const input = page.getByRole("textbox", { name: "Message agent..." });
      await input.click();
      await input.fill("Keep the draft focused");
      await expect(input).toBeFocused();
      await page.keyboard.press("Tab");
      await expectComposerModel(page, "Fast model");
      await expect(input).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByTestId("message-input-plan-stripe")).toBeVisible();
      await expect(input).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath("plan-after-tab.png") });
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByTestId("message-input-plan-stripe")).toHaveCount(0);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("Keep the draft focused");
      await expectWorkspaceAgentConfiguration(workspace, {
        provider: "mock",
        model: "ten-second-stream",
        modeId: "load-test",
      });
    } finally {
      await workspace.cleanup();
      await seed.restore();
      await provider.restore();
    }
  });

  test("Tab cycles profiles without losing composer focus or consuming autocomplete", async ({
    page,
  }, testInfo) => {
    const seed = await seedAgentProfiles([
      PROFILE,
      { ...PROFILE, id: "agent_profile_second", name: "Quick work", model: "ten-second-stream" },
    ]);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profile-tab-",
      title: "Profile keyboard shortcuts",
      model: "e2e-fast-stream",
    });

    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      const input = page.getByRole("textbox", { name: "Message agent..." });
      await input.fill("Keep this draft");
      await page.keyboard.press("Tab");
      await expectComposerModel(page, "One minute stream");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("Keep this draft");

      for (const modifiers of [
        { altKey: true },
        { ctrlKey: true },
        { metaKey: true },
        { isComposing: true },
      ]) {
        await input.dispatchEvent("keydown", { key: "Tab", code: "Tab", ...modifiers });
      }
      await expectWorkspaceAgentConfiguration(workspace, {
        provider: "mock",
        model: "one-minute-stream",
        modeId: "approval-test",
      });

      await page.keyboard.down("Tab");
      await expectComposerModel(page, "Ten second stream");
      await page.keyboard.down("Tab");
      await page.keyboard.up("Tab");
      await expect(input).toBeFocused();
      await expectWorkspaceAgentConfiguration(workspace, {
        provider: "mock",
        model: "ten-second-stream",
        modeId: "approval-test",
      });

      await page.keyboard.press("Tab");
      await expectComposerModel(page, "One minute stream");
      await expect(input).toBeFocused();

      await input.fill("@README");
      await expect(
        page.getByTestId("composer-autocomplete-popover").getByText("README.md", { exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("composer-autocomplete-popover")).not.toBeVisible();
      await expect(input).toBeFocused();
      await expectWorkspaceAgentConfiguration(workspace, {
        provider: "mock",
        model: "one-minute-stream",
        modeId: "approval-test",
      });
      await input.fill("");
      await page.evaluate(() => {
        localStorage.setItem(
          "@paseo:app-settings",
          JSON.stringify({ language: "fr", theme: "light" }),
        );
      });
      await page.reload();
      const frenchInput = page.getByTestId("message-input-surface").getByRole("textbox");
      await expect(frenchInput).toBeVisible();
      await frenchInput.fill("");
      await page.screenshot({ path: testInfo.outputPath("french-composer.png") });
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });

  test("an empty host still exposes agent profile settings from the picker", async ({ page }) => {
    const seed = await seedAgentProfiles([]);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profiles-empty-",
      title: "Agent profiles empty",
    });

    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      const input = page.getByRole("textbox", { name: "Message agent..." });
      await input.click();
      await page.keyboard.press("Tab");
      await expect(input).not.toBeFocused();
      await openModelPicker(page);
      await expectAgentProfilesEmptyPrompt(page);
      await openAgentProfilesFromEmptyPrompt(page);
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });

  test("applying a pinned profile materializes it into the composer and is then forgotten", async ({
    page,
  }) => {
    const seed = await seedAgentProfiles([PROFILE]);
    // A live agent is one provider's process, so the profile has to name that
    // same provider or the picker will not offer it at all.
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profiles-picker-",
      title: "Agent profiles picker",
      model: "ten-second-stream",
      modeId: "load-test",
    });

    try {
      await test.step("the agent starts on its seeded model and mode", async () => {
        await openAgentRoute(page, workspace);
        await expectComposerVisible(page);
        await expectComposerModel(page, "Ten second stream");
        await expectComposerMode(page, "Load test");
      });

      await test.step("the sole provider opens directly", async () => {
        await openModelPicker(page);
        await expect(page.getByTestId("model-search-input").first()).toBeVisible();
        await expect(page.getByTestId("sheet-header-back")).toHaveCount(0);
        await expect(page.locator('[data-testid^="model-provider-"]')).toHaveCount(0);
        await expectProfileVisibleForProvider(page, {
          name: PROFILE.name,
          summary: PROFILE_SUMMARY,
        });
        await expectProfileEditIsPencilOnly(page);
        await expectProfileEditTooltip(page);
      });

      await test.step("applying it writes its model and mode into the composer", async () => {
        await applyProfileFromPicker(page, PROFILE.name);
        await expectComposerModel(page, "One minute stream");
        await expectComposerMode(page, "Approval test");
        await expectWorkspaceAgentConfiguration(workspace, {
          id: workspace.agentId,
          provider: "mock",
          model: "one-minute-stream",
          modeId: "approval-test",
        });
      });

      await test.step("the composer names the model, never the profile", async () => {
        await expectComposerDoesNotName(page, PROFILE.name);
      });

      await test.step("reopening returns directly to the provider models", async () => {
        await openModelPicker(page);
        await expect(page.getByTestId("model-search-input").first()).toBeVisible();
        await expectProfileVisibleForProvider(page, {
          name: PROFILE.name,
          summary: PROFILE_SUMMARY,
        });
        await expectModelRowSelected(page, { provider: "mock", modelId: "one-minute-stream" });
        await closeModelPicker(page);
      });
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });

  test("a model row and its create-profile action are separate buttons", async ({ page }) => {
    const seed = await seedAgentProfiles([]);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profiles-row-action-",
      title: "Agent profiles row action",
      model: "ten-second-stream",
      modeId: "load-test",
    });

    try {
      const oneMinute = {
        provider: "mock",
        modelId: "one-minute-stream",
        modelLabel: "One minute stream",
      };
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      await openModelPicker(page);
      await expectModelRowProfileActionBesideRow(page, oneMinute);
      await expectCreateProfileFromModelRow(page, oneMinute);
      await expectComposerModel(page, "Ten second stream");
      await openModelPicker(page);
      await selectModelRow(page, oneMinute);
      await expectComposerModel(page, oneMinute.modelLabel);
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });
});
