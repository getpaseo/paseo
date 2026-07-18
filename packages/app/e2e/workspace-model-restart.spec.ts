import { randomUUID } from "node:crypto";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { test, expect, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute, decodeWorkspaceIdFromPathSegment } from "@/utils/host-routes";
import { buildSeededHost } from "./helpers/daemon-registry";
import { loadDaemonClientConstructor } from "./helpers/daemon-client-loader";
import { createNodeWebSocketFactory, type NodeWebSocketFactory } from "./helpers/node-ws-factory";
import { withDisabledE2ESpeechEnv } from "./helpers/speech-env";
import {
  expectNewWorkspaceProjectSelected,
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
  submitNewWorkspaceEmpty,
} from "./helpers/new-workspace";
import { waitForSidebarHydration } from "./helpers/workspace-ui";
import { getVisibleWorkspaceAgentTabIds } from "./helpers/workspace-tabs";

const LEGACY_AGENT_ID = "10000000-0000-4000-8000-000000000001";
const SERVER_ID = `srv_restart_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

interface RestartDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  fetchWorkspaces(): Promise<{
    entries: Array<{
      id: string;
      name: string;
      status: string;
      workspaceDirectory: string;
    }>;
  }>;
  fetchAgents(options?: { scope?: "active" }): Promise<{
    entries: Array<{
      agent: {
        id: string;
        workspaceId?: string;
        status: string;
      };
    }>;
  }>;
}

interface RestartDaemonClientConfig {
  url: string;
  clientId: string;
  clientType: "cli";
  appVersion: string;
  webSocketFactory: NodeWebSocketFactory;
}

interface SeededRestartHome {
  paseoHome: string;
  cwd: string;
  projectId: string;
  projectDisplayName: string;
  workspaceA: string;
  workspaceB: string;
  cleanup(): void;
}

interface StartedDaemon {
  port: number;
  close(): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function seedRestartHome(): Promise<SeededRestartHome> {
  const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-playwright-restart-home-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-playwright-restart-cwd-"));
  const projectsDir = path.join(paseoHome, "projects");
  const agentDir = path.join(paseoHome, "agents", projectDirNameFromCwd(cwd));
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const projectDisplayName = path.basename(cwd);
  const project = {
    projectId: `prj_restart_${randomUUID().slice(0, 8)}`,
    rootPath: cwd,
    kind: "non_git",
    displayName: projectDisplayName,
    customName: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
  };
  const workspaceA = {
    workspaceId: "wks_restart_a",
    projectId: project.projectId,
    cwd,
    kind: "directory",
    displayName: "Original restart workspace",
    title: null,
    branch: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
  };
  const workspaceB = {
    workspaceId: "wks_restart_b",
    projectId: project.projectId,
    cwd,
    kind: "directory",
    displayName: "Restart sibling workspace",
    title: null,
    branch: null,
    createdAt: "2026-03-02T00:00:00.000Z",
    updatedAt: "2026-03-02T00:00:00.000Z",
    archivedAt: null,
  };

  writeFileSync(path.join(projectsDir, "projects.json"), JSON.stringify([project]));
  writeFileSync(
    path.join(projectsDir, "workspaces.json"),
    JSON.stringify([workspaceA, workspaceB]),
  );
  writeFileSync(
    path.join(agentDir, `${LEGACY_AGENT_ID}.json`),
    JSON.stringify({
      id: LEGACY_AGENT_ID,
      provider: "codex",
      cwd,
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
      lastActivityAt: "2026-03-01T12:00:00.000Z",
      lastUserMessageAt: null,
      title: "Legacy cwd-only running agent",
      labels: {},
      lastStatus: "running",
      lastModeId: "default",
      config: null,
      runtimeInfo: { provider: "codex", sessionId: null },
      persistence: null,
      archivedAt: null,
    }),
  );

  return {
    paseoHome,
    cwd,
    projectId: project.projectId,
    projectDisplayName,
    workspaceA: workspaceA.workspaceId,
    workspaceB: workspaceB.workspaceId,
    cleanup: () => {
      rmSync(paseoHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function projectDirNameFromCwd(cwd: string): string {
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? `${sanitizedRoot}-` : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(port: number, child: ChildProcess): Promise<void> {
  const startedAt = Date.now();
  let lastConnectionError: unknown = null;
  while (Date.now() - startedAt < 20_000) {
    if (child.exitCode !== null) {
      throw new Error(`Restart test daemon exited before listening (exit ${child.exitCode}).`);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.end();
          resolve();
        });
        socket.setTimeout(1000, () => {
          socket.destroy();
          reject(new Error(`Connection timed out to daemon port ${port}`));
        });
        socket.on("error", reject);
      });
      return;
    } catch (error) {
      lastConnectionError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    `Restart test daemon did not listen on ${port}. Last error: ${
      lastConnectionError instanceof Error
        ? lastConnectionError.message
        : String(lastConnectionError)
    }`,
  );
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timeout = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 5000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(timeout);
  }
}

async function startRestartDaemon(input: {
  paseoHome: string;
  origin: string;
}): Promise<StartedDaemon> {
  const port = await getAvailablePort();
  if (port === 6767 || String(port) === process.env.E2E_DAEMON_PORT) {
    return startRestartDaemon(input);
  }

  const serverDir = path.resolve(__dirname, "../../server");
  const tsxBin = execSync("which tsx").toString().trim();
  const child = spawn(tsxBin, ["scripts/supervisor-entrypoint.ts", "--dev"], {
    cwd: serverDir,
    env: withDisabledE2ESpeechEnv({
      ...process.env,
      PASEO_HOME: input.paseoHome,
      PASEO_SERVER_ID: SERVER_ID,
      PASEO_LISTEN: `127.0.0.1:${port}`,
      PASEO_CORS_ORIGINS: input.origin,
      PASEO_RELAY_ENABLED: "0",
      PASEO_NODE_ENV: "development",
      NODE_ENV: "development",
    }),
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    stderr = stderr.split("\n").slice(-40).join("\n");
  });

  try {
    await waitForServer(port, child);
  } catch (error) {
    await stopProcess(child);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nDaemon stderr:\n${stderr}`,
      { cause: error },
    );
  }

  return {
    port,
    close: () => stopProcess(child),
  };
}

