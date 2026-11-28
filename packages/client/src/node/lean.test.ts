import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { WSHelloRejectedMessageSchema } from "@getpaseo/protocol/messages";
import { HELLO_REJECTED_REASONS } from "@getpaseo/protocol/validation/message-defaults";
import {
  exportPublicKey,
  generateKeyPair,
  openDaemonSecureChannel,
  type Transport,
} from "@getpaseo/relay/e2ee";
import { leanProtocolCodec } from "../daemon-protocol-codec-lean.js";
import { strictProtocolCodec } from "../daemon-protocol-codec-strict.js";
import { createLeanHostClient } from "./lean.js";

function handleDirectServerConnection(ws: WebSocket): void {
  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString("utf8")) as {
      type: string;
      message?: { type: string; requestId?: string };
    };
    if (parsed.type === "hello") {
      ws.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "status",
            payload: {
              status: "server_info",
              serverId: "srv_lean_test",
              hostname: "lean-host",
              version: "0.18.1",
              features: { ownedSubscriptions: true, connectedHosts: true },
            },
          },
        }),
      );
      return;
    }
    if (parsed.type === "session" && parsed.message?.type === "hosts.list.request") {
      ws.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "hosts.list.response",
            payload: {
              requestId: parsed.message.requestId,
              directory: { hosts: [] },
            },
          },
        }),
      );
    }
  });
}

function createRelayWireTransport(ws: WebSocket): Transport {
  const transport: Transport = {
    send: (data) => {
      ws.send(data instanceof ArrayBuffer ? Buffer.from(data) : data);
    },
    close: (code, reason) => ws.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      transport.onmessage?.({ data: data.toString("utf8"), isBinary: false });
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    transport.onmessage?.({
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      isBinary: true,
    });
  });
  ws.on("close", (code, reason) => transport.onclose?.(code, reason.toString("utf8")));
  ws.on("error", (err) => transport.onerror?.(err));
  return transport;
}

async function handleRelayServerConnection(
  ws: WebSocket,
  daemonKeys: ReturnType<typeof generateKeyPair>,
): Promise<void> {
  const transport = createRelayWireTransport(ws);
  let secureChannel: Awaited<ReturnType<typeof openDaemonSecureChannel>> | null = null;
  secureChannel = await openDaemonSecureChannel(transport, {
    daemonKeyPair: daemonKeys,
    events: {
      onopen: () => {},
      onmessage: (data) => {
        const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
        const parsed = JSON.parse(text) as { type: string };
        if (parsed.type === "hello") {
          void secureChannel?.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "status",
                payload: {
                  status: "server_info",
                  serverId: "srv_relay_lean",
                  hostname: "relay-host",
                  version: "0.18.1",
                  features: { relayProtectedSecurity: true },
                },
              },
            }),
          );
        }
      },
      onclose: () => {},
      onerror: () => {},
    },
  });
}

