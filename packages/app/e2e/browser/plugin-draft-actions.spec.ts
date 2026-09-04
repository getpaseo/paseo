import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  expectComposerDraft,
  expectComposerVisible,
  fillComposerDraft,
} from "../support/helpers/composer";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  switchWorkspaceViaSidebar,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

const PLUGIN_ID = "plugin-draft-actions-e2e";

// "Polish" parks on a global gate the spec releases explicitly, so pending
// state and mid-flight interactions are deterministic instead of racing a
// fixed delay, and it leaves already-polished drafts untouched; "Shout"
// rewrites immediately so chained and racing flows stay quick; "Fail" and
// "Void" cover the error paths.
const PLUGIN_SOURCE = `export default function contribute(client) {
  client.addDraftAction({
    id: "polish",
    title: "Polish",
    icon: "Sparkles",
    async transform(text) {
      await new Promise((resolve) => {
        if (!globalThis.__draftActionGates) globalThis.__draftActionGates = [];
        globalThis.__draftActionGates.push(resolve);
      });
      if (text.startsWith("Please ")) return text;
      return "Please " + text.trim().toLowerCase() + ".";
    },
  });
  client.addDraftAction({
    id: "shout",
    title: "Shout",
    icon: "Megaphone",
    async transform(text) {
      return text.toUpperCase();
    },
  });
  client.addDraftAction({
    id: "fail",
    title: "Fail",
    icon: "X",
    async transform() {
      throw new Error("draft action exploded for e2e");
    },
  });
  client.addDraftAction({
    id: "void",
    title: "Void",
    icon: "X",
    async transform() {
      return undefined;
    },
  });
  return () => {};
}`;

async function openSeededWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoAppShell(page);
  await waitForWorkspaceInSidebar(page, { serverId: getServerId(), workspaceId });
  await switchWorkspaceViaSidebar({ page, serverId: getServerId(), workspaceId });
  await expectComposerVisible(page);
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

// Ends the oldest in-flight "Polish" transform at a moment the spec chooses.
// The plugin bundle runs via globalThis.eval in the page's main world, so the
// gate array it parks on is reachable here. Fails loudly when nothing is held
// so a broken gate reads as this step's failure, not a later assertion timeout.
async function releaseHeldTransform(page: Page): Promise<void> {
  const released = await page.evaluate(() => {
    const gates = (window as unknown as { __draftActionGates?: Array<() => void> })
      .__draftActionGates;
    const release = gates?.shift();
    release?.();
    return release !== undefined;
  });
  if (!released) {
    throw new Error("No held draft-action transform to release — the plugin never parked its gate");
  }
}

test("plugin draft actions rewrite the composer draft in place", async ({ page }, testInfo) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-draft-actions-e2e-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  const workspace = await seedWorkspace({ repoPrefix: "plugin-draft-action-", title: "Drafts" });
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: PLUGIN_ID }));
  await writeFile(path.join(directory, "index.client.tsx"), PLUGIN_SOURCE);

  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await openSeededWorkspace(page, workspace.workspaceId);

    await test.step("buttons ride along with the composer and gate on draft content", async () => {
      const polish = page.getByRole("button", { name: "Polish", exact: true });
      const shout = page.getByRole("button", { name: "Shout", exact: true });
      await expect(polish).toBeVisible();
      await expect(shout).toBeVisible();
      await expect(polish).toBeDisabled();
      await expect(shout).toBeDisabled();

      await fillComposerDraft(page, "fix the bug");
      await expect(polish).toBeEnabled();
      await expect(shout).toBeEnabled();
    });

    await test.step("a held transform shows pending state then replaces the draft", async () => {
      const polish = page.getByRole("button", { name: "Polish", exact: true });
      await polish.click();
      await expect(polish).toBeDisabled();
      // Held, not raced: the draft stays as typed until the spec releases it.
      await expectComposerDraft(page, "fix the bug");
      await releaseHeldTransform(page);
      await expectComposerDraft(page, "Please fix the bug.");
      await expect(polish).toBeEnabled();
      await capture(page, testInfo, "plugin-draft-action-replaced");
    });

    await test.step("an edit made while a transform is pending wins over its late result", async () => {
      const polish = page.getByRole("button", { name: "Polish", exact: true });
      await fillComposerDraft(page, "fix the bug");
      await polish.click();
      await fillComposerDraft(page, "urgent bug first");
      // Still disabled: the edit landed inside the transform window. Releasing
      // the transform must discard its late result, not overwrite the edit.
      await expect(polish).toBeDisabled();
      await expectComposerDraft(page, "urgent bug first");
      await releaseHeldTransform(page);
      await expect(polish).toBeEnabled();
      await expectComposerDraft(page, "urgent bug first");
    });

    await test.step("pressing a second action discards the first transform's late result", async () => {
      const polish = page.getByRole("button", { name: "Polish", exact: true });
      await fillComposerDraft(page, "fix the bug");
      await polish.click();
      await page.getByRole("button", { name: "Shout", exact: true }).click();
      // Shout ran on the pre-Polish draft, so no "Please" prefix or period.
      await expectComposerDraft(page, "FIX THE BUG");
      // The released Polish result must not clobber Shout's rewrite.
      await releaseHeldTransform(page);
      await expect(polish).toBeEnabled();
      await expectComposerDraft(page, "FIX THE BUG");
    });

    await test.step("a second action chains on the rewritten draft without sending", async () => {
      await fillComposerDraft(page, "fix the bug");
      await page.getByRole("button", { name: "Polish", exact: true }).click();
      await releaseHeldTransform(page);
      await expectComposerDraft(page, "Please fix the bug.");
      await page.getByRole("button", { name: "Shout", exact: true }).click();
      await expectComposerDraft(page, "PLEASE FIX THE BUG.");
      await expect(page.getByTestId("user-message")).toHaveCount(0);
    });

    await test.step("a no-op transform leaves the draft untouched", async () => {
      await fillComposerDraft(page, "Please leave me alone");
      await page.getByRole("button", { name: "Polish", exact: true }).click();
      await releaseHeldTransform(page);
      await expectComposerDraft(page, "Please leave me alone");
      await expect(page.getByTestId("user-message")).toHaveCount(0);
    });

    await test.step("failing and non-string transforms toast and leave the draft untouched", async () => {
      await fillComposerDraft(page, "keep me");
      await page.getByRole("button", { name: "Fail", exact: true }).click();
      await expect(page.getByText("draft action exploded for e2e")).toBeVisible();
      await expectComposerDraft(page, "keep me");
      await page.getByRole("button", { name: "Void", exact: true }).click();
      await expect(page.getByText("Draft action void returned a non-string result")).toBeVisible();
      await expectComposerDraft(page, "keep me");
    });
  } finally {
    await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await client
      .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await client.close().catch(() => undefined);
    await workspace.cleanup().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
