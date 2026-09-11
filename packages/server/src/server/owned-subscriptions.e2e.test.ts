import { MockLoadTestAgentClient } from "./agent/providers/mock-load-test-agent.js";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import type { z } from "zod";
import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "node:http";
import {
  decodeTerminalStreamFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  TerminalStreamOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import {
  SessionInboundMessageSchema,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type WSOutboundMessage,
} from "./messages.js";

class SubscriptionPeer {
  readonly frames: WSOutboundMessage[] = [];
  readonly binaryFrames: Uint8Array[] = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data, binary) => {
      if (!binary) this.frames.push(JSON.parse(data.toString()));
      else this.binaryFrames.push(new Uint8Array(data as Buffer));
    });
  }

  static async connect(
    port: number,
    clientId: string,
    capabilities: Record<string, unknown> = {},
  ): Promise<SubscriptionPeer> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const peer = new SubscriptionPeer(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        clientType: "browser",
        clientId,
        protocolVersion: 1,
        appVersion: "0.8.0",
        capabilities: { owned_subscriptions: true, ...capabilities },
      }),
    );
    await expect
      .poll(() =>
        peer.frames.some(
          (frame) =>
            frame.type === "session" &&
            frame.message.type === "status" &&
            frame.message.payload.status === "server_info",
        ),
      )
      .toBe(true);
    peer.frames.length = 0;
    return peer;
  }

  async request(message: z.input<typeof SessionInboundMessageSchema>): Promise<void> {
    this.socket.send(JSON.stringify({ type: "session", message }));
    await expect
      .poll(() =>
        this.frames.some(
          (frame) =>
            frame.type === "session" &&
            "payload" in frame.message &&
            "requestId" in frame.message.payload &&
            "requestId" in message &&
            frame.message.payload.requestId === message.requestId,
        ),
      )
      .toBe(true);
  }

  send(message: z.input<typeof SessionInboundMessageSchema>): void {
    this.socket.send(
      JSON.stringify({ type: "session", message: SessionInboundMessageSchema.parse(message) }),
    );
  }

  upload(requestId: string, text: string, fileName: string): void {
    this.socket.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId,
        metadata: {
          mime: "text/plain",
          size: new TextEncoder().encode(text).byteLength,
          encoding: "binary",
          modifiedAt: "2026-09-09T00:00:00Z",
          fileName,
        },
      }),
    );
    this.socket.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId,
        payload: new TextEncoder().encode(text),
      }),
    );
    this.socket.send(encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }));
  }

  close(): void {
    this.socket.terminate();
  }
}

test("a pure list reply belongs only to its source socket in a shared logical session", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const peers: SubscriptionPeer[] = [];
  try {
    const idle = await SubscriptionPeer.connect(daemon.port, "shared-owned-session");
    peers.push(idle);
    const reader = await SubscriptionPeer.connect(daemon.port, "shared-owned-session");
    peers.push(reader);
    await reader.request({ type: "fetch_agents_request", requestId: "reader-snapshot" });
    await idle.request({ type: "ping", requestId: "idle-barrier", clientSentAt: 1 });
    expect(
      idle.frames.filter(
        (frame) => frame.type === "session" && frame.message.type === "fetch_agents_response",
      ),
    ).toEqual([]);
  } finally {
    for (const peer of peers) peer.close();
    await daemon.close();
  }
});

test("combined filtered agent lists create independent server-owned observations", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  let peer: SubscriptionPeer | undefined;
  try {
    await admin.connect();
    const agent = await admin.createAgent({
      provider: "codex",
      cwd: daemon.staticDir,
      title: "Before",
    });
    peer = await SubscriptionPeer.connect(daemon.port, "independent-agent-views");
    await peer.request({ type: "fetch_agents_request", requestId: "all", subscribe: {} });
    await peer.request({
      type: "fetch_agents_request",
      requestId: "filtered",
      filter: { labels: { role: "orchestrator" } },
      subscribe: {},
    });
    const snapshots = peer.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "fetch_agents_response"
        ? [frame.message.payload]
        : [],
    );
    expect(snapshots).toHaveLength(2);
    const [all, filtered] = snapshots;
    expect(typeof all.subscriptionId).toBe("string");
    expect(typeof filtered.subscriptionId).toBe("string");
    expect(all.subscriptionId).not.toBe(filtered.subscriptionId);
    await admin.updateAgent(agent.id, { name: "After" });
    await expect
      .poll(
        () =>
          peer!.frames.flatMap((frame) =>
            frame.type === "session" && frame.message.type === "agent_update"
              ? [frame.message.payload]
              : [],
          ),
        { timeout: 5000 },
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subscriptionId: all.subscriptionId,
            kind: "upsert",
            agent: expect.objectContaining({ id: agent.id, title: "After" }),
          }),
          expect.objectContaining({
            subscriptionId: filtered.subscriptionId,
            kind: "remove",
            agentId: agent.id,
          }),
        ]),
      );
    await peer.request({
      type: "subscription.release.request",
      requestId: "release-filtered",
      subscriptionId: filtered.subscriptionId!,
    });
    peer.frames.length = 0;
    await admin.updateAgent(agent.id, { name: "Still observed" });
    await expect
      .poll(
        () =>
          peer!.frames.flatMap((frame) =>
            frame.type === "session" && frame.message.type === "agent_update"
              ? [frame.message.payload]
              : [],
          ),
        { timeout: 5000 },
      )
      .toEqual([
        expect.objectContaining({
          subscriptionId: all.subscriptionId,
          kind: "upsert",
          agent: expect.objectContaining({ id: agent.id, title: "Still observed" }),
        }),
      ]);
  } finally {
    peer?.close();
    await admin.close();
    await daemon.close();
  }
});

