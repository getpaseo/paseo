import { expect, type Page } from "../fixtures";
import { buildCreateAgentPreferences, buildSeededHost } from "./daemon-registry";

const DISABLE_DEFAULT_SEED_ONCE_KEY = "@paseo:e2e-disable-default-seed-once";
const SEED_NONCE_KEY = "@paseo:e2e-seed-nonce";
const REGISTRY_KEY = "@paseo:daemon-registry";
const E2E_KEY = "@paseo:e2e";

type SavedHostInput = {
  serverId: string;
  label: string;
  endpoint: string;
};

export function startupScenario(page: Page) {
  return new StartupScenario(page);
}

class StartupScenario {
  private readonly page: Page;
  private savedHosts: SavedHostInput[] = [];
  private desktopBridge = false;
  private blockedEndpointPorts = new Set<string>();
  private viewport: { width: number; height: number } | null = null;

  constructor(page: Page) {
    this.page = page;
  }

  withMobileViewport(): this {
    this.viewport = { width: 390, height: 844 };
    return this;
  }

  withSavedHost(input: SavedHostInput): this {
    this.savedHosts.push(input);
    const port = input.endpoint.match(/:(\d+)$/)?.[1];
    if (port) {
      this.blockedEndpointPorts.add(port);
    }
    return this;
  }

  withPendingDesktopDaemon(): this {
    this.desktopBridge = true;
    return this;
  }

  withBlockedPort(port: string): this {
    this.blockedEndpointPorts.add(port);
    return this;
  }

  async openRoot(): Promise<StartupAssertions> {
    await this.prepare();
    await this.page.goto("/");
    return new StartupAssertions(this.page);
  }

  async openHostWorkspace(input: {
    serverId: string;
    workspaceId: string;
  }): Promise<StartupAssertions> {
    await this.prepare();
    await this.page.goto(
      `/h/${encodeURIComponent(input.serverId)}/workspace/${encodeURIComponent(input.workspaceId)}`,
    );
    return new StartupAssertions(this.page);
  }

  private async prepare(): Promise<void> {
    if (this.viewport) {
      await this.page.setViewportSize(this.viewport);
    }

    if (this.desktopBridge) {
      await installPendingDesktopBridge(this.page);
    }

    for (const port of this.blockedEndpointPorts) {
      await this.page.routeWebSocket(new RegExp(`:${escapeRegex(port)}\\b`), async (ws) => {
        await ws.close({ code: 1008, reason: "Blocked unreachable startup test host." });
      });
    }

    if (this.savedHosts.length === 0) {
      return;
    }

    // Let the shared fixture create its seed nonce, then opt out of that seed for
    // the next navigation so this scenario owns the stored host registry.
    await this.page.goto("/");
    const nowIso = new Date().toISOString();
    const registry = this.savedHosts.map((host) =>
      buildStoredHost({
        serverId: host.serverId,
        endpoint: host.endpoint,
        label: host.label,
        nowIso,
      }),
    );
    const firstHost = registry[0];
    if (!firstHost) {
      throw new Error("Expected at least one startup test host.");
    }
    const createAgentPreferences = buildStoredCreateAgentPreferences(firstHost.serverId);

    await this.page.evaluate(
      ({ keys, registry, createAgentPreferences }) => {
        const nonce = localStorage.getItem(keys.seedNonce);
        if (!nonce) {
          throw new Error("Expected e2e seed nonce before overriding startup registry.");
        }

        localStorage.setItem(keys.e2e, "1");
        localStorage.setItem(keys.registry, JSON.stringify(registry));
        localStorage.setItem(
          "@paseo:create-agent-preferences",
          JSON.stringify(createAgentPreferences),
        );
        localStorage.setItem(keys.disableDefaultSeedOnce, nonce);
      },
      {
        keys: {
          disableDefaultSeedOnce: DISABLE_DEFAULT_SEED_ONCE_KEY,
          e2e: E2E_KEY,
          registry: REGISTRY_KEY,
          seedNonce: SEED_NONCE_KEY,
        },
        registry,
        createAgentPreferences,
      },
    );
  }
}

class StartupAssertions {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async expectsReconnectWelcome(): Promise<this> {
    await expect(this.page.getByTestId("welcome-screen")).toBeVisible({ timeout: 15_000 });
    await expect(this.page.getByText("Connecting…", { exact: true })).toBeVisible();
    await expect(this.page.getByTestId("welcome-open-settings")).toBeVisible();
    await expect(this.page.getByTestId("welcome-direct-connection")).toBeVisible();
    await expect(this.page.getByTestId("welcome-paste-pairing-link")).toBeVisible();
    await expect(this.page.getByTestId("welcome-scan-qr")).toHaveCount(0);
    return this;
  }

  async expectsNoSavedHostStatus(input: { label: string }): Promise<this> {
    await expect(this.page.getByText(input.label, { exact: true })).toHaveCount(0);
    await expect(this.page.getByText("Connection error", { exact: true })).toHaveCount(0);
    await expect(this.page.getByText("Offline", { exact: true })).toHaveCount(0);
    return this;
  }

  async expectsNoLocalServerStartupCopy(): Promise<this> {
    await expect(this.page.getByText("Starting local server...", { exact: true })).toHaveCount(0);
    await expect(this.page.getByText("Connecting to local server...", { exact: true })).toHaveCount(
      0,
    );
    return this;
  }

  async expectsDesktopDaemonStartup(): Promise<this> {
    await expect(this.page.getByText("Starting local server...", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    return this;
  }

  async expectsSidebarHidden(): Promise<this> {
    await expect(this.page.locator('[data-testid="sidebar-settings"]:visible')).toHaveCount(0);
    await expect(this.page.locator('[data-testid="sidebar-project-list"]:visible')).toHaveCount(0);
    return this;
  }

  async expectsNoUndefinedRoute(): Promise<this> {
    await expect(this.page).not.toHaveURL(/\/h\/undefined\/workspace\/undefined/);
    return this;
  }
}

async function installPendingDesktopBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { paseoDesktop: unknown }).paseoDesktop = {
      platform: "darwin",
      invoke: async (command: string) => {
        if (command === "start_desktop_daemon") {
          await new Promise(() => {
            // Keep the daemon in the startup phase until the test ends.
          });
        }
        if (command === "desktop_daemon_status") {
          return {
            serverId: "srv_desktop_pending",
            status: "starting",
            listen: null,
            hostname: null,
            pid: null,
            home: "",
            version: null,
            desktopManaged: true,
            error: null,
          };
        }
        if (command === "desktop_daemon_logs") {
          return { logPath: "", contents: "" };
        }
        return null;
      },
      getPendingOpenProject: async () => null,
      events: { on: async () => () => undefined },
    };
  });
}

function buildStoredHost(input: {
  serverId: string;
  endpoint: string;
  label: string;
  nowIso: string;
}) {
  return buildSeededHost(input);
}

function buildStoredCreateAgentPreferences(serverId: string) {
  return buildCreateAgentPreferences(serverId);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
