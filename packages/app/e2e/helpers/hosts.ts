import type { Page } from "@playwright/test";
import { buildSeededHost } from "./daemon-registry";

const REGISTRY_KEY = "@paseo:daemon-registry";

// The multi-host UI (the command-center host label, the sidebar host filter) only renders once
// more than one host exists. The e2e harness runs a single real daemon, so we append an extra
// registry entry pointing at an unreachable endpoint: it stays offline, which is enough to make
// the UI treat the view as multi-host without standing up a second daemon. Optionally relabels the
// seeded primary host so assertions can target a distinctive name.
export async function appendOfflineHost(
  page: Page,
  input: { serverId: string; label: string; primaryLabel?: string },
): Promise<void> {
  const offlineHost = buildSeededHost({
    serverId: input.serverId,
    label: input.label,
    endpoint: "127.0.0.1:59999",
    nowIso: new Date().toISOString(),
  });

  await page.addInitScript(
    ({ host, registryKey, primaryLabel }) => {
      const raw = localStorage.getItem(registryKey);
      const registry: Array<{ serverId: string; label?: string }> = raw ? JSON.parse(raw) : [];
      if (primaryLabel && registry[0]) {
        registry[0].label = primaryLabel;
      }
      if (!registry.some((entry) => entry.serverId === host.serverId)) {
        registry.push(host);
      }
      localStorage.setItem(registryKey, JSON.stringify(registry));
    },
    { host: offlineHost, registryKey: REGISTRY_KEY, primaryLabel: input.primaryLabel },
  );
}