test("workspace filters and identical queries coexist until their own release", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  let peer: SubscriptionPeer | undefined;
  try {
    await admin.connect();
    const aDir = path.join(daemon.staticDir, "a");
    const bDir = path.join(daemon.staticDir, "b");
    await mkdir(aDir);
    await mkdir(bDir);
    const a = (await admin.createWorkspace({ source: { kind: "directory", path: aDir } }))
      .workspace!;
    const b = (await admin.createWorkspace({ source: { kind: "directory", path: bDir } }))
      .workspace!;
    peer = await SubscriptionPeer.connect(daemon.port, "independent-workspace-views");
    await peer.request({
      type: "fetch_workspaces_request",
      requestId: "a",
      filter: { projectId: a.projectId },
      subscribe: {},
    });
    await peer.request({
      type: "fetch_workspaces_request",
      requestId: "b",
      filter: { projectId: b.projectId },
      subscribe: {},
    });
    await peer.request({
      type: "fetch_workspaces_request",
      requestId: "b-copy",
      filter: { projectId: b.projectId },
      subscribe: {},
    });
    const snapshots = peer.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "fetch_workspaces_response"
        ? [frame.message.payload]
        : [],
    );
    expect(snapshots).toHaveLength(3);
    const ids = snapshots.map((snapshot) => snapshot.subscriptionId!);
    expect(new Set(ids).size).toBe(3);
    await peer.request({
      type: "subscription.release.request",
      requestId: "release-b",
      subscriptionId: ids[1],
    });
    await admin.setWorkspaceTitle(a.id, "A updated");
    await admin.setWorkspaceTitle(b.id, "B updated");
    await expect
      .poll(
        () =>
          peer!.frames.flatMap((frame) =>
            frame.type === "session" && frame.message.type === "workspace_update"
              ? [frame.message.payload]
              : [],
          ),
        { timeout: 5000 },
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subscriptionId: ids[0],
            kind: "upsert",
            workspace: expect.objectContaining({ id: a.id, name: "A updated" }),
          }),
          expect.objectContaining({
            subscriptionId: ids[2],
            kind: "upsert",
            workspace: expect.objectContaining({ id: b.id, name: "B updated" }),
          }),
        ]),
      );
    expect(
      peer.frames.filter(
        (frame) =>
          frame.type === "session" &&
          frame.message.type === "workspace_update" &&
          "subscriptionId" in frame.message.payload &&
          frame.message.payload.subscriptionId === ids[1],
      ),
    ).toEqual([]);
  } finally {
    peer?.close();
    await admin.close();
    await daemon.close();
  }
});

test("label lists are pure and label observers have independent lifetimes", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  let peer: SubscriptionPeer | undefined;
  try {
    await admin.connect();
    const workspace = (
      await admin.createWorkspace({ source: { kind: "directory", path: daemon.staticDir } })
    ).workspace!;
    peer = await SubscriptionPeer.connect(daemon.port, "label-views");
    await peer.request({ type: "workspace.label.list.request", requestId: "plain" });
    await peer.request({ type: "workspace.label.list.request", requestId: "first", subscribe: {} });
    await peer.request({
      type: "workspace.label.list.request",
      requestId: "second",
      subscribe: {},
    });
    const snapshots = peer.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "workspace.label.list.response"
        ? [frame.message.payload]
        : [],
    );
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).not.toHaveProperty("subscriptionId");
    const first = snapshots[1] as (typeof snapshots)[number] & { subscriptionId: string };
    const second = snapshots[2] as (typeof snapshots)[number] & { subscriptionId: string };
    expect(typeof first.subscriptionId).toBe("string");
    expect(first.subscriptionId).not.toBe(second.subscriptionId);
    await peer.request({
      type: "subscription.release.request",
      requestId: "release",
      subscriptionId: first.subscriptionId,
    });
    peer.frames.length = 0;
    await peer.request({
      type: "workspace.label.assignment.set.request",
      requestId: "assign",
      workspaceId: workspace.id,
      label: { name: "QA", color: "blue" },
      assigned: true,
    });
    await expect
      .poll(() =>
        peer!.frames.flatMap((frame) =>
          frame.type === "session" && frame.message.type === "workspace.label.update"
            ? [frame.message.payload]
            : [],
        ),
      )
      .toEqual([
        expect.objectContaining({
          kind: "upsert",
          subscriptionId: second.subscriptionId,
          label: { name: "QA", color: "blue" },
        }),
      ]);
  } finally {
    peer?.close();
    await admin.close();
    await daemon.close();
  }
});

test("identical file observations get server IDs and release independently", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  let peer: SubscriptionPeer | undefined;
  try {
    await writeFile(path.join(daemon.staticDir, "observed.txt"), "before");
    peer = await SubscriptionPeer.connect(daemon.port, "file-observers");
    await peer.request({
      type: "fs.file.subscribe.request",
      requestId: "file-a",
      cwd: daemon.staticDir,
      path: "observed.txt",
    });
    await peer.request({
      type: "fs.file.subscribe.request",
      requestId: "file-b",
      cwd: daemon.staticDir,
      path: "observed.txt",
    });
    const snapshots = peer.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "fs.file.subscribe.response"
        ? [frame.message.payload]
        : [],
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].subscriptionId).not.toBe(snapshots[1].subscriptionId);
    await peer.request({
      type: "subscription.release.request",
      requestId: "release-file-a",
      subscriptionId: snapshots[0].subscriptionId,
    });
    peer.frames.length = 0;
    await writeFile(path.join(daemon.staticDir, "observed.txt"), "after");
    await expect
      .poll(
        () =>
          peer!.frames.flatMap((frame) =>
            frame.type === "session" && frame.message.type === "fs.file.update"
              ? [frame.message.payload]
              : [],
          ),
        { timeout: 5000 },
      )
      .toEqual([
        expect.objectContaining({
          subscriptionId: snapshots[1].subscriptionId,
          version: expect.objectContaining({ status: "ready" }),
        }),
      ]);
  } finally {
    peer?.close();
    await daemon.close();
  }
});

