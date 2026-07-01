import { type Page } from "@playwright/test";
import { buildSeededHost } from "./daemon-registry";
import { wsRoutePatternForPort } from "./daemon-port";
import { type SeededWorkspace } from "./seed-client";

const REGISTRY_KEY = "@paseo:daemon-registry";
const SEED_NONCE_KEY = "@paseo:e2e-seed-nonce";
const DISABLE_DEFAULT_SEED_ONCE_KEY = "@paseo:e2e-disable-default-seed-once";
const FAKE_HOST_MODEL_ID = "fake-host-model";
const FAKE_HOST_MODEL_LABEL = "Fake host model";
const FAKE_HOST_PROJECT_DISPLAY_NAME = "Fake host project";

type WebSocketMessage = string | Buffer;
type SessionRequest = Record<string, unknown> & { type?: string; requestId?: string };

export interface FakeScheduleHostWorkspace {
  serverId: string;
  projectId: string;
  projectDisplayName: string;
  workspace: Record<string, unknown>;
}

function parseJson(message: WebSocketMessage): unknown {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildSessionMessage(type: string, payload: Record<string, unknown>) {
  return JSON.stringify({
    type: "session",
    message: {
      type,
      payload,
    },
  });
}

function buildFakeProviderEntries(nowIso: string) {
  return [
    {
      provider: "mock",
      label: "Mock",
      status: "ready",
      enabled: true,
      fetchedAt: nowIso,
      models: [
        {
          provider: "mock",
          id: FAKE_HOST_MODEL_ID,
          label: FAKE_HOST_MODEL_LABEL,
          isDefault: true,
        },
      ],
      modes: [{ id: "load-test", label: "Load test" }],
      defaultModeId: "load-test",
    },
  ];
}

function readSessionRequest(message: WebSocketMessage): SessionRequest | null {
  const parsed = parseJson(message);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const envelope = parsed as { type?: string; message?: SessionRequest };
  if (envelope.type !== "session" || !envelope.message) {
    return null;
  }

  return envelope.message;
}

function getRequestId(request: SessionRequest): string {
  return typeof request.requestId === "string" ? request.requestId : "fake-request";
}

export async function buildFakeScheduleHostWorkspace(
  workspace: SeededWorkspace,
): Promise<FakeScheduleHostWorkspace> {
  const workspaceList = await workspace.client.fetchWorkspaces({
    filter: { projectId: workspace.projectId },
  });
  const baseWorkspace = workspaceList.entries.find((entry) => entry.id === workspace.workspaceId);
  if (!baseWorkspace) {
    throw new Error(`Failed to load seeded workspace descriptor ${workspace.workspaceId}`);
  }

  const projectId = `${workspace.projectId}-fake-host`;
  const cwd = `${workspace.repoPath}-fake-host`;
  return {
    serverId: "schedule-fake-host",
    projectId,
    projectDisplayName: FAKE_HOST_PROJECT_DISPLAY_NAME,
    workspace: {
      ...baseWorkspace,
      id: `${baseWorkspace.id}-fake-host`,
      projectId,
      projectDisplayName: FAKE_HOST_PROJECT_DISPLAY_NAME,
      projectRootPath: cwd,
      workspaceDirectory: cwd,
      name: FAKE_HOST_PROJECT_DISPLAY_NAME,
      project: undefined,
    },
  };
}

export async function installFakeScheduleHost(input: {
  page: Page;
  port: string;
  serverId: string;
  workspace: Record<string, unknown>;
}): Promise<void> {
  await input.page.routeWebSocket(wsRoutePatternForPort(input.port), (ws) => {
    ws.onMessage((message) => {
      const parsed = parseJson(message);
      if (parsed && typeof parsed === "object" && (parsed as { type?: string }).type === "hello") {
        ws.send(
          buildSessionMessage("status", {
            status: "server_info",
            serverId: input.serverId,
            hostname: "fake-schedule-host",
            version: "0.0.0-e2e",
            features: {
              providersSnapshot: true,
              workspaceMultiplicity: true,
              projectAdd: true,
              projectRemove: true,
              worktreeRestore: true,
            },
          }),
        );
        return;
      }

      if (parsed && typeof parsed === "object" && (parsed as { type?: string }).type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      const request = readSessionRequest(message);
      if (!request) {
        return;
      }

      const requestId = getRequestId(request);
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      switch (request.type) {
        case "ping":
          ws.send(
            buildSessionMessage("pong", {
              requestId,
              clientSentAt: typeof request.clientSentAt === "number" ? request.clientSentAt : now,
              serverReceivedAt: now,
              serverSentAt: now,
            }),
          );
          return;
        case "fetch_workspaces_request":
          ws.send(
            buildSessionMessage("fetch_workspaces_response", {
              requestId,
              entries: [input.workspace],
              emptyProjects: [],
              pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            }),
          );
          return;
        case "fetch_agents_request":
          ws.send(
            buildSessionMessage("fetch_agents_response", {
              requestId,
              entries: [],
              pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            }),
          );
          return;
        case "get_providers_snapshot_request":
          ws.send(
            buildSessionMessage("get_providers_snapshot_response", {
              requestId,
              entries: buildFakeProviderEntries(nowIso),
              generatedAt: nowIso,
            }),
          );
          return;
        case "refresh_providers_snapshot_request":
          ws.send(
            buildSessionMessage("refresh_providers_snapshot_response", {
              requestId,
              acknowledged: true,
            }),
          );
          return;
        case "schedule/list":
          ws.send(
            buildSessionMessage("schedule/list/response", {
              requestId,
              schedules: [],
              error: null,
            }),
          );
          return;
      }
    });
  });
}

export async function addFakeScheduleHostAndReload(input: {
  page: Page;
  serverId: string;
  label: string;
  port: string;
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
      localStorage.setItem(keys.registry, JSON.stringify([...registry, seededHost]));
      localStorage.setItem(keys.disableSeedOnce, nonce);
    },
    {
      seededHost: host,
      keys: {
        registry: REGISTRY_KEY,
        nonce: SEED_NONCE_KEY,
        disableSeedOnce: DISABLE_DEFAULT_SEED_ONCE_KEY,
      },
    },
  );

  await input.page.reload();
}
