import { test } from "../support/fixtures";
import {
  closeModelPicker,
  expectModelSearchEmptyState,
  expectModelSearchResult,
  expectPinnedProfilesHidden,
  openModelPicker,
  searchAllModels,
  seedAgentProfiles,
  seedModelProvider,
} from "../support/helpers/agent-profiles";
import { expectComposerVisible } from "../support/helpers/composer";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";

const MOCK_PROVIDER_LABEL = "Mock Load Test";

// Its fast model deliberately carries the same label as the mock provider's, so
// the only thing telling the two result rows apart is the provider name.
const STUDIO = {
  id: "mock-studio",
  label: "Mock Studio",
  models: [
    { id: "studio-fast", label: "Ten second stream", description: "Studio quick pass" },
    { id: "studio-deep", label: "Studio deep think", description: "Studio long pass" },
  ],
};

// The cross-provider search lives on the picker's root view, and a profile is
// what keeps the picker opening there.
const ROOT_VIEW_PROFILE = {
  id: "agent_profile_e2e_search_root",
  name: "Search anchor",
  provider: "mock",
};

test.describe("Cross-provider model search", () => {
  test("one query over the picker root reaches every provider and names each result's provider", async ({
    page,
  }) => {
    const provider = await seedModelProvider(STUDIO);
    const profile = await seedAgentProfiles([ROOT_VIEW_PROFILE]);
    const workspace = await seedWorkspace({ repoPrefix: "model-search-providers-" });

    try {
      await test.step("open a draft composer that can reach every provider", async () => {
        await gotoWorkspace(page, workspace.workspaceId);
        await clickNewChat(page);
        await expectComposerVisible(page);
        await openModelPicker(page);
      });

      await test.step("one query returns the same model label from two providers", async () => {
        await searchAllModels(page, "ten second stream");
        await expectModelSearchResult(page, {
          provider: "mock",
          modelId: "ten-second-stream",
          modelLabel: "Ten second stream",
          providerLabel: MOCK_PROVIDER_LABEL,
        });
        await expectModelSearchResult(page, {
          provider: STUDIO.id,
          modelId: "studio-fast",
          modelLabel: "Ten second stream",
          providerLabel: STUDIO.label,
        });
      });

      await test.step("searching by provider name reaches that provider's own models", async () => {
        await searchAllModels(page, "studio deep");
        await expectModelSearchResult(page, {
          provider: STUDIO.id,
          modelId: "studio-deep",
          modelLabel: "Studio deep think",
          providerLabel: STUDIO.label,
        });
      });

      await test.step("results replace the pinned profiles", async () => {
        await expectPinnedProfilesHidden(page);
      });

      // Search falls back to subsequence matching, so "no matches" needs letters
      // that cannot be picked out of a model label or description in order.
      await test.step("a query with no matches repeats the query back", async () => {
        await searchAllModels(page, "zzz");
        await expectModelSearchEmptyState(page, "zzz");
        await closeModelPicker(page);
      });
    } finally {
      await workspace.cleanup();
      await profile.restore();
      await provider.restore();
    }
  });
});
