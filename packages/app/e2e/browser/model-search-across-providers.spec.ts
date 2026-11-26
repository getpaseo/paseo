import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, expect, type Page } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import {
  closeModelPicker,
  expectModelSearchEmptyState,
  expectModelPickerHeight,
  expectModelPickerWidth,
  expectModelSearchResult,
  expectPinnedProfilesHidden,
  openModelPicker,
  readModelPickerHeight,
  readModelPickerWidth,
  searchAllModels,
  seedAgentProfiles,
  seedModelProvider,
  expectSearchResultsVirtualized,
} from "../support/helpers/agent-profiles";
import { expectComposerVisible } from "../support/helpers/composer";
import { clickNewChat, clickNewTerminal, gotoWorkspace } from "../support/helpers/launcher";
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

const LARGE_CATALOG_SIZE = 200;
const LARGE_CATALOG = {
  id: "mock-bulk",
  label: "Mock Bulk",
  models: Array.from({ length: LARGE_CATALOG_SIZE }, (_, index) => ({
    id: `bulk-${index}`,
    label: `Bulk model ${index}`,
    description: `Bulk search result ${index}`,
  })),
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
      const restingWidth = await readModelPickerWidth(page);

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
        await expectModelPickerWidth(page, restingWidth);
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

  test("desktop search keeps its frame stable and virtualizes a host-wide catalog", async ({
    page,
  }) => {
    const provider = await seedModelProvider(LARGE_CATALOG);
    const profile = await seedAgentProfiles([ROOT_VIEW_PROFILE]);
    const workspace = await seedWorkspace({ repoPrefix: "model-search-large-catalog-" });

    try {
      await test.step("open the host-wide model picker", async () => {
        await gotoWorkspace(page, workspace.workspaceId);
        await clickNewChat(page);
        await expectComposerVisible(page);
        await openModelPicker(page);
      });

      const restingHeight = await readModelPickerHeight(page);
      const restingWidth = await readModelPickerWidth(page);

      await test.step("a broad query renders only the visible result window", async () => {
        await searchAllModels(page, "bulk model");
        await expectSearchResultsVirtualized(page, {
          provider: LARGE_CATALOG.id,
          total: LARGE_CATALOG_SIZE,
        });
        await expectModelPickerHeight(page, restingHeight);
        await expectModelPickerWidth(page, restingWidth);
      });

      await test.step("narrowing to one result does not resize the picker", async () => {
        await searchAllModels(page, "bulk model 199");
        await expectModelSearchResult(page, {
          provider: LARGE_CATALOG.id,
          modelId: "bulk-199",
          modelLabel: "Bulk model 199",
          providerLabel: LARGE_CATALOG.label,
        });
        await expectModelPickerHeight(page, restingHeight);
        await expectModelPickerWidth(page, restingWidth);
      });

      await test.step("ArrowUp wraps to the end of a virtualized catalog and Enter selects it", async () => {
        await searchAllModels(page, "bulk model");
        await page.keyboard.press("ArrowUp");
        // Tie-broken lexicographically by modelLabel, so "Bulk model 99" sits at the bottom.
        const lastRow = page
          .getByTestId("combobox-desktop-container")
          .getByTestId(`model-row-${LARGE_CATALOG.id}-bulk-99`);
        await expect(lastRow).toBeVisible();
        await expect(lastRow).toHaveAttribute("data-active", "true");
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("combobox-desktop-container")).toHaveCount(0);
        await expect(
          page.getByTestId("combined-model-selector").filter({ visible: true }).first(),
        ).toContainText("Bulk model 99");
      });
    } finally {
      await workspace.cleanup();
      await profile.restore();
      await provider.restore();
    }
  });

  test("arrow keys navigate profiles, providers, models, and search results in the composer", async ({
    page,
  }) => {
    const provider = await seedModelProvider(STUDIO);
    const profile = await seedAgentProfiles([
      {
        id: "agent_profile_e2e_arrows",
        name: "Arrow Profile",
        provider: STUDIO.id,
        modelId: "studio-fast",
      },
    ]);
    const workspace = await seedWorkspace({ repoPrefix: "model-picker-arrows-" });

    try {
      await test.step("open the composer model picker on the root view", async () => {
        await gotoWorkspace(page, workspace.workspaceId);
        await clickNewChat(page);
        await expectComposerVisible(page);
        await openModelPicker(page);
      });

      const viewport = page.getByTestId("combobox-desktop-container");
      const trigger = page.getByTestId("combined-model-selector").filter({ visible: true }).first();
      const profileRow = viewport.getByTestId("model-profile-row-agent_profile_e2e_arrows");
      const studioProviderRow = viewport.getByTestId(`model-provider-${STUDIO.id}`);

      await test.step("move from profiles to providers, drill in with ArrowRight, and go back with ArrowLeft", async () => {
        await expect(profileRow).toHaveAttribute("data-active", "true");
        // Root view keeps aria-selected absent while keyboard-active uses data-active.
        await expect(viewport.locator("[aria-selected]")).toHaveCount(0);

        // Step down until Mock Studio is active (provider order can vary across environments).
        for (let step = 0; step < 10; step += 1) {
          if ((await studioProviderRow.getAttribute("data-active")) === "true") break;
          await page.keyboard.press("ArrowDown");
        }
        await expect(studioProviderRow).toHaveAttribute("data-active", "true");

        await page.keyboard.press("ArrowRight");
        await expect(viewport.getByTestId(`model-row-${STUDIO.id}-studio-fast`)).toBeVisible();

        await page.keyboard.press("ArrowLeft");
        await expect(studioProviderRow).toHaveAttribute("data-active", "true");
      });

      await test.step("Enter drills into the active provider and ArrowDown + Enter selects a model", async () => {
        await page.keyboard.press("Enter");
        const deepRow = viewport.getByTestId(`model-row-${STUDIO.id}-studio-deep`);
        await expect(deepRow).toBeVisible();

        for (let step = 0; step < 5; step += 1) {
          if ((await deepRow.getAttribute("data-active")) === "true") break;
          await page.keyboard.press("ArrowDown");
        }
        await expect(deepRow).toHaveAttribute("data-active", "true");

        await page.keyboard.press("Enter");
        await expect(viewport).toHaveCount(0);
        await expect(trigger).toContainText("Studio deep think");
      });

      await test.step("typing filters results while arrow keys select across search matches", async () => {
        await openModelPicker(page);
        await searchAllModels(page, "ten second stream");
        const studioFast = viewport.getByTestId(`model-row-${STUDIO.id}-studio-fast`);
        const mockFast = viewport.getByTestId("model-row-mock-ten-second-stream");
        await expect(studioFast).toBeVisible();
        await expect(mockFast).toBeVisible();

        // Advance to the second match and confirm with Enter.
        const initialMockActive = (await mockFast.getAttribute("data-active")) === "true";
        await page.keyboard.press("ArrowDown");
        const targetRow = initialMockActive ? studioFast : mockFast;
        await expect(targetRow).toHaveAttribute("data-active", "true");
        await page.keyboard.press("Enter");
        await expect(viewport).toHaveCount(0);
        await expect(trigger).toContainText("Ten second stream");
      });

      await test.step("Enter on the active profile row applies it", async () => {
        await openModelPicker(page);
        await expect(profileRow).toHaveAttribute("data-active", "true");
        await page.keyboard.press("Enter");
        await expect(viewport).toHaveCount(0);
        await expect(trigger).toContainText("Ten second stream");
      });

      await test.step("folded compact sheet also supports Enter on the active profile row", async () => {
        await page.setViewportSize({ width: 390, height: 800 });
        await page.getByTestId("combined-model-selector").filter({ visible: true }).first().click();
        const sheetProfileRow = page.getByTestId("model-profile-row-agent_profile_e2e_arrows");
        await expect(sheetProfileRow).toBeVisible();
        await expect(sheetProfileRow).toHaveAttribute("data-active", "true");
        await page.keyboard.press("Enter");
        await expect(sheetProfileRow).toHaveCount(0);
      });
    } finally {
      await workspace.cleanup();
      await profile.restore();
      await provider.restore();
    }
  });
});

