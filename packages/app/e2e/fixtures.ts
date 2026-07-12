import { test as base, expect, type Page } from "@playwright/test";
import { getE2EDaemonPort } from "./helpers/daemon-port";
import { buildCreateAgentPreferences, buildSeededHost } from "./helpers/daemon-registry";
import {
  createProjectPickerFixture,
  removeProjectPickerFixture,
  type ProjectPickerFixture,
} from "./helpers/project-picker-fixture";
import { connectSeedClient } from "./helpers/seed-client";
import { createWithWorkspace, type WithWorkspace } from "./helpers/with-workspace";

const EXTRA_HOSTS_KEY = "@paseo:e2e-extra-hosts";

interface TrackedProjectPickerFixture extends ProjectPickerFixture {
  rememberProjectId: (projectId: string) => void;
}

// Test setup is wired through an `auto: true` fixture rather than `test.beforeEach`.
// `test.beforeEach` declared at the top level of a non-test fixture file is unreliable
// across spec-file boundaries — Playwright sometimes skips it for the first test of a
// subsequent spec when multiple specs run in the same worker. Auto fixtures run
// reliably for every test that uses this `test` object.
const test = base.extend<{
  paseoE2ESetup: void;
  projectPickerFixture: TrackedProjectPickerFixture;
  withWorkspace: WithWorkspace;
}>({
  baseURL: async ({}, provide) => {
    const metroPort = process.env.E2E_METRO_PORT;
    if (!metroPort) {
      throw new Error("E2E_METRO_PORT not set - globalSetup must run first");
    }
    await provide(`http://localhost:${metroPort}`);
  },
  paseoE2ESetup: [
    async ({ page }, provide, testInfo) => {
      const daemonPort = getE2EDaemonPort();
      const metroPort = process.env.E2E_METRO_PORT;
      if (!metroPort) {
        throw new Error(
          "E2E_METRO_PORT is not set. Ensure Playwright `globalSetup` starts Metro and exports E2E_METRO_PORT.",
        );
      }

      // Hard guardrail: never allow tests to hit the developer's default daemon.
      // This blocks both HTTP and WS attempts to :6767 (before any navigation).
      await page.route(/:(6767)\b/, (route) => route.abort());
      await page.routeWebSocket(/:(6767)\b/, async (ws) => {
        await ws.close({ code: 1008, reason: "Blocked connection to localhost:6767 during e2e." });
      });

      const entries: string[] = [];

      page.on("console", (message) => {
        entries.push(`[console:${message.type()}] ${message.text()}`);
      });

      page.on("pageerror", (error) => {
        entries.push(`[pageerror] ${error.message}`);
      });

      const nowIso = new Date().toISOString();
      const seedNonce = Math.random().toString(36).slice(2);
      const serverId = process.env.E2E_SERVER_ID;
      if (!serverId) {
        throw new Error("E2E_SERVER_ID is not set - expected from Playwright globalSetup.");
      }
      const testDaemon = buildSeededHost({
        serverId,
        endpoint: `127.0.0.1:${daemonPort}`,
        nowIso,
      });
      const createAgentPreferences = buildCreateAgentPreferences(testDaemon.serverId);

      await page.addInitScript(
        ({ daemon, preferences, seedNonce: nonce, extraHostsKey }) => {
          // `addInitScript` runs on every navigation (including reloads). Some tests intentionally
          // override storage and reload; they can opt out of seeding for the *next* navigation by
          // setting this flag before the reload.
          const disableOnceKey = "@paseo:e2e-disable-default-seed-once";
          const disableValue = localStorage.getItem(disableOnceKey);
          if (disableValue) {
            localStorage.removeItem(disableOnceKey);
            if (disableValue === nonce) {
              return;
            }
          }

          localStorage.setItem("@paseo:e2e", "1");
          localStorage.setItem("@paseo:e2e-seed-nonce", nonce);

          const rawExtraHosts = localStorage.getItem(extraHostsKey);
          const extraHosts = rawExtraHosts ? JSON.parse(rawExtraHosts) : [];

          // Hard-reset anything that could point to a developer's real daemon.
          localStorage.setItem("@paseo:daemon-registry", JSON.stringify([daemon, ...extraHosts]));
          localStorage.removeItem("@paseo:settings");
          localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
        },
        {
          daemon: testDaemon,
          preferences: createAgentPreferences,
          seedNonce,
          extraHostsKey: EXTRA_HOSTS_KEY,
        },
      );

      await provide();

      if (entries.length > 0 && testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("browser-console", {
          body: entries.join("\n"),
          contentType: "text/plain",
        });
      }
    },
    { auto: true },
  ],
  projectPickerFixture: async ({}, provide) => {
    const resource = await createProjectPickerFixture();
    const { fixture } = resource;
    let projectId: string | null = null;
    try {
      await provide({
        ...fixture,
        rememberProjectId: (openedProjectId) => {
          projectId = openedProjectId;
        },
      });
    } finally {
      try {
        const client = await connectSeedClient();
        try {
          await removeProjectPickerFixture(client, fixture, projectId);
        } finally {
          await client.close();
        }
      } finally {
        await resource.removeDirectory();
      }
    }
  },
  withWorkspace: async ({ page }, provide) => {
    const handle = createWithWorkspace(page);
    await provide(handle.withWorkspace);
    await handle.cleanup();
  },
});

export { test, expect, type Page };
