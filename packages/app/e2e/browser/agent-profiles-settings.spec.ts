import { expect, test } from "../support/fixtures";
import {
  browserBackWithConfirm,
  browserHistoryJumpWithConfirm,
  createAgentProfile,
  createAgentProfileFromEmptyState,
  duplicateOpenAgentProfileWithConfirm,
  editAgentProfile,
  expectAgentProfile,
  expectAgentProfileForm,
  expectAgentProfileNameDraft,
  expectAgentProfileNotesDraft,
  expectAgentProfileOrder,
  expectAgentProfileTagsGone,
  expectHostAgentProfiles,
  expectNoAgentProfiles,
  fillAgentProfileName,
  fillAgentProfileNotes,
  moveAgentProfileUp,
  openAgentProfileEditor,
  openAgentProfileSettings,
  openCompactAgentProfileSettings,
  openCreateAgentProfileEditor,
  removeAgentProfile,
  saveOpenAgentProfile,
  seedAgentProfiles,
  stageLegacyFavoritesForHostMigration,
  switchSettingsSectionWithConfirm,
  toggleAgentProfileCustomize,
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

  test("remounting the profile form keeps draft text across resize and collapsible toggles", async ({
    page,
  }) => {
    const seed = await seedAgentProfiles([
      {
        id: "agent_profile_e2e_remount",
        name: "Original profile",
        provider: "mock",
        model: "one-minute-stream",
        notes: "Original note",
      },
    ]);

    try {
      await page.setViewportSize({ width: 1680, height: 900 });
      await openAgentProfileSettings(page);

      await test.step("drawer-to-modal and compact resizes keep the edited name and save it", async () => {
        await openAgentProfileEditor(page, "Original profile");
        await expect(page.getByTestId("agent-profile-drawer")).toBeVisible();
        await fillAgentProfileName(page, "Draft rename");

        await page.setViewportSize({ width: 1000, height: 900 });
        await expect(page.getByTestId("agent-profile-edit-modal")).toBeVisible({ timeout: 30_000 });
        await expectAgentProfileNameDraft(page, "Draft rename");

        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByTestId("agent-profile-edit-modal")).toBeVisible({ timeout: 30_000 });
        await expectAgentProfileNameDraft(page, "Draft rename");

        await saveOpenAgentProfile(page);
        await expectAgentProfile(page, {
          name: "Draft rename",
          tags: [MOCK_PROVIDER_LABEL, "One minute stream"],
          notes: "Original note",
        });
      });

      await test.step("collapsing and reopening advanced settings keeps the draft note", async () => {
        await page.setViewportSize({ width: 1000, height: 900 });
        await openCreateAgentProfileEditor(page);
        await expect(page.getByTestId("agent-profile-edit-modal")).toBeVisible({ timeout: 30_000 });
        await toggleAgentProfileCustomize(page);
        await fillAgentProfileNotes(page, "Draft routing note");
        await toggleAgentProfileCustomize(page);
        await toggleAgentProfileCustomize(page);
        await expectAgentProfileNotesDraft(page, "Draft routing note");
      });
    } finally {
      await seed.restore();
    }
  });

  test("duplicating while editing asks before discarding unsaved changes", async ({ page }) => {
    const seed = await seedAgentProfiles([
      {
        id: "agent_profile_e2e_duplicate",
        name: "UI work",
        provider: "mock",
        model: "one-minute-stream",
      },
    ]);

    try {
      await page.setViewportSize({ width: 1680, height: 900 });
      await openAgentProfileSettings(page);
      await openAgentProfileEditor(page, "UI work");
      await expect(page.getByTestId("agent-profile-drawer")).toBeVisible();
      await fillAgentProfileName(page, "Draft name");

      await test.step("dismissing the prompt keeps the draft and does not create a copy", async () => {
        await duplicateOpenAgentProfileWithConfirm(page, "dismiss");
        await expectAgentProfileNameDraft(page, "Draft name");
        await expectAgentProfileOrder(page, ["UI work"]);
      });

      await test.step("accepting the prompt creates and opens the copy", async () => {
        await duplicateOpenAgentProfileWithConfirm(page, "accept");
        await expectAgentProfileOrder(page, ["UI work", "UI work (copy)"]);
        await expectAgentProfileNameDraft(page, "UI work (copy)");
      });
    } finally {
      await seed.restore();
    }
  });

  test("docked drawer allows roster search and section switches ask before discarding a draft", async ({
    page,
  }) => {
    const seed = await seedAgentProfiles([
      {
        id: "agent_profile_e2e_docked_1",
        name: "UI work",
        provider: "mock",
        model: "one-minute-stream",
      },
      {
        id: "agent_profile_e2e_docked_2",
        name: "Deep review",
        provider: "mock",
        model: "five-minute-stream",
      },
    ]);

    try {
      await page.setViewportSize({ width: 1680, height: 900 });
      await openAgentProfileSettings(page);
      await openAgentProfileEditor(page, "UI work");
      await expect(page.getByTestId("agent-profile-drawer")).toBeVisible();

      await test.step("typing in roster search works while the docked drawer is open", async () => {
        const searchInput = page.getByTestId("agent-profiles-search-input");
        await searchInput.click();
        await page.keyboard.type("Deep");
        await expect(searchInput).toHaveValue("Deep");
        await expect(page.getByTestId("agent-profile-drawer")).toBeVisible();
        await expectAgentProfileOrder(page, ["Deep review"]);
        await page.getByTestId("agent-profiles-search-clear").click();
      });

      await test.step("browser Back asks before discarding a draft and canceling keeps route and draft", async () => {
        await fillAgentProfileName(page, "Unsaved browser back edit");
        const profilesUrl = page.url();

        await browserBackWithConfirm(page, "dismiss");
        await expect(page).toHaveURL(profilesUrl, { timeout: 15_000 });
        await expect(page.getByTestId("agent-profile-drawer")).toBeVisible();
        await expectAgentProfileNameDraft(page, "Unsaved browser back edit");
      });

      await test.step("switching Settings sections asks before discarding an edited draft", async () => {
        await fillAgentProfileName(page, "Unsaved sidebar edit");

        await switchSettingsSectionWithConfirm(page, "Agents", "dismiss");
        await expect(page.getByTestId("agent-profile-drawer")).toBeVisible();
        await expectAgentProfileNameDraft(page, "Unsaved sidebar edit");

        await switchSettingsSectionWithConfirm(page, "Agents", "accept");
        await expect(page.getByTestId("agent-profile-drawer")).toHaveCount(0, { timeout: 30_000 });
        await expect(page.getByTestId("settings-detail-header-title")).toHaveText("Agents");
      });

      await test.step("confirming browser Back leaves Agent profiles and discards the draft", async () => {
        await page.getByRole("button", { name: "Agent profiles", exact: true }).click();
        await expect(page.getByTestId("agent-profiles-card")).toBeVisible({ timeout: 30_000 });
        await openAgentProfileEditor(page, "UI work");
        await fillAgentProfileName(page, "Discard on browser back");
        const profilesUrl = page.url();

        await browserBackWithConfirm(page, "accept");
        await expect(page).not.toHaveURL(profilesUrl, { timeout: 15_000 });
        await expect(page.getByTestId("agent-profile-drawer")).toHaveCount(0, { timeout: 30_000 });
      });
    } finally {
      await seed.restore();
    }
  });

  test("canceling a multi-step Back jump keeps intervening browser history and confirming reaches the destination", async ({
    page,
  }) => {
    const seed = await seedAgentProfiles([
      {
        id: "agent_profile_e2e_multistep",
        name: "UI work",
        provider: "mock",
        model: "one-minute-stream",
      },
    ]);

    try {
      // Narrow viewport pushes Open project -> Settings -> Agent profiles onto history.
      await page.setViewportSize({ width: 390, height: 844 });
      await openCompactAgentProfileSettings(page);
      const profilesUrl = page.url();

      await openAgentProfileEditor(page, "UI work");
      await fillAgentProfileName(page, "Unsaved multi-step edit");

      await test.step("canceling a two-step Back jump keeps Agent profiles, draft, and Settings in history", async () => {
        await browserHistoryJumpWithConfirm(page, -2, "dismiss");
        await expect(page).toHaveURL(profilesUrl, { timeout: 15_000 });
        await expect(page.getByTestId("agent-profile-edit-modal")).toBeVisible();
        await expectAgentProfileNameDraft(page, "Unsaved multi-step edit");
      });

      await test.step("canceling a two-step Back jump after reload still restores the Agent profiles URL", async () => {
        await page.reload();
        await expect(page.getByTestId("agent-profiles-card")).toBeVisible({ timeout: 30_000 });
        await openAgentProfileEditor(page, "UI work");
        await fillAgentProfileName(page, "Post-reload draft");

        await browserHistoryJumpWithConfirm(page, -2, "dismiss");
        await expect(page).toHaveURL(profilesUrl, { timeout: 15_000 });
        await expect(page.getByTestId("agent-profile-edit-modal")).toBeVisible();
        await expectAgentProfileNameDraft(page, "Post-reload draft");
      });

      await test.step("confirming a two-step Back jump lands directly on the selected destination", async () => {
        await browserHistoryJumpWithConfirm(page, -2, "accept");
        await expect(page).toHaveURL(/\/open-project/, { timeout: 15_000 });
        await expect(page.getByTestId("agent-profile-edit-modal")).toHaveCount(0, {
          timeout: 30_000,
        });
      });

      await test.step("forward navigation confirms the intervening Settings entry survived", async () => {
        await page.goForward();
        await expect(page).toHaveURL(/\/settings(?:\?|$)/, { timeout: 15_000 });
      });
    } finally {
      await seed.restore();
    }
  });

  test("canceling an untouched provider-and-model-only profile closes without a discard prompt", async ({
    page,
  }) => {
    const seed = await seedAgentProfiles([
      {
        id: "legacy_favorite:mock:one-minute-stream",
        name: "One minute stream",
        provider: "mock",
        model: "one-minute-stream",
      },
    ]);

    let dialogTriggered = false;
    const onDialog = async (dialog: { dismiss: () => Promise<void> }) => {
      dialogTriggered = true;
      await dialog.dismiss();
    };
    page.on("dialog", onDialog);

    try {
      await page.setViewportSize({ width: 1680, height: 900 });
      await openAgentProfileSettings(page);
      await openAgentProfileEditor(page, "One minute stream");
      await expect(page.getByTestId("agent-profile-drawer")).toBeVisible();
      await page.getByTestId("agent-profile-cancel-button").click();
      await expect(page.getByTestId("agent-profile-drawer")).toHaveCount(0, { timeout: 30_000 });
      expect(dialogTriggered).toBe(false);
    } finally {
      page.off("dialog", onDialog);
      await seed.restore();
    }
  });
});
