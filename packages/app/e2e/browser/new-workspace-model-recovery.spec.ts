import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, expect, type Page } from "../support/fixtures";
import {
  closeModelPicker,
  drillIntoProvider,
  openModelPicker,
  seedModelProvider,
} from "../support/helpers/agent-profiles";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { gotoWorkspace } from "../support/helpers/launcher";
import { openGlobalNewWorkspaceComposer } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { expectRememberedModel, expectSavedSelection } from "../support/helpers/model-memory";

const PROVIDER = "remembered-model-recovery";
const MODEL = "remembered-model";
const LABEL = "Remembered model";

async function rememberModel(page: Page) {
  await page.addInitScript(
    ({ provider, model }) => {
      localStorage.setItem(
        "@paseo:create-agent-preferences",
        JSON.stringify({
          provider,
          providerPreferences: { [provider]: { model } },
        }),
      );
    },
    { provider: PROVIDER, model: MODEL },
  );
}

async function expectRecoveredModelInPicker(page: Page) {
  await openModelPicker(page);
  await page.getByRole("dialog").getByRole("button", { name: "Back", exact: true }).click();
  await drillIntoProvider(page, PROVIDER);
  await expect(
    page.getByTestId("combobox-desktop-container").getByText(LABEL, { exact: true }),
  ).toBeVisible();
  await closeModelPicker(page);
}

async function setProviderAvailability(client: DaemonClient, cwd: string, available: boolean) {
  await client.patchDaemonConfig({
    providers: {
      [PROVIDER]: {
        command: [available ? process.execPath : "/missing-paseo-diagnostic-provider"],
      },
    },
  });
  for (const scope of [undefined, cwd]) {
    await expect
      .poll(
        async () => {
          const snapshot = await client.getProvidersSnapshot(scope ? { cwd: scope } : undefined);
          return snapshot.entries.find((entry) => entry.provider === PROVIDER)?.status;
        },
        { timeout: 30_000 },
      )
      .toBe(available ? "ready" : "unavailable");
  }
}

test("restores the remembered model when a provider recovers after New workspace opens", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "model-recovery-" });
  const provider = await seedModelProvider({
    id: PROVIDER,
    label: "Remembered provider",
    models: [{ id: MODEL, label: LABEL, description: "Model restoration diagnostic" }],
    command: [process.execPath],
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "model-recovery" });
  try {
    await rememberModel(page);
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForSidebarHydration(page);
    await openGlobalNewWorkspaceComposer(page);
    await expectRememberedModel(page, LABEL);

    await gotoWorkspace(page, workspace.workspaceId);
    await waitForSidebarHydration(page);
    await setProviderAvailability(client, workspace.repoPath, false);
    await openGlobalNewWorkspaceComposer(page);
    await expect(
      page.getByTestId("combined-model-selector").filter({ visible: true }),
    ).not.toContainText("Loading...");

    await setProviderAvailability(client, workspace.repoPath, true);
    await expectSavedSelection(page, PROVIDER, MODEL);
    await expectRecoveredModelInPicker(page);
    await expectRememberedModel(page, LABEL);
  } finally {
    await client.close();
    await provider.restore();
    await workspace.cleanup();
  }
});
