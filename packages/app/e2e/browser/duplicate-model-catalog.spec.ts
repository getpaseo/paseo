import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, expect, type Page } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { seedWorkspace } from "../support/helpers/seed-client";
import { clickNewChat, clickNewTerminal, gotoWorkspace } from "../support/helpers/launcher";
import { expectComposerVisible } from "../support/helpers/composer";
import {
  openModelPicker,
  closeModelPicker,
  searchAllModels,
} from "../support/helpers/agent-profiles";

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

test("New Agent and saved drafts stay usable with repeated runtime model rows", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "catalog-models-" });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "catalog-models" });
  try {
    await test.step("open a draft with a one-row runtime catalog", async () => {
      await setRuntimeCatalog(client, 1, workspace.repoPath);
      await gotoWorkspace(page, workspace.workspaceId);
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
  } finally {
    await client.patchDaemonConfig({ removeProviders: ["gemini"] });
    await client.close();
    await workspace.cleanup();
  }
});