describe("leanProtocolCodec", () => {
  it("matches strict parseServerInfo normalization for valid and invalid payloads", () => {
    const validCases: unknown[] = [
      {
        status: "server_info",
        serverId: "  srv_123  ",
        hostname: "  dev-box  ",
        version: " 0.18.1 ",
        protocolVersion: 2,
        desktopManaged: false,
        features: { ownedSubscriptions: true, relayProtectedSecurity: true },
        capabilities: {
          voice: {
            dictation: { enabled: true, reason: "ok" },
            voice: { enabled: false, reason: "disabled" },
          },
          extraCapability: true,
        },
        extraField: "kept",
      },
      {
        status: "server_info",
        serverId: "srv_minimal",
        hostname: "   ",
        version: null,
        capabilities: { voice: { dictation: "bad" } },
      },
    ];
    for (const payload of validCases) {
      expect(leanProtocolCodec.parseServerInfo(payload)).toEqual(
        strictProtocolCodec.parseServerInfo(payload),
      );
    }

    const invalidCases: unknown[] = [
      null,
      { status: "other", serverId: "srv_1" },
      { status: "server_info", serverId: "   " },
      { status: "server_info", serverId: "srv_1", protocolVersion: 1.5 },
    ];
    for (const payload of invalidCases) {
      expect(leanProtocolCodec.parseServerInfo(payload)).toBeNull();
      expect(strictProtocolCodec.parseServerInfo(payload)).toBeNull();
    }
  });

  it("validates outbound WS envelopes and rejects malformed frames", () => {
    expect([...HELLO_REJECTED_REASONS]).toEqual(WSHelloRejectedMessageSchema.shape.reason.options);
    expect(leanProtocolCodec.validateOutbound({ type: "pong" }).success).toBe(true);
    for (const reason of WSHelloRejectedMessageSchema.shape.reason.options) {
      expect(
        leanProtocolCodec.validateOutbound({
          type: "hello.rejected",
          reason,
          accepts: ["password"],
        }).success,
      ).toBe(true);
    }
    expect(
      leanProtocolCodec.validateOutbound({
        type: "session",
        message: { type: "status", payload: { status: "server_info", serverId: "srv_1" } },
      }).success,
    ).toBe(true);
    expect(leanProtocolCodec.validateOutbound({ type: "session", message: {} }).success).toBe(
      false,
    );
    expect(
      leanProtocolCodec.validateOutbound({ type: "hello.rejected", reason: "bogus" }).success,
    ).toBe(false);
    expect(leanProtocolCodec.validateOutbound({ type: "unknown" }).success).toBe(false);
  });

  it("applies protocol schema defaults matching strictProtocolCodec on outbound responses", () => {
    const legacyOutboundFrames: unknown[] = [
      {
        type: "session",
        message: {
          type: "get_providers_snapshot_response",
          payload: {
            requestId: "req_1",
            generatedAt: "2026-01-01T00:00:00.000Z",
            entries: [
              {
                provider: "claude",
                status: "ready",
                models: [],
                modes: [],
                thinkingOptions: [],
                supportsRuntimeModeChange: true,
                supportsRuntimeModelChange: true,
                supportsRuntimeThinkingChange: true,
              },
            ],
          },
        },
      },
      {
        type: "session",
        message: {
          type: "project.remove.response",
          payload: {
            requestId: "req_2",
            projectId: "proj_1",
            accepted: true,
            error: null,
          },
        },
      },
      {
        type: "session",
        message: {
          type: "fetch_workspaces_response",
          payload: {
            requestId: "req_3",
            entries: [
              {
                id: "ws_1",
                projectId: "proj_1",
                projectDisplayName: "repo",
                projectRootPath: "/repo",
                projectKind: "git",
                workspaceKind: "checkout",
                name: "main",
                status: "done",
                activityAt: "2026-01-01T00:00:00.000Z",
                gitRuntime: {
                  isGit: true,
                  currentBranch: "main",
                  isDirty: false,
                },
                githubRuntime: {
                  pr: null,
                },
                project: {
                  projectKey: "repo",
                  projectName: "repo",
                  checkout: {
                    cwd: "/repo",
                    isGit: true,
                    currentBranch: "main",
                    remoteUrl: null,
                    isPaseoOwnedWorktree: false,
                  },
                },
              },
              {
                id: "ws_2",
                projectId: "proj_2",
                projectDisplayName: "repo-scripts",
                projectRootPath: "/repo-scripts",
                projectKind: "non_git",
                workspaceKind: "directory",
                name: "repo-scripts",
                status: "done",
                activityAt: "2026-01-01T00:00:00.000Z",
                scripts: [
                  {
                    scriptName: "dev",
                    hostname: "localhost",
                    port: 3000,
                    lifecycle: "stopped",
                    health: null,
                  },
                ],
                gitRuntime: {
                  isGit: false,
                  currentBranch: null,
                  isDirty: false,
                },
                githubRuntime: {
                  pr: null,
                },
                project: {
                  projectKey: "repo-scripts",
                  projectName: "repo-scripts",
                  checkout: {
                    cwd: "/repo-scripts",
                    isGit: false,
                    currentBranch: null,
                    remoteUrl: null,
                    isPaseoOwnedWorktree: false,
                    mainRepoRoot: null,
                  },
                },
              },
            ],
            pageInfo: {
              nextCursor: null,
              prevCursor: null,
              hasMore: false,
            },
          },
        },
      },
      {
        type: "session",
        message: {
          type: "fetch_agents_response",
          payload: {
            requestId: "req_4",
            entries: [
              {
                agent: {
                  id: "agent_1",
                  provider: "claude",
                  cwd: "/repo",
                  model: "claude-sonnet",
                  status: "idle",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  lastActivityAt: "2026-01-01T00:00:00.000Z",
                  lastUserMessageAt: null,
                  capabilities: {
                    supportsStreaming: true,
                    supportsSessionPersistence: true,
                    supportsDynamicModes: true,
                    supportsMcpServers: false,
                    supportsReasoningStream: false,
                    supportsToolInvocations: true,
                  },
                  currentModeId: null,
                  availableModes: [],
                  pendingPermissions: [
                    {
                      id: "perm_1",
                      provider: "claude",
                      name: "setup",
                      kind: "tool",
                      detail: {
                        type: "worktree_setup",
                        branchName: "feat/test",
                        worktreePath: "/repo-wt",
                        log: "",
                        commands: [
                          {
                            index: 1,
                            command: "npm ci",
                            cwd: "/repo-wt",
                            status: "running",
                            exitCode: null,
                          },
                        ],
                      },
                    },
                  ],
                  persistence: null,
                  title: null,
                  requiresAttention: false,
                  attentionReason: null,
                  attentionTimestamp: null,
                  archivedAt: null,
                },
                project: {
                  projectKey: "repo",
                  projectName: "repo",
                  checkout: {
                    cwd: "/repo",
                    isGit: true,
                    currentBranch: "main",
                    remoteUrl: null,
                    isPaseoOwnedWorktree: false,
                  },
                },
              },
            ],
            pageInfo: {
              nextCursor: null,
              prevCursor: null,
              hasMore: false,
            },
          },
        },
      },
      {
        type: "session",
        message: {
          type: "checkout_pr_status_response",
          payload: {
            requestId: "req_5",
            cwd: "/repo",
            githubFeaturesEnabled: true,
            status: {
              number: 42,
              url: "https://github.com/getpaseo/paseo/pull/42",
              title: "Test PR",
              state: "OPEN",
              isMerged: false,
              baseRefName: "main",
              headRefName: "feat/test",
              github: {},
            },
            error: null,
          },
        },
      },
      {
        type: "session",
        message: {
          type: "pull_request_timeline_response",
        },
      },
    ];

    for (const frame of legacyOutboundFrames) {
      const lean = leanProtocolCodec.validateOutbound(structuredClone(frame));
      const strict = strictProtocolCodec.validateOutbound(structuredClone(frame));
      expect(strict.success).toBe(true);
      expect(lean.success).toBe(true);
      if (lean.success && strict.success) {
        expect(lean.data).toEqual(strict.data);
      }
    }

    // Mutating a defaulted array/object on one parsed message must not leak into the next.
    const first = leanProtocolCodec.validateOutbound({
      type: "session",
      message: {
        type: "project.remove.response",
        payload: { requestId: "r1", projectId: "p1", accepted: true, error: null },
      },
    });
    const second = leanProtocolCodec.validateOutbound({
      type: "session",
      message: {
        type: "project.remove.response",
        payload: { requestId: "r2", projectId: "p1", accepted: true, error: null },
      },
    });
    expect(first.success && second.success).toBe(true);
    if (first.success && second.success) {
      const firstIds = (first.data as { message: { payload: { removedWorkspaceIds: string[] } } })
        .message.payload.removedWorkspaceIds;
      const secondIds = (second.data as { message: { payload: { removedWorkspaceIds: string[] } } })
        .message.payload.removedWorkspaceIds;
      firstIds.push("mutated");
      expect(secondIds).toEqual([]);
    }
  });

  it("applies protocol schema defaults matching strictProtocolCodec on inbound and status payloads", () => {
    const inboundCases: unknown[] = [
      {
        type: "create_agent_request",
        config: { provider: "claude", cwd: "/repo" },
        requestId: "req_in_1",
      },
      {
        type: "capture_terminal_request",
        terminalId: "term_1",
        requestId: "req_in_2",
      },
      {
        type: "close_items_request",
        requestId: "req_in_3",
      },
      {
        type: "paseo_worktree_archive_request",
        worktreePath: "/repo-wt",
        requestId: "req_in_4",
      },
      {
        type: "client_heartbeat",
        deviceType: "web",
        appVisible: true,
        focusedAgentId: null,
        lastActivityAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    for (const message of inboundCases) {
      expect(leanProtocolCodec.parseInbound(structuredClone(message))).toEqual(
        strictProtocolCodec.parseInbound(structuredClone(message)),
      );
    }

    const legacyAgentSnapshot = {
      id: "agent_created_1",
      provider: "claude",
      cwd: "/repo",
      model: "claude-sonnet",
      status: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastUserMessageAt: null,
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null,
    };
    const agentCreatedStatus = {
      status: "agent_created",
      agentId: "agent_created_1",
      requestId: "req_status_1",
      agent: legacyAgentSnapshot,
    };

    expect(leanProtocolCodec.parseAgentSnapshot(structuredClone(legacyAgentSnapshot))).toEqual(
      strictProtocolCodec.parseAgentSnapshot(structuredClone(legacyAgentSnapshot)),
    );
    expect(leanProtocolCodec.parseAgentCreatedStatus(structuredClone(agentCreatedStatus))).toEqual(
      strictProtocolCodec.parseAgentCreatedStatus(structuredClone(agentCreatedStatus)),
    );
  });
});

describe("createLeanHostClient", () => {
  it("completes a direct TCP handshake and RPC without loading strict validators or relay", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const address = wss.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    wss.on("connection", handleDirectServerConnection);

    const client = createLeanHostClient(`127.0.0.1:${address.port}`, {
      clientId: "cid_lean_test",
      clientType: "cli",
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.serverId).toBe("srv_lean_test");
      const hosts = await client.listHosts();
      expect(hosts.hosts).toEqual([]);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("loads relay E2EE lazily when connecting to a pairing offer", async () => {
    const daemonKeys = generateKeyPair();
    const daemonPublicKeyB64 = exportPublicKey(daemonKeys.publicKey);
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const address = wss.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    wss.on("connection", (ws) => {
      void handleRelayServerConnection(ws, daemonKeys);
    });

    const offerUrl = `relay://127.0.0.1:${address.port}/srv_relay_lean?key=${encodeURIComponent(daemonPublicKeyB64)}`;
    const client = createLeanHostClient(offerUrl, {
      clientId: "cid_relay_lean_test",
      clientType: "cli",
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.serverId).toBe("srv_relay_lean");
    } finally {
      await client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
