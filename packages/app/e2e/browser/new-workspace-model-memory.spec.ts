import { mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, expect } from "../support/fixtures";
import { seedModelProvider } from "../support/helpers/agent-profiles";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  openGlobalNewWorkspaceComposer,
  submitNewWorkspaceEmpty,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

import {
  chooseModel,
  reselectModel,
  startWithoutRememberedModel,
  expectSavedSelection,
  expectCreatedModelAgents,
  expectRememberedModel,
} from "../support/helpers/model-memory";

const PROVIDER = "model-memory-diagnostic";
const MODEL = "pi-profile-model";
const LABEL = "Pi profile model";

async function expectProviderStatus(client: DaemonClient, cwd: string | undefined, status: string) {
  await expect
    .poll(
      async () =>
        (await client.getProvidersSnapshot(cwd ? { cwd } : undefined)).entries.find(
          (entry) => entry.provider === PROVIDER,
        )?.status,
      { timeout: 30_000 },
    )
    .toBe(status);
}

async function prepareCatalogState(
  client: DaemonClient,
  executable: string,
  cwd: string,
  hostStatus: "ready" | "unavailable",
) {
  await expectProviderStatus(client, undefined, "ready");
  await expectProviderStatus(client, cwd, "ready");
  await rename(executable, `${executable}.parked`);
  await client.refreshProvidersSnapshot({ providers: [PROVIDER] });
  await expectProviderStatus(client, undefined, "unavailable");
  await rename(`${executable}.parked`, executable);
  if (hostStatus === "ready") await client.refreshProvidersSnapshot({ providers: [PROVIDER] });
  await client.refreshProvidersSnapshot({ cwd, providers: [PROVIDER] });
  await expectProviderStatus(client, cwd, "ready");
  await expectProviderStatus(client, undefined, hostStatus);
}

for (const hostStatus of ["ready", "unavailable"] as const) {
  test(`remembers the manually selected model after two creations with a ${hostStatus} host catalog and ready project catalog`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const workspace = await seedWorkspace({ repoPrefix: "model-memory-scope-" });
    const binDir = await mkdtemp(path.join(tmpdir(), "paseo-model-memory-bin-"));
    const executable = path.join(binDir, "provider-node");
    await symlink(process.execPath, executable);
    const provider = await seedModelProvider({
      id: PROVIDER,
      label: "Model memory diagnostic",
      extends: "pi",
      command: [executable, path.resolve("e2e/fixtures/fake-pi-rpc.mjs")],
      models: [{ id: MODEL, label: LABEL, description: "Remembered selection diagnostic" }],
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "model-memory" });
    try {
      await prepareCatalogState(client, executable, workspace.repoPath, hostStatus);

      await startWithoutRememberedModel(page);
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);
      for (const [index, select] of [chooseModel, reselectModel].entries()) {
        const count = index + 1;
        await test.step(`create workspace ${count} and return`, async () => {
          await select(page, PROVIDER, LABEL);
          await expectSavedSelection(page, PROVIDER, MODEL);
          await submitNewWorkspacePrompt(page, "Remember this model on the next workspace");
          await expect(page).toHaveURL(/\/workspace\//);
          await expectCreatedModelAgents(page, client, PROVIDER, MODEL, count);
          await openGlobalNewWorkspaceComposer(page);
          await expectSavedSelection(page, PROVIDER, MODEL);
          await expectRememberedModel(page, LABEL);
        });
      }
      await submitNewWorkspaceEmpty(page);
      await expect(page).toHaveURL(/\/workspace\//);
      await openGlobalNewWorkspaceComposer(page);
      await expectSavedSelection(page, PROVIDER, MODEL);
      await expectRememberedModel(page, LABEL);
    } finally {
      await client.close();
      await provider.restore();
      await workspace.cleanup();
      await rm(binDir, { recursive: true, force: true });
    }
  });
}