test("checkout diff reads are snapshots and identical observers release independently", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  let peer: SubscriptionPeer | undefined;
  try {
    const cwd = daemon.staticDir;
    execFileSync("git", ["init", "-q", "--initial-branch=main", cwd]);
    await writeFile(path.join(cwd, "tracked.txt"), "before\n");
    execFileSync("git", ["-C", cwd, "add", "tracked.txt"]);
    execFileSync("git", [
      "-C",
      cwd,
      "-c",
      "user.name=QA",
      "-c",
      "user.email=qa@example.invalid",
      "commit",
      "-qm",
      "Initial",
    ]);
    peer = await SubscriptionPeer.connect(daemon.port, "diff-observers");
    await peer.request({
      type: "checkout.diff.get.request",
      requestId: "read",
      cwd,
      compare: { mode: "uncommitted" },
    });
    await peer.request({
      type: "subscribe_checkout_diff_request",
      requestId: "diff-a",
      cwd,
      compare: { mode: "uncommitted" },
    });
    await peer.request({
      type: "subscribe_checkout_diff_request",
      requestId: "diff-b",
      cwd,
      compare: { mode: "uncommitted" },
    });
    const snapshots = peer.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "subscribe_checkout_diff_response"
        ? [frame.message.payload]
        : [],
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].subscriptionId).not.toBe(snapshots[1].subscriptionId);
    await peer.request({
      type: "subscription.release.request",
      requestId: "release-diff-a",
      subscriptionId: snapshots[0].subscriptionId,
    });
    peer.frames.length = 0;
    await writeFile(path.join(cwd, "tracked.txt"), "after\n");
    await expect
      .poll(
        () =>
          peer!.frames.flatMap((frame) =>
            frame.type === "session" &&
            frame.message.type === "checkout_diff_update" &&
            frame.message.payload.files.length > 0
              ? [frame.message.payload]
              : [],
          ),
        { timeout: 10000 },
      )
      .toEqual([
        expect.objectContaining({
          subscriptionId: snapshots[1].subscriptionId,
          error: null,
          files: [expect.objectContaining({ path: "tracked.txt" })],
        }),
      ]);
  } finally {
    peer?.close();
    await daemon.close();
  }
});

test("event-category observations use independent IDs without enabling other categories", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  let peer: SubscriptionPeer | undefined;
  try {
    await admin.connect();
    peer = await SubscriptionPeer.connect(daemon.port, "event-observers");
    await peer.request({
      type: "session.events.set_subscription.request",
      requestId: "events-a",
      events: ["project.update"],
    });
    await peer.request({
      type: "session.events.set_subscription.request",
      requestId: "events-b",
      events: ["project.update"],
    });
    const snapshots = peer.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "session.events.set_subscription.response"
        ? [frame.message.payload]
        : [],
    );
    expect(snapshots).toHaveLength(2);
    const ids = snapshots.map(
      (snapshot) => (snapshot as typeof snapshot & { subscriptionId: string }).subscriptionId,
    );
    expect(ids.every((id) => typeof id === "string")).toBe(true);
    expect(ids[0]).not.toBe(ids[1]);
    await peer.request({
      type: "subscription.release.request",
      requestId: "release-events-a",
      subscriptionId: ids[0],
    });
    peer.frames.length = 0;
    await admin.createWorkspace({ source: { kind: "directory", path: daemon.staticDir } });
    await expect
      .poll(
        () =>
          peer!.frames.flatMap((frame) =>
            frame.type === "session" && frame.message.type === "project.update"
              ? [frame.message.payload]
              : [],
          ),
        { timeout: 5000 },
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ subscriptionId: ids[1], kind: "upsert" }),
        ]),
      );
    expect(
      peer.frames.filter(
        (frame) => frame.type === "session" && frame.message.type !== "project.update",
      ),
    ).toEqual([]);
  } finally {
    peer?.close();
    await admin.close();
    await daemon.close();
  }
});

test("timeline observers for the same agent survive an independent release", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  let peer: SubscriptionPeer | undefined;
  try {
    await admin.connect();
    const agent = await admin.createAgent({
      provider: "codex",
      cwd: daemon.staticDir,
      title: "Timeline",
    });
    peer = await SubscriptionPeer.connect(daemon.port, "timeline-observers");
    await peer.request({
      type: "agent.timeline.set_subscription.request",
      requestId: "timeline-a",
      agentIds: [agent.id],
    });
    await peer.request({
      type: "agent.timeline.set_subscription.request",
      requestId: "timeline-b",
      agentIds: [agent.id],
    });
    const snapshots = peer.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "agent.timeline.set_subscription.response"
        ? [frame.message.payload]
        : [],
    );
    expect(snapshots).toHaveLength(2);
    const ids = snapshots.map(
      (snapshot) => (snapshot as typeof snapshot & { subscriptionId: string }).subscriptionId,
    );
    expect(ids.every((id) => typeof id === "string")).toBe(true);
    expect(ids[0]).not.toBe(ids[1]);
    await peer.request({
      type: "subscription.release.request",
      requestId: "release-timeline-a",
      subscriptionId: ids[0],
    });
    peer.frames.length = 0;
    await admin.sendMessage(agent.id, "An observed turn");
    await expect
      .poll(
        () =>
          peer!.frames.filter(
            (frame) => frame.type === "session" && frame.message.type === "agent_stream",
          ).length,
        { timeout: 5000 },
      )
      .toBeGreaterThan(0);
    const updates = peer.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "agent_stream"
        ? [frame.message.payload]
        : [],
    );
    expect(
      updates.every(
        (update) =>
          "subscriptionId" in update &&
          update.subscriptionId === ids[1] &&
          update.agentId === agent.id,
      ),
    ).toBe(true);
  } finally {
    peer?.close();
    await admin.close();
    await daemon.close();
  }
});