async function connectRestartDaemonClient(port: number): Promise<RestartDaemonClient> {
  const DaemonClient = await loadDaemonClientConstructor<
    RestartDaemonClientConfig,
    RestartDaemonClient
  >();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: `restart-playwright-${randomUUID()}`,
    clientType: "cli",
    appVersion: loadAppVersion(),
    webSocketFactory: createNodeWebSocketFactory(),
  });
  await client.connect();
  return client;
}

function loadAppVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Missing app package version");
  }
  return packageJson.version;
}

async function seedBrowserForDaemon(page: Page, input: { serverId: string; port: number }) {
  await page.route(/:(6767)\b/, (route) => route.abort());
  await page.routeWebSocket(/:(6767)\b/, async (ws) => {
    await ws.close({ code: 1008, reason: "Blocked connection to localhost:6767 during e2e." });
  });
  await page.route(
    "**/*",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body>storage seed</body></html>",
      });
    },
    { times: 1 },
  );
  await page.goto("/");

  const host = buildSeededHost({
    serverId: input.serverId,
    endpoint: `127.0.0.1:${input.port}`,
    label: "restart daemon",
    nowIso: nowIso(),
  });
  await page.evaluate(
    ({ daemon, preferences }) => {
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([daemon]));
      localStorage.removeItem("@paseo:settings");
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
    },
    {
      daemon: host,
      preferences: {
        serverId: input.serverId,
        provider: "codex",
        providerPreferences: {
          codex: { model: "gpt-5.4-mini", thinkingOptionId: "low" },
        },
      },
    },
  );
}

function parseWorkspaceIdFromPageUrl(page: Page, serverId: string): string | null {
  const pathname = new URL(page.url()).pathname;
  const match = pathname.match(
    new RegExp(`^/h/${serverId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/workspace/([^/?#]+)`),
  );
  if (!match?.[1]) return null;
  return decodeWorkspaceIdFromPathSegment(match[1]);
}

