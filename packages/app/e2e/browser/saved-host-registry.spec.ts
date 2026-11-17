import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { renameHostFromSettings } from "../support/helpers/hosts";
import { getServerId } from "../support/helpers/server-id";
import { openHostSection, selectSettingsHost } from "../support/helpers/settings";

const REGISTRY_KEY = "@paseo:daemon-registry";
const SEED_NONCE_KEY = "@paseo:e2e-seed-nonce";
const DISABLE_DEFAULT_SEED_ONCE_KEY = "@paseo:e2e-disable-default-seed-once";

// What a build with a connection kind this one doesn't know leaves in the registry: an extra
// connection on a host this build can reach, and a host reached only through it.
const UNKNOWN_CONNECTION = { id: "future:garage", type: "futureKind", address: "garage" };
const UNKNOWN_HOST = {
  serverId: "srv_e2e_unknown_connection_host",
  label: "Unknown connection host",
  connections: [{ id: "future:roof", type: "futureKind", address: "roof" }],
  preferredConnectionId: "future:roof",
};
const OFFLINE_HOST = {
  serverId: "srv_e2e_saved_offline_host",
  label: "Saved offline host",
  password: "e2e-fake-password",
  connections: [{ id: "direct:127.0.0.1:59999", type: "directTcp", endpoint: "127.0.0.1:59999" }],
  preferredConnectionId: "direct:127.0.0.1:59999",
};

interface StoredHost {
  serverId: string;
  label?: string;
  password?: string;
  connections: unknown[];
}

async function addUnreadableEntriesAndReload(page: Page): Promise<void> {
  await page.evaluate(
    ({ keys, primaryServerId, unknownConnection, offlineHost, unknownHost }) => {
      const nonce = localStorage.getItem(keys.nonce);
      if (!nonce) {
        throw new Error("Expected the e2e seed nonce before overriding the host registry.");
      }
      const registry: StoredHost[] = JSON.parse(localStorage.getItem(keys.registry) ?? "[]");
      registry
        .find((host) => host.serverId === primaryServerId)
        ?.connections.push(unknownConnection);
      registry.push(offlineHost, unknownHost);
      localStorage.setItem(keys.registry, JSON.stringify(registry));
      localStorage.setItem(keys.disableSeedOnce, nonce);
    },
    {
      keys: {
        registry: REGISTRY_KEY,
        nonce: SEED_NONCE_KEY,
        disableSeedOnce: DISABLE_DEFAULT_SEED_ONCE_KEY,
      },
      primaryServerId: getServerId(),
      unknownConnection: UNKNOWN_CONNECTION,
      offlineHost: OFFLINE_HOST,
      unknownHost: UNKNOWN_HOST,
    },
  );
  await page.reload();
}

async function readStoredRegistry(page: Page): Promise<StoredHost[] | null> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), REGISTRY_KEY);
}

async function readStoredHost(page: Page, serverId: string): Promise<StoredHost | undefined> {
  return (await readStoredRegistry(page))?.find((host) => host.serverId === serverId);
}

test("saved hosts survive a registry entry this build can't read, and saving keeps it", async ({
  page,
}) => {
  await gotoAppShell(page);
  await addUnreadableEntriesAndReload(page);

  await test.step("both readable hosts are listed", async () => {
    await page.getByTestId("sidebar-hosts-trigger").click();
    await expect(page.getByTestId(`sidebar-host-row-${getServerId()}`)).toBeVisible();
    await expect(page.getByTestId(`sidebar-host-row-${OFFLINE_HOST.serverId}`)).toBeVisible();
    await expect(page.getByTestId(`sidebar-host-row-${UNKNOWN_HOST.serverId}`)).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  await test.step("renaming a host keeps its password and the entries it can't read", async () => {
    await openSettings(page);
    await selectSettingsHost(page, OFFLINE_HOST.serverId);
    await openHostSection(page, OFFLINE_HOST.serverId, "host");
    await renameHostFromSettings(page, "Renamed offline host");

    await expect
      .poll(() => readStoredHost(page, OFFLINE_HOST.serverId))
      .toMatchObject({ label: "Renamed offline host", password: OFFLINE_HOST.password });
    const stored = await readStoredRegistry(page);
    expect(stored?.map((host) => host.serverId)).toEqual([
      getServerId(),
      OFFLINE_HOST.serverId,
      UNKNOWN_HOST.serverId,
    ]);
    expect(stored?.[0]?.connections).toContainEqual(UNKNOWN_CONNECTION);
    expect(stored?.[2]).toEqual(UNKNOWN_HOST);
  });
});