test("same-workspace terminal directory observers do not share a teardown slot", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  let peer: SubscriptionPeer | undefined;
  try {
    await admin.connect();
    const workspace = (
      await admin.createWorkspace({ source: { kind: "directory", path: daemon.staticDir } })
    ).workspace!;
    peer = await SubscriptionPeer.connect(daemon.port, "terminal-directory-observers");
    await peer.request({
      type: "subscribe_terminals_request",
      requestId: "terminals-a",
      cwd: daemon.staticDir,
      workspaceId: workspace.id,
    });
    await peer.request({
      type: "subscribe_terminals_request",
      requestId: "terminals-b",
      cwd: daemon.staticDir,
      workspaceId: workspace.id,
    });
    const snapshots = peer.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "terminals_changed"
        ? [frame.message.payload]
        : [],
    );
    expect(snapshots).toHaveLength(2);
    const ids = snapshots.map(
      (snapshot) => (snapshot as typeof snapshot & { subscriptionId: string }).subscriptionId,
    );
    expect(ids.every((id) => typeof id === "string")).toBe(true);
    expect(ids[0]).not.toBe(ids[1]);
    await peer.request({
      type: "subscription.release.request",
      requestId: "release-terminals-a",
      subscriptionId: ids[0],
    });
    peer.frames.length = 0;
    const result = await admin.createTerminal(daemon.staticDir, "Observed terminal", undefined, {
      workspaceId: workspace.id,
      command: "/bin/cat",
    });
    expect(result.error).toBe(null);
    await expect
      .poll(
        () =>
          peer!.frames.flatMap((frame) =>
            frame.type === "session" && frame.message.type === "terminals_changed"
              ? [frame.message.payload]
              : [],
          ),
        { timeout: 5000 },
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subscriptionId: ids[1],
            workspaceId: workspace.id,
            terminals: [expect.objectContaining({ id: result.terminal!.id })],
          }),
        ]),
      );
    const updates = peer.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "terminals_changed"
        ? [frame.message.payload]
        : [],
    );
    expect(
      updates.every((update) => "subscriptionId" in update && update.subscriptionId === ids[1]),
    ).toBe(true);
    await admin.killTerminal(result.terminal!.id);
  } finally {
    peer?.close();
    await admin.close();
    await daemon.close();
  }
});

test("terminal output has separate server IDs and binary slots, including in a shared session", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const peers: SubscriptionPeer[] = [];
  try {
    await admin.connect();
    const workspace = (
      await admin.createWorkspace({ source: { kind: "directory", path: daemon.staticDir } })
    ).workspace!;
    const result = await admin.createTerminal(daemon.staticDir, "Output ownership", undefined, {
      workspaceId: workspace.id,
      command: "/bin/cat",
    });
    expect(result.error).toBe(null);
    const idle = await SubscriptionPeer.connect(daemon.port, "terminal-output-session");
    peers.push(idle);
    const peer = await SubscriptionPeer.connect(daemon.port, "terminal-output-session");
    peers.push(peer);
    for (const requestId of ["output-a", "output-b"]) {
      await peer.request({
        type: "subscribe_terminal_request",
        requestId,
        terminalId: result.terminal!.id,
      });
    }
    const replies = peer.frames.flatMap((frame) =>
      frame.type === "session" &&
      frame.message.type === "subscribe_terminal_response" &&
      frame.message.payload.error === null
        ? [frame.message.payload]
        : [],
    );
    expect(replies).toHaveLength(2);
    const ids = replies.map(
      (reply) => (reply as typeof reply & { subscriptionId: string }).subscriptionId,
    );
    expect(ids.every((id) => typeof id === "string")).toBe(true);
    expect(ids[0]).not.toBe(ids[1]);
    expect(replies[0].slot).not.toBe(replies[1].slot);
    await expect
      .poll(() =>
        peer.binaryFrames
          .map(decodeTerminalStreamFrame)
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.Snapshot)
          .map((frame) => frame!.slot),
      )
      .toEqual(expect.arrayContaining(replies.map((reply) => reply.slot)));
    expect(idle.binaryFrames).toEqual([]);
    await peer.request({
      type: "subscription.release.request",
      requestId: "release-output-a",
      subscriptionId: ids[0],
    });
    peer.binaryFrames.length = 0;
    admin.sendTerminalInput(result.terminal!.id, { type: "input", data: "remaining-observer\n" });
    await expect
      .poll(
        () =>
          peer.binaryFrames
            .map(decodeTerminalStreamFrame)
            .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
            .map((frame) => Buffer.from(frame!.payload).toString())
            .join(""),
        { timeout: 5000 },
      )
      .toContain("remaining-observer");
    expect(
      peer.binaryFrames
        .map(decodeTerminalStreamFrame)
        .every((frame) => frame?.slot === replies[1].slot),
    ).toBe(true);
    expect(idle.binaryFrames).toEqual([]);
    await admin.killTerminal(result.terminal!.id);
  } finally {
    for (const peer of peers) peer.close();
    await admin.close();
    await daemon.close();
  }
});

test("a modern connection and pure reads retain no client observation producers", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  let peer: SubscriptionPeer | undefined;
  try {
    peer = await SubscriptionPeer.connect(daemon.port, "no-demand-producers");
    await peer.request({ type: "fetch_agents_request", requestId: "plain-agents" });
    await peer.request({ type: "fetch_workspaces_request", requestId: "plain-workspaces" });
    await peer.request({ type: "workspace.label.list.request", requestId: "plain-labels" });
    await peer.request({ type: "list_terminals_request", requestId: "plain-terminals" });
    await peer.request({ type: "diagnostics.request", requestId: "producer-diagnostics" });
    const diagnostic = peer.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "diagnostics.response"
        ? [frame.message.payload.diagnostic]
        : [],
    )[0];
    expect(diagnostic).toContain("Session observations");
    expect(diagnostic).toContain("Registrations: 0");
    expect(diagnostic).toContain("Producer listeners: 0");
    expect(diagnostic).toContain("Git observations: 0");
  } finally {
    peer?.close();
    await daemon.close();
  }
});

test("config changes require their own event demand and cannot escape to an idle socket", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const peers: SubscriptionPeer[] = [];
  try {
    await admin.connect();
    const idle = await SubscriptionPeer.connect(daemon.port, "config-session");
    peers.push(idle);
    const observer = await SubscriptionPeer.connect(daemon.port, "config-session");
    peers.push(observer);
    await observer.request({
      type: "session.events.set_subscription.request",
      requestId: "config-feed",
      events: ["status.daemon_config_changed"],
    });
    await admin.patchDaemonConfig({ autoArchiveAfterMerge: true });
    await expect
      .poll(() =>
        observer.frames.some(
          (frame) =>
            frame.type === "session" &&
            frame.message.type === "status" &&
            frame.message.payload.status === "daemon_config_changed",
        ),
      )
      .toBe(true);
    expect(idle.frames).toEqual([]);
    const changes = observer.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "status" ? [frame.message.payload] : [],
    );
    expect(
      changes.every(
        (change) =>
          change.status === "daemon_config_changed" && typeof change.subscriptionId === "string",
      ),
    ).toBe(true);
  } finally {
    for (const peer of peers) peer.close();
    await admin.close();
    await daemon.close();
  }
});

