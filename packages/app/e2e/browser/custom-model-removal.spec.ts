import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import {
  addCustomModel,
  expectCustomModelRetained,
  openCustomModels,
  removeCustomModel,
  removeListedCustomModel,
} from "../support/helpers/custom-models";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";
import {
  openProviderDetail,
  openSettingsHost,
  openSettingsHostSection,
} from "../support/helpers/settings";

const longModelId = "custom-model-with-a-long-name-".repeat(6);
const shortModelId = "custom-short";

for (const width of [1200, 390]) {
  test(`removes a long custom model at ${width}px without removing another model`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 1000 });
    await openCustomModels(page);
    await addCustomModel(page, shortModelId);
    await addCustomModel(page, longModelId);

    await test.step("remove the long model at the target width", async () => {
      await page.setViewportSize({ width, height: 1000 });
      await removeCustomModel(page, longModelId);
      await expectCustomModelRetained(page, shortModelId);
    });

    await removeCustomModel(page, shortModelId);
  });
}

/** An ACP provider whose command runs but exits before it answers, so the provider fails. */
const FAILING_PROVIDER = { id: "failing-acp", name: "Failing ACP" } as const;

interface ProviderConfigClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  patchDaemonConfig(config: {
    providers?: Record<string, { extends: string; label: string; command: string[] }>;
    removeProviders?: string[];
  }): Promise<unknown>;
}

test("adds and removes a custom model while the provider fails", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const discoveryGate = testInfo.outputPath("hold-provider-discovery");
  await mkdir(dirname(discoveryGate), { recursive: true });
  const client = await connectDaemonClient<ProviderConfigClient>({
    clientIdPrefix: "custom-model-failing-e2e",
  });
  try {
    await client.patchDaemonConfig({
      providers: {
        [FAILING_PROVIDER.id]: {
          extends: "acp",
          label: FAILING_PROVIDER.name,
          command: [
            "node",
            "-e",
            'const { existsSync } = require("node:fs");' +
              "const exitIfReleased = () => { if (!existsSync(process.argv[1])) process.exit(1); };" +
              "exitIfReleased(); setInterval(exitIfReleased, 25);",
            discoveryGate,
          ],
        },
      },
    });
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, getServerId());
    await openSettingsHostSection(page, getServerId(), "providers");
    await openProviderDetail(page, FAILING_PROVIDER.name);

    await test.step("the page leads with the failure and lists no reported models", async () => {
      await expect(page.getByTestId("provider-error")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Custom models", { exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Search models" })).toHaveCount(0);
    });

    await test.step("saving closes the Add sheet while provider discovery is still pending", async () => {
      await writeFile(discoveryGate, "");
      await addCustomModel(page, shortModelId);
    });
    await rm(discoveryGate);
    await expect(page.getByTestId("provider-error")).toBeVisible({ timeout: 30_000 });
    await removeListedCustomModel(page, shortModelId);
  } finally {
    await rm(discoveryGate, { force: true });
    await client
      .patchDaemonConfig({ removeProviders: [FAILING_PROVIDER.id] })
      .catch(() => undefined);
    await client.close().catch(() => undefined);
  }
});