async function setRuntimeCatalog(client: DaemonClient, count: number, cwd: string) {
  await client.patchDaemonConfig({
    providers: {
      gemini: {
        extends: "acp",
        label: "Catalog provider",
        enabled: true,
        command: [
          process.execPath,
          path.resolve(__dirname, "../support/fixtures/catalog-acp.cjs"),
          String(count),
        ],
      },
    },
  });
  await expect
    .poll(
      async () =>
        (await client.getProvidersSnapshot({ cwd })).entries.find(
          (entry) => entry.provider === "gemini",
        )?.status,
      { timeout: 30_000 },
    )
    .toBe("ready");
}
async function reloadSavedDraft(page: Page) {
  await page.evaluate(() =>
    localStorage.setItem(
      "@paseo:e2e-disable-default-seed-once",
      localStorage.getItem("@paseo:e2e-seed-nonce")!,
    ),
  );
  await page.reload();
  await expectComposerVisible(page);
}
async function expectOneCatalogChoice(page: Page, label: string) {
  await openModelPicker(page);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await searchAllModels(page, label);
  await expect(page.getByTestId("model-row-gemini-gemini-3.5-flash")).toHaveCount(1);
  await closeModelPicker(page);
}

async function configureModelOverride(client: DaemonClient, cwd: string) {
  await client.patchDaemonConfig({
    providers: {
      gemini: {
        additionalModels: [{ id: "gemini-3.5-flash", label: "Configured model", isDefault: true }],
      },
    },
  });
  await expect
    .poll(
      async () =>
        (await client.getProvidersSnapshot({ cwd: cwd })).entries.find(
          (entry) => entry.provider === "gemini",
        )?.models,
      { timeout: 30_000 },
    )
    .toMatchObject([{ id: "gemini-3.5-flash", label: "Configured model", isDefault: true }]);
}