test("status-shaped operation replies use actual source request provenance", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const peers: SubscriptionPeer[] = [];
  try {
    const idle = await SubscriptionPeer.connect(daemon.port, "status-reply-session");
    peers.push(idle);
    const actor = await SubscriptionPeer.connect(daemon.port, "status-reply-session");
    peers.push(actor);
    await actor.request({
      type: "create_agent_request",
      requestId: "created-status",
      config: { provider: "codex", cwd: daemon.staticDir },
    });
    expect(actor.frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session",
          message: expect.objectContaining({
            type: "status",
            payload: expect.objectContaining({
              status: "agent_created",
              requestId: "created-status",
            }),
          }),
        }),
      ]),
    );
    expect(idle.frames).toEqual([]);
    await actor.request({ type: "schedule/list", requestId: "schedule-list" });
    expect(idle.frames).toEqual([]);
  } finally {
    for (const peer of peers) peer.close();
    await daemon.close();
  }
});

test("browser capability advertisement is passive and explicit hosts own command delivery", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const peers: SubscriptionPeer[] = [];
  try {
    const capability = { hostKind: "QA browser", supportedCommands: ["list_tabs"] };
    const idle = await SubscriptionPeer.connect(daemon.port, "browser-host-session", {
      browser_host: capability,
    });
    peers.push(idle);
    expect(daemon.daemon.browserToolsBroker.getRegisteredClientCount()).toBe(0);
    const host = await SubscriptionPeer.connect(daemon.port, "browser-host-session", {
      browser_host: capability,
    });
    peers.push(host);
    await host.request({
      type: "browser.host.register.request",
      requestId: "host-register",
      hostKind: capability.hostKind,
      supportedCommands: ["list_tabs"],
    });
    expect(daemon.daemon.browserToolsBroker.getRegisteredClientCount()).toBe(1);
    const pending = daemon.daemon.browserToolsBroker.execute({
      command: { command: "list_tabs", args: {} },
    });
    await expect
      .poll(() =>
        host.frames.some(
          (frame) =>
            frame.type === "session" && frame.message.type === "browser.automation.execute.request",
        ),
      )
      .toBe(true);
    expect(idle.frames).toEqual([]);
    const registration = host.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "browser.host.register.response"
        ? [frame.message.payload]
        : [],
    )[0];
    await host.request({
      type: "subscription.release.request",
      requestId: "release-host",
      subscriptionId: registration.subscriptionId,
    });
    expect(daemon.daemon.browserToolsBroker.getRegisteredClientCount()).toBe(0);
    expect(daemon.daemon.browserToolsBroker.getPendingRequestCount()).toBe(0);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "browser_no_host" } });
  } finally {
    for (const peer of peers) peer.close();
    await daemon.close();
  }
});

test("adding public SDK listeners does not create server observation demand", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.8.0",
    capabilities: { owned_subscriptions: true },
  });
  try {
    await client.connect();
    const off = client.on("project.update", () => {});
    const all = client.subscribe(() => {});
    await client.ping();
    const { diagnostic } = await client.collectDiagnostics();
    expect(diagnostic).toContain("Registrations: 0");
    expect(diagnostic).toContain("Producer listeners: 0");
    off();
    all();
  } finally {
    await client.close();
    await daemon.close();
  }
});

test("upload operations with identical request IDs belong to their source sockets", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const peers: SubscriptionPeer[] = [];
  try {
    const a = await SubscriptionPeer.connect(daemon.port, "upload-shared-session");
    peers.push(a);
    const b = await SubscriptionPeer.connect(daemon.port, "upload-shared-session");
    peers.push(b);
    const idle = await SubscriptionPeer.connect(daemon.port, "upload-shared-session");
    peers.push(idle);
    a.send({
      type: "file.upload.request",
      requestId: "same-upload",
      fileName: "a.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-09-09T00:00:00Z",
    });
    b.send({
      type: "file.upload.request",
      requestId: "same-upload",
      fileName: "b.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-09-09T00:00:00Z",
    });
    await a.request({ type: "ping", requestId: "a-upload-begun", clientSentAt: 1 });
    await b.request({ type: "ping", requestId: "b-upload-begun", clientSentAt: 1 });
    a.upload("same-upload", "alpha", "a.txt");
    b.upload("same-upload", "bravo", "b.txt");
    const uploads = (peer: SubscriptionPeer) =>
      peer.frames.flatMap((frame) =>
        frame.type === "session" && frame.message.type === "file.upload.response"
          ? [frame.message.payload]
          : [],
      );
    await expect
      .poll(() => uploads(a))
      .toEqual([
        expect.objectContaining({
          error: null,
          file: expect.objectContaining({ fileName: "a.txt" }),
        }),
      ]);
    await expect
      .poll(() => uploads(b))
      .toEqual([
        expect.objectContaining({
          error: null,
          file: expect.objectContaining({ fileName: "b.txt" }),
        }),
      ]);
    expect(uploads(a)[0]?.file?.id).not.toBe(uploads(b)[0]?.file?.id);
    expect(uploads(idle)).toEqual([]);
  } finally {
    peers.forEach((peer) => peer.close());
    await daemon.close();
  }
});

