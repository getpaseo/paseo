import { expect, test } from "../support/fixtures";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";

// Only an explicit pick is remembered, and a remembered host is used only while
// it is still registered and online.

const CONNECTED_LABEL = "Connected host";
const OFFLINE_SERVER_ID = "srv_e2e_remembered_offline";
const OFFLINE_LABEL = "Offline host";

const PREFERENCES_KEY = "@paseo:create-agent-preferences";
const SEED_NONCE_KEY = "@paseo:e2e-seed-nonce";
const DISABLE_DEFAULT_SEED_ONCE_KEY = "@paseo:e2e-disable-default-seed-once";

async function seedBothHosts(page: import("@playwright/test").Page): Promise<void> {
  await seedSavedSettingsHosts(page, [
    {
      serverId: getServerId(),
      label: CONNECTED_LABEL,
      endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
    },
    { serverId: OFFLINE_SERVER_ID, label: OFFLINE_LABEL, endpoint: "127.0.0.1:59999" },
  ]);
}

async function readRememberedServerId(
  page: import("@playwright/test").Page,
): Promise<string | undefined> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw).serverId as string | undefined) : undefined;
  }, PREFERENCES_KEY);
}

// Overwrite the seeded preferences and keep the fixture from reseeding on the
// next navigation, so the composer opens against exactly this stored host.
async function rememberHost(
  page: import("@playwright/test").Page,
  serverId: string,
): Promise<void> {
  await page.evaluate(
    ({ key, keys, rememberedServerId }) => {
      const nonce = localStorage.getItem(keys.seedNonce);
      if (!nonce) {
        throw new Error("Expected the e2e seed nonce before overriding create-agent preferences.");
      }
      const raw = localStorage.getItem(key);
      const preferences = raw ? JSON.parse(raw) : {};
      preferences.serverId = rememberedServerId;
      localStorage.setItem(key, JSON.stringify(preferences));
      localStorage.setItem(keys.disableDefaultSeedOnce, nonce);
    },
    {
      key: PREFERENCES_KEY,
      keys: {
        seedNonce: SEED_NONCE_KEY,
        disableDefaultSeedOnce: DISABLE_DEFAULT_SEED_ONCE_KEY,
      },
      rememberedServerId: serverId,
    },
  );
}

test.describe("New workspace remembers the host you picked", () => {
  test.describe.configure({ timeout: 240_000 });

  let workspace: SeededWorkspace;

  test.beforeEach(async () => {
    workspace = await seedWorkspace({ repoPrefix: "remembered-host-" });
  });

  test.afterEach(async () => {
    await workspace?.cleanup();
  });

  test("stores the host when you pick one by hand", async ({ page }) => {
    await seedBothHosts(page);
    await page.goto(buildNewWorkspaceRoute());

    const trigger = page.getByTestId("host-picker-trigger");
    await expect(trigger).toBeVisible({ timeout: 60_000 });
    await expect(trigger).toContainText(CONNECTED_LABEL);
    expect(await readRememberedServerId(page)).toBeUndefined();

    await trigger.click();
    await page.getByTestId(`new-workspace-host-picker-option-${OFFLINE_SERVER_ID}`).click();

    await expect(trigger).toContainText(OFFLINE_LABEL);
    await expect.poll(() => readRememberedServerId(page)).toBe(OFFLINE_SERVER_ID);
  });

  test("ignores a remembered host that is offline", async ({ page }) => {
    await seedBothHosts(page);
    await rememberHost(page, OFFLINE_SERVER_ID);
    await page.goto(buildNewWorkspaceRoute());

    const trigger = page.getByTestId("host-picker-trigger");
    await expect(trigger).toBeVisible({ timeout: 60_000 });
    await expect(trigger).toContainText(CONNECTED_LABEL);
  });

  test("ignores a remembered host that is no longer registered", async ({ page }) => {
    await seedBothHosts(page);
    await rememberHost(page, "srv_e2e_removed_host");
    await page.goto(buildNewWorkspaceRoute());

    const trigger = page.getByTestId("host-picker-trigger");
    await expect(trigger).toBeVisible({ timeout: 60_000 });
    await expect(trigger).toContainText(CONNECTED_LABEL);
  });
});