async function expectWorkspaceRowHasOnlyIndicator(
  page: Page,
  input: { serverId: string; workspaceId: string; indicator: string },
) {
  const row = page.getByTestId(`sidebar-workspace-row-${input.serverId}:${input.workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  for (const indicator of ["attention", "done", "failed", "loading", "needs_input", "running"]) {
    const locator = row.locator(`[data-testid="workspace-status-indicator-${indicator}"]`);
    if (indicator === input.indicator) {
      await expect(locator).toBeVisible({ timeout: 30_000 });
    } else {
      await expect(locator).toHaveCount(0);
    }
  }
}

async function expectWorkspaceRowDoesNotShowIndicator(
  page: Page,
  input: { serverId: string; workspaceId: string; indicator: string },
) {
  const row = page.getByTestId(`sidebar-workspace-row-${input.serverId}:${input.workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(
    row.locator(`[data-testid="workspace-status-indicator-${input.indicator}"]`),
  ).toHaveCount(0, { timeout: 5_000 });
}

async function expectWorkspaceRowInStatusBucket(
  page: Page,
  input: { serverId: string; workspaceId: string; bucket: string },
) {
  await page.getByTestId("sidebar-display-preferences-menu").click();
  await page.getByTestId("sidebar-grouping-status").click();
  await expect(
    page
      .getByTestId(`sidebar-status-group-rows-${input.bucket}`)
      .getByTestId(`sidebar-workspace-row-${input.serverId}:${input.workspaceId}`),
  ).toBeVisible({ timeout: 30_000 });
}

async function fetchLegacyAgent(client: RestartDaemonClient) {
  const agents = await client.fetchAgents({ scope: "active" });
  return agents.entries.find(hasLegacyAgentId)?.agent ?? null;
}

function hasLegacyAgentId(entry: { agent: { id: string } }): boolean {
  return entry.agent.id === LEGACY_AGENT_ID;
}

async function fetchWorkspaceStatuses(
  client: RestartDaemonClient,
  workspaceIds: string[],
): Promise<Record<string, string>> {
  const workspaces = await client.fetchWorkspaces();
  const wantedWorkspaceIds = new Set(workspaceIds);
  const statuses: Record<string, string> = {};
  for (const workspace of workspaces.entries) {
    if (wantedWorkspaceIds.has(workspace.id)) {
      statuses[workspace.id] = workspace.status;
    }
  }
  return statuses;
}

test.describe("Workspace model restart regressions", () => {
  test("browser-created same-cwd workspace preserves restarted agent status and migrated tab ownership", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const seeded = await seedRestartHome();
    const origin = new URL(baseURL ?? "http://localhost").origin;
    const daemon = await startRestartDaemon({ paseoHome: seeded.paseoHome, origin });
    const serverId = SERVER_ID;
    const client = await connectRestartDaemonClient(daemon.port);

    try {
      await seedBrowserForDaemon(page, { serverId, port: daemon.port });

      await expect
        .poll(() => fetchLegacyAgent(client))
        .toMatchObject({
          id: LEGACY_AGENT_ID,
          workspaceId: seeded.workspaceA,
          status: "running",
        });

      await page.goto(buildHostWorkspaceRoute(serverId, seeded.workspaceA));
      await waitForSidebarHydration(page);
      await expectWorkspaceRowHasOnlyIndicator(page, {
        serverId,
        workspaceId: seeded.workspaceA,
        indicator: "running",
      });
      await expectWorkspaceRowDoesNotShowIndicator(page, {
        serverId,
        workspaceId: seeded.workspaceB,
        indicator: "running",
      });
      await expect
        .poll(() => getVisibleWorkspaceAgentTabIds(page), { timeout: 30_000 })
        .toContain(`workspace-tab-agent_${LEGACY_AGENT_ID}`);

      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, {
        projectKey: seeded.projectId,
        projectDisplayName: seeded.projectDisplayName,
      });
      await expectNewWorkspaceProjectSelected(page, seeded.projectDisplayName);
      await submitNewWorkspaceEmpty(page);

      await expect
        .poll(() => {
          const workspaceId = parseWorkspaceIdFromPageUrl(page, serverId);
          return workspaceId && workspaceId !== seeded.workspaceA ? workspaceId : null;
        })
        .not.toBeNull();
      const createdWorkspaceId = parseWorkspaceIdFromPageUrl(page, serverId);
      if (!createdWorkspaceId) {
        throw new Error(`Expected browser to navigate to created workspace, got ${page.url()}`);
      }

      await expect
        .poll(() =>
          fetchWorkspaceStatuses(client, [
            seeded.workspaceA,
            seeded.workspaceB,
            createdWorkspaceId,
          ]),
        )
        .toEqual({
          [seeded.workspaceA]: "running",
          [seeded.workspaceB]: "done",
          [createdWorkspaceId]: "done",
        });

      await expectWorkspaceRowDoesNotShowIndicator(page, {
        serverId,
        workspaceId: seeded.workspaceB,
        indicator: "running",
      });
      await expectWorkspaceRowDoesNotShowIndicator(page, {
        serverId,
        workspaceId: createdWorkspaceId,
        indicator: "running",
      });
      await expectWorkspaceRowInStatusBucket(page, {
        serverId,
        workspaceId: seeded.workspaceA,
        bucket: "running",
      });
      await expectWorkspaceRowInStatusBucket(page, {
        serverId,
        workspaceId: seeded.workspaceB,
        bucket: "done",
      });
      await expectWorkspaceRowInStatusBucket(page, {
        serverId,
        workspaceId: createdWorkspaceId,
        bucket: "done",
      });
      await expect
        .poll(() => getVisibleWorkspaceAgentTabIds(page), { timeout: 30_000 })
        .toEqual([]);

      await page.goto(buildHostWorkspaceRoute(serverId, seeded.workspaceA));
      await expect
        .poll(() => getVisibleWorkspaceAgentTabIds(page), { timeout: 30_000 })
        .toContain(`workspace-tab-agent_${LEGACY_AGENT_ID}`);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
      seeded.cleanup();
    }
  });
});