test("notification ownership is separate from data demand and another socket's focus", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const peers: SubscriptionPeer[] = [];
  try {
    await admin.connect();
    const workspace = (
      await admin.createWorkspace({ source: { kind: "directory", path: daemon.staticDir } })
    ).workspace;
    if (!workspace) throw new Error("Workspace creation failed");
    const agent = await admin.createAgent({
      provider: "codex",
      cwd: daemon.staticDir,
      workspaceId: workspace.id,
      title: "Attention",
    });
    const observer = await SubscriptionPeer.connect(daemon.port, "attention-sources");
    const passive = await SubscriptionPeer.connect(daemon.port, "attention-sources");
    peers.push(observer, passive);
    for (const requestId of ["data-a", "data-b", "notifications"]) {
      await observer.request({
        type: "session.events.set_subscription.request",
        requestId,
        events: ["agent_attention_required"],
        notifications: requestId === "notifications",
      });
    }
    const snapshots = observer.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "session.events.set_subscription.response"
        ? [frame.message.payload]
        : [],
    );
    const notificationId = snapshots.find(
      (snapshot) => snapshot.requestId === "notifications",
    )!.subscriptionId;
    observer.send({
      type: "client_heartbeat",
      deviceType: "web",
      focusedAgentId: null,
      lastActivityAt: new Date().toISOString(),
      appVisible: true,
    });
    passive.send({
      type: "client_heartbeat",
      deviceType: "web",
      focusedAgentId: agent.id,
      lastActivityAt: new Date().toISOString(),
      appVisible: true,
    });
    await passive.request({ type: "ping", requestId: "focused-barrier", clientSentAt: 1 });
    observer.frames.length = 0;
    passive.frames.length = 0;
    await admin.sendMessage(agent.id, "Complete a turn");
    const updates = () =>
      observer.frames.flatMap((frame) =>
        frame.type === "session" && frame.message.type === "agent_attention_required"
          ? [frame.message.payload]
          : [],
      );
    await expect.poll(() => updates().length, { timeout: 10000 }).toBe(3);
    expect(
      updates()
        .filter((update) => update.shouldNotify)
        .map((update) => update.subscriptionId),
    ).toEqual([notificationId]);
    expect(new Set(updates().map((update) => update.subscriptionId))).toEqual(
      new Set(snapshots.map((snapshot) => snapshot.subscriptionId)),
    );
    expect(
      passive.frames.filter(
        (frame) => frame.type === "session" && frame.message.type === "agent_attention_required",
      ),
    ).toEqual([]);
  } finally {
    for (const peer of peers) peer.close();
    await admin.close();
    await daemon.close();
  }
});

test("protocol rejection is a source-only control reply on modern connections", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const peers: SubscriptionPeer[] = [];
  try {
    const sender = await SubscriptionPeer.connect(daemon.port, "invalid-message-sources");
    const idle = await SubscriptionPeer.connect(daemon.port, "invalid-message-sources");
    peers.push(sender, idle);
    await sender.request({
      type: "fetch_agents_request",
      requestId: "invalid-query",
      scope: 42,
    } as unknown as SessionInboundMessage);
    const replies = sender.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "rpc_error" ? [frame.message.payload] : [],
    );
    expect(replies).toEqual([
      expect.objectContaining({ requestId: "invalid-query", requestType: "fetch_agents_request" }),
    ]);
    expect(idle.frames).toEqual([]);
  } finally {
    for (const peer of peers) peer.close();
    await daemon.close();
  }
});

test("dictation failure belongs only to its requesting source and releases speech demand", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const peers: SubscriptionPeer[] = [];
  try {
    const requester = await SubscriptionPeer.connect(daemon.port, "speech-sources");
    const idle = await SubscriptionPeer.connect(daemon.port, "speech-sources");
    peers.push(requester, idle);
    requester.send({
      type: "dictation_stream_start",
      dictationId: "same-dictation",
      format: "audio/pcm;rate=16000;bits=16",
    });
    await expect
      .poll(() =>
        requester.frames.some(
          (frame) => frame.type === "session" && frame.message.type === "dictation_stream_error",
        ),
      )
      .toBe(true);
    expect(idle.frames).toEqual([]);
    await requester.request({ type: "diagnostics.request", requestId: "speech-producers" });
    const report = requester.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "diagnostics.response"
        ? [frame.message.payload.diagnostic]
        : [],
    )[0];
    expect(report).toContain("Registrations: 0");
    expect(report).toContain("Producer listeners: 0");
  } finally {
    for (const peer of peers) peer.close();
    await daemon.close();
  }
});

test("a legacy socket cannot borrow a modern sibling's directory observation", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const peers: SubscriptionPeer[] = [];
  try {
    await admin.connect();
    const workspace = (
      await admin.createWorkspace({ source: { kind: "directory", path: daemon.staticDir } })
    ).workspace!;
    if (!workspace) throw new Error("Workspace creation failed");
    const agent = await admin.createAgent({
      provider: "codex",
      cwd: daemon.staticDir,
      workspaceId: workspace.id,
    });
    const modern = await SubscriptionPeer.connect(daemon.port, "mixed-notifications");
    const legacy = await SubscriptionPeer.connect(daemon.port, "mixed-notifications", {
      owned_subscriptions: false,
      selective_agent_timeline: true,
      explicit_event_subscriptions: true,
    });
    peers.push(modern, legacy);
    await modern.request({
      type: "fetch_agents_request",
      requestId: "modern-directory",
      subscribe: {},
    });
    await modern.request({
      type: "session.events.set_subscription.request",
      requestId: "modern-attention",
      events: ["agent_attention_required"],
    });
    await admin.sendMessage(agent.id, "Finish a turn");
    await expect
      .poll(() =>
        modern.frames.some(
          (frame) => frame.type === "session" && frame.message.type === "agent_attention_required",
        ),
      )
      .toBe(true);
    expect(
      legacy.frames.filter(
        (frame) =>
          frame.type === "session" &&
          (frame.message.type === "agent_attention_required" ||
            (frame.message.type === "agent_stream" &&
              frame.message.payload.event.type === "attention_required")),
      ),
    ).toEqual([]);
  } finally {
    for (const peer of peers) peer.close();
    await admin.close();
    await daemon.close();
  }
});

