import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, expect } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  chooseModel,
  reselectModel,
  startWithoutRememberedModel,
  expectCreatedModelAgents,
  expectRememberedModel,
  expectSavedSelection,
} from "../support/helpers/model-memory";
import {
  openGlobalNewWorkspaceComposer,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test("remembers real Codex GPT-6 Astra after repeated successful workspace creation", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({ repoPrefix: "codex-astra-memory-" });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "codex-astra-memory" });
  try {
    await expect
      .poll(
        async () =>
          (await client.getProvidersSnapshot({ cwd: workspace.repoPath })).entries.find(
            (entry) => entry.provider === "codex",
          )?.status,
        { timeout: 60_000 },
      )
      .toBe("ready");
    const snapshot = await client.getProvidersSnapshot({ cwd: workspace.repoPath });
    const codex = snapshot.entries.find((entry) => entry.provider === "codex");
    expect(codex?.status).toBe("ready");
    const astra = codex?.models?.find((model) => model.id === "gpt-6-astra");
    expect(astra?.id).toBe("gpt-6-astra");
    const label = astra!.label;
    await startWithoutRememberedModel(page);
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForSidebarHydration(page);
    await openGlobalNewWorkspaceComposer(page);
    for (const [index, select] of [chooseModel, reselectModel].entries()) {
      const count = index + 1;
      await test.step(`create workspace ${count} and return`, async () => {
        await select(page, "codex", label);
        await expectSavedSelection(page, "codex", "gpt-6-astra");
        await submitNewWorkspacePrompt(page, "Reply with OK. Do not use tools or change files.");
        await expect(page).toHaveURL(/\/workspace\//);
        await expectCreatedModelAgents(page, client, "codex", "gpt-6-astra", count);
        await expect(
          page.getByTestId("assistant-message").filter({ hasText: "OK", visible: true }),
        ).toBeVisible({
          timeout: 60_000,
        });
        await openGlobalNewWorkspaceComposer(page);
        await expectSavedSelection(page, "codex", "gpt-6-astra");
        await expectRememberedModel(page, label);
      });
    }
    await page.screenshot({ path: test.info().outputPath("astra-remembered.png") });
  } finally {
    await client.close();
    await workspace.cleanup();
  }
});
