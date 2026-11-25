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
  expectProfileReachableByScrolling,
  expectProfileSearchResult,
  expectProfileVisibleForProvider,
  openModelPicker,
  openAgentProfilesFromEmptyPrompt,
  searchModelPicker,
  seedAgentProfiles,
  selectModelRow,
} from "../support/helpers/agent-profiles";
import {
  chooseCommandCenterAgentControl,
  expectWorkspaceAgentConfiguration,
  openCommandCenterForAgent,
} from "../support/helpers/command-center-agent-controls";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

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
  test("an empty host still exposes agent profile settings from the picker", async ({ page }) => {
    const seed = await seedAgentProfiles([]);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profiles-empty-",
      title: "Agent profiles empty",
    });

    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
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

  test("a profile is found by searching the model picker or the command center", async ({
    page,
  }) => {
    const seed = await seedAgentProfiles([PROFILE]);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profiles-search-",
      title: "Agent profiles search",
      model: "ten-second-stream",
      modeId: "load-test",
    });

    try {
      await test.step("searching its name in the model picker lists only the profile", async () => {
        await openAgentRoute(page, workspace);
        await expectComposerVisible(page);
        await openModelPicker(page);
        await searchModelPicker(page, "ui work");
        await expectProfileSearchResult(page, { name: PROFILE.name });
      });

      await test.step("searching its model lists the profile above the model", async () => {
        await searchModelPicker(page, "one minute");
        await expectProfileSearchResult(page, {
          name: PROFILE.name,
          model: { provider: "mock", modelId: "one-minute-stream" },
        });
        await closeModelPicker(page);
      });

      await test.step("choosing it from the command center applies it", async () => {
        await openCommandCenterForAgent(page, workspace);
        await chooseCommandCenterAgentControl({
          page,
          query: "ui work",
          choice: `Profile › ${PROFILE.name}`,
        });
        await expectComposerModel(page, "One minute stream");
        await expectComposerMode(page, "Approval test");
        await expectWorkspaceAgentConfiguration(workspace, {
          id: workspace.agentId,
          provider: "mock",
          model: "one-minute-stream",
          modeId: "approval-test",
        });
      });
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });

  test("profile-only search results scroll inside the picker", async ({ page }) => {
    const profiles = Array.from({ length: 12 }, (_, index) => ({
      id: `agent_profile_e2e_release_${index + 1}`,
      name: `Release review ${String(index + 1).padStart(2, "0")}`,
      provider: "mock",
      model: "one-minute-stream",
    }));
    const seed = await seedAgentProfiles(profiles);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profiles-search-scroll-",
      title: "Agent profiles search scroll",
      model: "ten-second-stream",
      modeId: "load-test",
    });

    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      await openModelPicker(page);
      await searchModelPicker(page, "release review");
      await expectProfileSearchResult(page, { name: "Release review 01" });
      await expectProfileReachableByScrolling(page, "Release review 12");
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });
});
