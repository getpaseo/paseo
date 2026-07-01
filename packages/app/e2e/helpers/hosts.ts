import { expect, type Page } from "@playwright/test";
import { buildSeededHost } from "./daemon-registry";

const REGISTRY_KEY = "@paseo:daemon-registry";
const SEED_NONCE_KEY = "@paseo:e2e-seed-nonce";
const DISABLE_DEFAULT_SEED_ONCE_KEY = "@paseo:e2e-disable-default-seed-once";

// The multi-host UI (the command-center host label, the sidebar host filter) only renders once
// more than one host exists. The e2e harness runs a single real daemon, so we add an extra registry
// entry pointing at an unreachable endpoint: it stays offline, which is enough to make the UI treat
// the view as multi-host without standing up a second daemon.
//
// Must run AFTER the first navigation: the auto-seed fixture writes the registry + nonce on load,
// and reseeds on every navigation. We write the full registry here and set the fixture's
// disable-once flag, then reload — so the fixture skips its reset and the registry survives. This
// avoids depending on the (unspecified) ordering of multiple Playwright init scripts. Optionally
// relabels the seeded primary host so assertions can target a distinctive name.
export async function addOfflineHostAndReload(
  page: Page,
  input: { serverId: string; label: string; primaryLabel?: string },
): Promise<void> {
  const offlineHost = buildSeededHost({
    serverId: input.serverId,
    label: input.label,
    endpoint: "127.0.0.1:59999",
    nowIso: new Date().toISOString(),
  });

  await page.evaluate(
    ({ host, keys, primaryLabel }) => {
      const nonce = localStorage.getItem(keys.nonce);
      if (!nonce) {
        throw new Error("Expected the e2e seed nonce before overriding the host registry.");
      }
      const raw = localStorage.getItem(keys.registry);
      const registry: Array<{ serverId: string; label?: string }> = raw ? JSON.parse(raw) : [];
      if (primaryLabel && registry[0]) {
        registry[0].label = primaryLabel;
      }
      if (!registry.some((entry) => entry.serverId === host.serverId)) {
        registry.push(host);
      }
      localStorage.setItem(keys.registry, JSON.stringify(registry));
      localStorage.setItem(keys.disableSeedOnce, nonce);
    },
    {
      host: offlineHost,
      keys: {
        registry: REGISTRY_KEY,
        nonce: SEED_NONCE_KEY,
        disableSeedOnce: DISABLE_DEFAULT_SEED_ONCE_KEY,
      },
      primaryLabel: input.primaryLabel,
    },
  );

  await page.reload();
}

export async function openSidebarDisplayPreferences(page: Page): Promise<void> {
  await page.getByTestId("sidebar-display-preferences-menu").click();
  await expect(page.getByTestId("sidebar-display-preferences-content")).toBeVisible({
    timeout: 10_000,
  });
}

// A host's filter row carries a status dot on the left next to its label.
export async function expectHostFilterRow(page: Page, serverId: string): Promise<void> {
  await expect(page.getByTestId(`sidebar-host-filter-${serverId}`)).toBeVisible();
  await expect(page.getByTestId(`sidebar-host-filter-status-${serverId}`)).toBeVisible();
}

export async function toggleHostFilter(page: Page, serverId: string): Promise<void> {
  await page.getByTestId(`sidebar-host-filter-${serverId}`).click();
}

export async function selectAllHostsFilter(page: Page): Promise<void> {
  await page.getByTestId("sidebar-host-filter-all").click();
}