test("archive and delete replies retain their historical names and reach only the requester", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const peers: SubscriptionPeer[] = [];
  try {
    await admin.connect();
    const agent = await admin.createAgent({ provider: "codex", cwd: daemon.staticDir });
    const requester = await SubscriptionPeer.connect(daemon.port, "mutation-replies");
    const sibling = await SubscriptionPeer.connect(daemon.port, "mutation-replies");
    peers.push(requester, sibling);
    await requester.request({
      type: "archive_agent_request",
      requestId: "archive",
      agentId: agent.id,
    });
    await requester.request({
      type: "delete_agent_request",
      requestId: "delete",
      agentId: agent.id,
    });
    expect(
      requester.frames.flatMap((frame) => (frame.type === "session" ? [frame.message.type] : [])),
    ).toEqual(["agent_archived", "agent_deleted"]);
    expect(sibling.frames).toEqual([]);
  } finally {
    for (const peer of peers) peer.close();
    await admin.close();
    await daemon.close();
  }
});

test("Hub bootstrap sends its server ID before the producer's synchronous snapshot", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const frames: WSOutboundMessage[] = [];
  const hub = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    if (request.url !== "/api/daemons/enroll") {
      response.end("{}");
      return;
    }
    const enrollment = JSON.parse(body);
    const address = hub.address();
    if (!address || typeof address === "string") throw new Error("Missing local Hub address");
    response.end(
      JSON.stringify({
        daemonId: enrollment.daemonId,
        permissions: enrollment.permissions,
        webSocketUrl: `ws://127.0.0.1:${address.port}/socket`,
      }),
    );
  });
  const wss = new WebSocketServer({ server: hub });
  wss.on("headers", (headers) => headers.push("x-paseo-session-protocol: 1"));
  const connected = new Promise<WebSocket>((resolve) =>
    wss.once("connection", (socket) => {
      socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
      resolve(socket);
    }),
  );
  let socket: WebSocket | undefined;
  try {
    await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
    const address = hub.address();
    if (!address || typeof address === "string") throw new Error("Missing local Hub address");
    await admin.connect();
    await admin.connectHub(`http://127.0.0.1:${address.port}`, "local-fixture-token", [
      "hub.execute",
    ]);
    socket = await connected;
    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "local-hub",
        clientType: "hub",
        protocolVersion: 1,
        capabilities: { owned_subscriptions: true },
      }),
    );
    await expect.poll(() => frames.length).toBeGreaterThan(0);
    socket.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "hub.execution.agent.create.request",
          requestId: "create",
          executionId: "bootstrap",
          provider: "codex",
          cwd: daemon.staticDir,
          prompt: "hello",
        },
      }),
    );
    await expect
      .poll(() =>
        frames.some(
          (frame) =>
            frame.type === "session" &&
            frame.message.type === "hub.execution.agent.create.response" &&
            frame.message.payload.success,
        ),
      )
      .toBe(true);
    frames.length = 0;
    socket.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "session.events.set_subscription.request",
          requestId: "observe",
          events: ["hub.execution.agent.update"],
        },
      }),
    );
    await expect
      .poll(() =>
        frames.some(
          (frame) =>
            frame.type === "session" && frame.message.type === "hub.execution.agent.update",
        ),
      )
      .toBe(true);
    expect(frames[0]).toMatchObject({
      type: "session",
      message: {
        type: "session.events.set_subscription.response",
        payload: { requestId: "observe", subscriptionId: expect.any(String) },
      },
    });
  } finally {
    await admin.disconnectHub(true).catch(() => {});
    socket?.terminate();
    await admin.close();
    await daemon.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => hub.close(() => resolve()));
  }
});

test("provider child changes require explicit event ownership and leave an idle peer quiet", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  let idle: SubscriptionPeer | undefined;
  let observer: SubscriptionPeer | undefined;
  try {
    await admin.connect();
    idle = await SubscriptionPeer.connect(daemon.port, "idle-provider-child");
    observer = await SubscriptionPeer.connect(daemon.port, "provider-child-observer");
    await observer.request({
      type: "session.events.set_subscription.request",
      requestId: "children",
      events: ["agent.provider_subagents.update"],
    });
    const response = observer.frames.find(
      (frame) =>
        frame.type === "session" &&
        frame.message.type === "session.events.set_subscription.response",
    );
    expect(response).toBeDefined();
    const agent = await admin.createAgent({ provider: "codex", cwd: daemon.staticDir });
    await admin.sendMessage(agent.id, "Emit a provider child");
    await expect
      .poll(() =>
        observer!.frames.some(
          (frame) =>
            frame.type === "session" &&
            frame.message.type === "agent.provider_subagents.update" &&
            frame.message.payload.kind === "upsert" &&
            frame.message.payload.subagent.id === "fixture-child",
        ),
      )
      .toBe(true);
    expect(idle.frames).toEqual([]);
    expect(idle.binaryFrames).toEqual([]);
  } finally {
    idle?.close();
    observer?.close();
    await admin.close();
    await daemon.close();
  }
});

test("request outcomes for import and attention reach only their requesting socket", async () => {
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    isDev: true,
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
  const requester = await SubscriptionPeer.connect(daemon.port, "reply-shared");
  const sibling = await SubscriptionPeer.connect(daemon.port, "reply-shared");
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await admin.connect();
    await requester.request({
      type: "import_agent_request",
      requestId: "missing-import",
      provider: "codex",
      sessionId: "does-not-exist",
    });
    expect(requester.frames).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          type: "status",
          payload: expect.objectContaining({
            requestId: "missing-import",
            status: "agent_create_failed",
          }),
        }),
      }),
    );
    await requester.request({
      type: "import_agent_request",
      requestId: "successful-import",
      provider: "mock",
      sessionId: "saved-provider-session",
      cwd: daemon.staticDir,
    });
    expect(requester.frames).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          type: "status",
          payload: expect.objectContaining({
            requestId: "successful-import",
            status: "agent_resumed",
          }),
        }),
      }),
    );
    const agent = await admin.createAgent({
      provider: "codex",
      cwd: daemon.staticDir,
      title: "Attention",
    });
    await requester.request({
      type: "clear_agent_attention",
      requestId: "clear-attention",
      agentId: agent.id,
    });
    expect(requester.frames).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ type: "clear_agent_attention_response" }),
      }),
    );
    expect(sibling.frames).toEqual([]);
    expect(sibling.binaryFrames).toEqual([]);
  } finally {
    requester.close();
    sibling.close();
    await admin.close();
    await daemon.close();
  }
});

