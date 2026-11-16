import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, expect, test } from "vitest";

import { createHostResolver, type HostOperations } from "./index.js";

type Handler = ((event?: unknown) => void) | null;

/** A connected host from before background agents: background workspaces, no background agents. */
class OlderHostSocket {
  readyState = 1;
  readonly requests: Array<Record<string, unknown>> = [];
  onopen: Handler = null;
  onmessage: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  private readonly createSent = Promise.withResolvers<Record<string, unknown>>();

  constructor() {
    queueMicrotask(() => this.onopen?.());
  }

  createRequest(): Promise<Record<string, unknown>> {
    return this.createSent.promise;
  }

  send(data: string): void {
    const frame = JSON.parse(data);
    if (frame.type === "hello") {
      this.reply({
        type: "status",
        payload: {
          status: "server_info",
          serverId: "srv_older",
          hostname: null,
          version: null,
          features: {
            providerUsageList: true,
            providersSnapshotCwd: true,
            ownedSubscriptions: true,
            backgroundWorkspaces: true,
          },
        },
      });
      return;
    }
    if (frame.type !== "session") return;
    const message = frame.message;
    this.requests.push(message);
    if (message.type === "fetch_workspaces_request") {
      this.reply({
        type: "fetch_workspaces_response",
        payload: {
          requestId: message.requestId,
          entries: [workspace],
          pageInfo: emptyPage,
        },
      });
    }
    if (message.type === "create_agent_request") this.createSent.resolve(message);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "closed" });
  }

  private reply(message: object): void {
    this.onmessage?.({ data: JSON.stringify({ type: "session", message }) });
  }
}

const emptyPage = { nextCursor: null, prevCursor: null, hasMore: false };

const workspace = {
  id: "workspace_older",
  projectId: "project_older",
  projectDisplayName: "Older",
  projectRootPath: "/repo/older",
  workspaceDirectory: "/repo/older",
  projectKind: "git",
  workspaceKind: "directory",
  name: "older",
  archivingAt: null,
  status: "done",
  statusEnteredAt: null,
  activityAt: "2026-05-16T00:00:00.000Z",
  scripts: [],
  gitRuntime: null,
  githubRuntime: null,
};

const clients: DaemonClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function olderHost() {
  const socket = new OlderHostSocket();
  const client = new DaemonClient({
    url: "ws://older.test",
    clientId: "older-host-test",
    webSocketFactory: () => socket,
    reconnect: { enabled: false },
  });
  clients.push(client);
  await client.connect();
  return { client, socket };
}

interface Caller {
  background: boolean;
  provider: string;
  currentModeId: string | null;
}

function resolverFor(client: DaemonClient, caller: Caller | null) {
  return createHostResolver({
    serverId: "origin",
    callerAgentId: caller ? "caller" : undefined,
    caller: () => caller,
    local: {} as HostOperations,
    hosts: () => ({
      directory: async () => ({ self: { serverId: "origin", label: "Origin" }, hosts: [] }),
      use: (_serverId, action) => action(client),
    }),
  });
}

const visibleCodexCaller: Caller = {
  background: false,
  provider: "codex",
  currentModeId: "full-access",
};

const createArgs = {
  workspaceId: workspace.id,
  provider: "codex/gpt-5.4",
  title: "Helper",
  initialPrompt: "Summarize",
};

test("a visible caller still creates agents on a host without background agents", async () => {
  const { client, socket } = await olderHost();
  const creating = resolverFor(client, visibleCodexCaller).use("srv_older", (host) =>
    host.createAgent(createArgs, {} as never),
  );
  creating.catch(() => {});

  const request = await socket.createRequest();
  expect(request).toMatchObject({ workspaceId: workspace.id });
  expect(request).not.toHaveProperty("background");
});

test("a background caller's remote child asks the host to update instead of turning visible", async () => {
  const { client, socket } = await olderHost();

  await expect(
    resolverFor(client, { ...visibleCodexCaller, background: true }).use("srv_older", (host) =>
      host.createAgent(createArgs, {} as never),
    ),
  ).rejects.toThrow("Update the host to use background agents.");
  expect(socket.requests.map((request) => request.type)).not.toContain("create_agent_request");
});

async function forwardedMode(caller: Caller | null, args: Record<string, unknown> = createArgs) {
  const { client, socket } = await olderHost();
  const creating = resolverFor(client, caller).use("srv_older", (host) =>
    host.createAgent(args, {} as never),
  );
  creating.catch(() => {});
  const request = (await socket.createRequest()) as { config: { modeId?: string } };
  return request.config.modeId;
}

test("a remote child of the same provider starts in its caller's mode", async () => {
  expect(await forwardedMode(visibleCodexCaller)).toBe("full-access");
});

test("an explicit mode wins over the caller's mode on a remote host", async () => {
  expect(
    await forwardedMode(visibleCodexCaller, { ...createArgs, settings: { modeId: "auto" } }),
  ).toBe("auto");
});

test("a remote child of another provider leaves its mode to the host", async () => {
  expect(await forwardedMode({ ...visibleCodexCaller, provider: "claude" })).toBeUndefined();
});

test("a remote create without a caller agent leaves its mode to the host", async () => {
  expect(await forwardedMode(null)).toBeUndefined();
});
