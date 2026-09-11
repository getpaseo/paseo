import { type Page } from "@playwright/test";
import { buildSeededHost } from "./daemon-registry";
import { startIsolatedHostDaemon } from "./isolated-host-daemon";
import { seedWorkspace, type SeededWorkspace } from "./seed-client";

const REGISTRY_KEY = "@paseo:daemon-registry";
const SEED_NONCE_KEY = "@paseo:e2e-seed-nonce";
const EXTRA_HOSTS_KEY = "@paseo:e2e-extra-hosts";
export const SECONDARY_MODEL_ID = "one-minute-stream";
export const SECONDARY_MODEL_LABEL = "One minute stream";

export async function createScheduleHost() {
  const daemon = await startIsolatedHostDaemon("schedule-secondary-host");
  let workspace: SeededWorkspace | undefined;
  try {
    workspace = await seedWorkspace({ repoPrefix: "schedule-secondary-", port: daemon.port });
    const seeded = workspace;
    await seeded.client.renameProject(seeded.projectId, "Secondary project");
    return {
      ...seeded,
      projectDisplayName: "Secondary project",
      serverId: daemon.serverId,
      port: daemon.port,
      label: "Secondary host",
      cleanup: async () => {
        await seeded.cleanup();
        await daemon.close();
      },
    };
  } catch (error) {
    await workspace?.cleanup();
    await daemon.close();
    throw error;
  }
}

export async function addScheduleHostAndReload(input: {
  page: Page;
  serverId: string;
  label: string;
  port: number;
}): Promise<void> {
  const host = buildSeededHost({
    serverId: input.serverId,
    label: input.label,
    endpoint: `127.0.0.1:${input.port}`,
    nowIso: new Date().toISOString(),
  });

  await input.page.evaluate(
    ({ seededHost, keys }) => {
      const nonce = localStorage.getItem(keys.nonce);
      if (!nonce) {
        throw new Error("Expected the e2e seed nonce before overriding the host registry.");
      }
      const raw = localStorage.getItem(keys.registry);
      const registry: Array<{ serverId: string }> = raw ? JSON.parse(raw) : [];
      const nextRegistry = registry.filter((entry) => entry.serverId !== seededHost.serverId);
      nextRegistry.push(seededHost);
      localStorage.setItem(keys.registry, JSON.stringify(nextRegistry));

      const rawExtraHosts = localStorage.getItem(keys.extraHosts);
      const extraHosts: Array<{ serverId: string }> = rawExtraHosts
        ? JSON.parse(rawExtraHosts)
        : [];
      const nextExtraHosts = extraHosts.filter((entry) => entry.serverId !== seededHost.serverId);
      nextExtraHosts.push(seededHost);
      localStorage.setItem(keys.extraHosts, JSON.stringify(nextExtraHosts));
    },
    {
      seededHost: host,
      keys: {
        registry: REGISTRY_KEY,
        nonce: SEED_NONCE_KEY,
        extraHosts: EXTRA_HOSTS_KEY,
      },
    },
  );

  await input.page.reload();
}