const catalogTest = test.extend<{ catalogClient: DaemonClient }>({
  catalogClient: async ({ e2eWorker }, provide) => {
    void e2eWorker;
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "catalog-models" });
    try {
      await provide(client);
    } finally {
      try {
        await client.patchDaemonConfig({ removeProviders: ["gemini"] });
      } finally {
        await client.close();
      }
    }
  },
});

catalogTest(
  "New Agent and saved drafts stay usable with repeated runtime model rows",
  async ({ page, withWorkspace, catalogClient: client }, testInfo) => {
    const workspace = await withWorkspace({ prefix: "catalog-models-" });
    await test.step("open a draft with a one-row runtime catalog", async () => {
      await setRuntimeCatalog(client, 1, workspace.repoPath);
      await gotoWorkspace(page, workspace.workspaceId);
      await clickNewChat(page);
      await expectComposerVisible(page);
    });
    await test.step("open New Agent after the provider publishes repeated model rows", async () => {
      await clickNewTerminal(page);
      await setRuntimeCatalog(client, 2, workspace.repoPath);
      await clickNewChat(page);
      await expectComposerVisible(page);
      await expectOneCatalogChoice(page, "Gemini 3.5 Flash");
      await page.screenshot({ path: testInfo.outputPath("duplicate-catalog-draft.png") });
    });
    await test.step("reopen the saved draft with the same catalog", async () => {
      await reloadSavedDraft(page);
      await expectOneCatalogChoice(page, "Gemini 3.5 Flash");
    });
    await test.step("retain configured model overrides when runtime IDs repeat", async () => {
      await configureModelOverride(client, workspace.repoPath);
      await reloadSavedDraft(page);
      await expectOneCatalogChoice(page, "Configured model");
    });
  },
);