test("SDK import failure settles without waiting for the request timeout", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await expect(
      client.importAgent({ provider: "codex", sessionId: "does-not-exist" }),
    ).rejects.toThrow();
  } finally {
    await client.close();
    await daemon.close();
  }
}, 5000);

test("permission outcomes and domain observations keep independent source ownership", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const clients = [
    "permission-shared",
    "permission-shared",
    "permission-control",
    "permission-shared",
  ].map((clientId) => new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, clientId }));
  const legacy = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: "permission-shared",
    capabilities: { owned_subscriptions: false, explicit_event_subscriptions: false },
  });
  clients.push(legacy);
  const actor = clients[0];
  const observed: SessionOutboundMessage[][] = clients.map(() => []);
  const raw: SessionOutboundMessage[][] = clients.map(() => []);
  try {
    for (const [index, client] of clients.entries()) {
      await client.connect();
      client.subscribeRawMessages((message) => raw[index].push(message));
    }
    const owners = clients.slice(0, 3).map((client, index) => {
      const owner = client.observeEvents(["agent_permission_request", "agent_permission_resolved"]);
      owner.subscribe({ snapshot: () => {}, update: (message) => observed[index].push(message) });
      return owner;
    });
    await Promise.all(owners.map((owner) => owner.ready));
    const agent = await actor.createAgent({
      provider: "codex",
      cwd: daemon.staticDir,
      modeId: "always-ask",
    });
    for (let round = 0; round < 3; round += 1) {
      if (round === 1) await owners[1].release();
      observed.forEach((messages) => {
        messages.length = 0;
      });
      raw.forEach((messages) => {
        messages.length = 0;
      });
      await actor.sendMessage(
        agent.id,
        'Request approval to run the command `printf "ok" > permission.txt`. If denied, stop.',
      );
      const state = await actor.waitForFinish(agent.id, 5000);
      const permission = state.final?.pendingPermissions[0];
      expect(permission).toBeDefined();
      if (!permission) throw new Error("Expected a pending permission");
      await (round === 2 ? legacy : actor).respondToPermission(agent.id, permission.id, {
        behavior: "deny",
        message: "Owned observation regression",
      });
      const resolutions = (messages: SessionOutboundMessage[]) =>
        messages.filter(
          (
            message,
          ): message is Extract<SessionOutboundMessage, { type: "agent_permission_resolved" }> =>
            message.type === "agent_permission_resolved" &&
            message.payload.requestId === permission.id,
        );
      await expect.poll(() => resolutions(observed[2]).length).toBe(1);
      await actor.waitForFinish(agent.id, 5000);
      await expect.poll(() => resolutions(observed[0]).length).toBe(1);
      for (const index of [0, 1, 2]) {
        const expected = index === 1 && round >= 1 ? 0 : 1;
        expect(resolutions(observed[index])).toHaveLength(expected);
        for (const message of resolutions(observed[index])) {
          expect(message.payload).toMatchObject({
            subscriptionId: owners[index].subscriptionId,
            resolution: { behavior: "deny" },
          });
        }
        const outcomes = resolutions(raw[index]).filter(
          (message) => !message.payload.subscriptionId,
        );
        expect(outcomes).toHaveLength(index === 0 && round < 2 ? 1 : 0);
      }
      expect(resolutions(raw[4])).toHaveLength(1);
      expect(raw[3]).toEqual([]);
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await daemon.close();
  }
});

test("mark unread replies remain source-owned while directory observers receive attention", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const peers: SubscriptionPeer[] = [];
  try {
    await admin.connect();
    const agent = await admin.createAgent({
      provider: "codex",
      cwd: daemon.staticDir,
      title: "Finished",
    });
    const actor = await SubscriptionPeer.connect(daemon.port, "mark-unread-shared");
    peers.push(actor);
    const sibling = await SubscriptionPeer.connect(daemon.port, "mark-unread-shared");
    peers.push(sibling);
    const quiet = await SubscriptionPeer.connect(daemon.port, "mark-unread-shared");
    peers.push(quiet);
    await sibling.request({ type: "fetch_agents_request", requestId: "directory", subscribe: {} });
    const snapshot = sibling.frames.flatMap((frame) =>
      frame.type === "session" && frame.message.type === "fetch_agents_response"
        ? [frame.message.payload]
        : [],
    )[0];
    const workspaceId = snapshot.entries.find((entry) => entry.agent.id === agent.id)!.agent
      .workspaceId!;
    await actor.request({
      type: "workspace.clear_attention.request",
      workspaceId,
      requestId: "clear",
    });
    actor.frames.length = sibling.frames.length = quiet.frames.length = 0;
    await actor.request({ type: "workspace.mark_unread.request", workspaceId, requestId: "mark" });
    expect(actor.frames).toContainEqual(
      expect.objectContaining({
        message: {
          type: "workspace.mark_unread.response",
          payload: {
            workspaceId,
            requestId: "mark",
            markedAgentId: agent.id,
            success: true,
            error: null,
          },
        },
      }),
    );
    await expect
      .poll(() =>
        sibling.frames.some(
          (frame) =>
            frame.type === "session" &&
            frame.message.type === "agent_update" &&
            frame.message.payload.kind === "upsert" &&
            frame.message.payload.agent.id === agent.id &&
            frame.message.payload.agent.requiresAttention &&
            frame.message.payload.subscriptionId === snapshot.subscriptionId,
        ),
      )
      .toBe(true);
    expect(
      sibling.frames.some(
        (frame) =>
          frame.type === "session" && frame.message.type === "workspace.mark_unread.response",
      ),
    ).toBe(false);
    expect(quiet.frames).toEqual([]);
    expect(quiet.binaryFrames).toEqual([]);
    await actor.request({
      type: "workspace.mark_unread.request",
      workspaceId,
      requestId: "already-unread",
    });
    expect(actor.frames).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          type: "workspace.mark_unread.response",
          payload: expect.objectContaining({ requestId: "already-unread", success: false }),
        }),
      }),
    );
  } finally {
    for (const peer of peers) peer.close();
    await admin.close();
    await daemon.close();
  }
});
