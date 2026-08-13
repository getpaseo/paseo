import { test } from "../support/fixtures";
import {
  createAgentProfile,
  createAgentProfileFromEmptyState,
  editAgentProfile,
  expectAgentProfile,
  expectAgentProfileForm,
  expectAgentProfileOrder,
  expectAgentProfileTagsGone,
  expectHostAgentProfiles,
  expectNoAgentProfiles,
  moveAgentProfileUp,
  openAgentProfileSettings,
  removeAgentProfile,
  seedAgentProfiles,
  stageLegacyFavoritesForHostMigration,
} from "../support/helpers/agent-profiles";

const MOCK_PROVIDER_LABEL = "Mock Load Test";

test.describe("Agent profiles settings", () => {
  test("legacy model favourites migrate into provider-and-model-only host profiles", async ({
    page,
  }) => {
    const seed = await seedAgentProfiles([]);
    const migratedProfile = {
      id: "legacy_favorite:mock:one-minute-stream",
      name: "One minute stream",
      provider: "mock",
      model: "one-minute-stream",
    };

    try {
      await stageLegacyFavoritesForHostMigration(page, [
        { provider: "mock", modelId: "one-minute-stream" },
      ]);

      await expectHostAgentProfiles([migratedProfile]);
      await openAgentProfileSettings(page);
      await expectAgentProfile(page, {
        name: migratedProfile.name,
        tags: [MOCK_PROVIDER_LABEL, "One minute stream"],
      });
    } finally {
      await seed.restore();
    }
  });

  test("host owner creates, edits, reorders and removes agent profiles", async ({ page }) => {
    // The journey owns the list, so it starts from an empty one whatever the
    // worker ran before, and hands it back untouched.
    const seed = await seedAgentProfiles([]);

    try {
      await test.step("the section starts empty", async () => {
        await openAgentProfileSettings(page);
        await expectNoAgentProfiles(page);
      });

      await test.step("create a profile from the modal", async () => {
        await createAgentProfileFromEmptyState(page, {
          name: "UI work",
          provider: MOCK_PROVIDER_LABEL,
          model: "Ten second stream",
          thinking: "High",
          mode: "Approval test",
          notes: "Use for UI work — components, layout and design tokens.",
        });
        await expectAgentProfile(page, {
          name: "UI work",
          tags: [MOCK_PROVIDER_LABEL, "Ten second stream", "Approval test", "High"],
          notes: "Use for UI work — components, layout and design tokens.",
        });
      });

      await test.step("editing to a model without thinking levels drops the level", async () => {
        await editAgentProfile(page, "UI work", {
          model: "One minute stream",
          notes: "Now for quick checks.",
        });
        await expectAgentProfile(page, {
          name: "UI work",
          tags: [MOCK_PROVIDER_LABEL, "One minute stream", "Approval test"],
          notes: "Now for quick checks.",
        });
        await expectAgentProfileTagsGone(page, {
          name: "UI work",
          tags: ["Ten second stream", "High"],
        });
      });

      await test.step("the edit form reopens on what was stored", async () => {
        await expectAgentProfileForm(page, "UI work", {
          provider: MOCK_PROVIDER_LABEL,
          model: "One minute stream",
          mode: "Approval test",
          notes: "Now for quick checks.",
        });
      });

      await test.step("a second profile lands below the first", async () => {
        await createAgentProfile(page, {
          name: "Deep review",
          provider: MOCK_PROVIDER_LABEL,
          model: "Five minute stream",
        });
        await expectAgentProfileOrder(page, ["UI work", "Deep review"]);
      });

      await test.step("reorder puts the second profile on top", async () => {
        await moveAgentProfileUp(page, "Deep review");
        await expectAgentProfileOrder(page, ["Deep review", "UI work"]);
      });

      await test.step("removing a profile confirms by name", async () => {
        await removeAgentProfile(page, "UI work");
        await expectAgentProfileOrder(page, ["Deep review"]);
      });

      await test.step("removing the last profile returns the empty state", async () => {
        await removeAgentProfile(page, "Deep review");
        await expectNoAgentProfiles(page);
      });
    } finally {
      await seed.restore();
    }
  });
});
