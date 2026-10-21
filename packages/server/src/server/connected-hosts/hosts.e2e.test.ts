import { z } from "zod";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { createHostClient, createHostChannelTransport } from "@getpaseo/client/node";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import type { HostDirectory } from "@getpaseo/protocol/hosts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function daemon(
  options: Parameters<typeof createTestPaseoDaemon>[0] = {},
): Promise<TestPaseoDaemon> {
  const instance = await createTestPaseoDaemon(options);
  cleanup.push(() => instance.close());
  return instance;
}
async function api(instance: TestPaseoDaemon) {
  const client = createHostClient(`127.0.0.1:${instance.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  await client.connect();
  expect(client.getLastServerInfoMessage()).toMatchObject({ sourceId: "owner" });
  expect(client.getLastServerInfoMessage()).not.toHaveProperty("principalId");
  const paseo = createPaseoApi(client);
  cleanup.push(async () => {
    await paseo.dispose();
    await client.close();
  });
  return { paseo, client };
}
async function online(paseo: ReturnType<typeof createPaseoApi>): Promise<HostDirectory> {
  let directory!: HostDirectory;
  await expect
    .poll(
      async () => {
        directory = await paseo.hosts.list();
        return directory.hosts[0]?.status;
      },
      { timeout: 15000 },
    )
    .toBe("online");
  return directory;
}

test("SDK saves unreachable hosts, rejects syntax and preserves source identity without exposing secrets", async () => {
  const a = await daemon();
  const { paseo } = await api(a);
  await expect(paseo.hosts.add({ connection: "ssh://-bad" })).rejects.toMatchObject({
    code: "invalid_connection",
  });
  for (const connection of [
    "alice:example-secret@localhost:6767",
    "not-a-scheme://localhost:6767",
    "localhost/path:6767",
  ]) {
    const failure = await paseo.hosts.add({ connection }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "invalid_connection" });
    expect(String(failure)).not.toContain("example-secret");
    expect((await paseo.hosts.list()).hosts).toEqual([]);
  }
  const saved = await paseo.hosts.add({
    connection: "tcp://127.0.0.1:1?password=private-secret",
    label: "Unavailable",
    metadata: { team: "infra" },
    sourceKey: "stable",
  });
  expect(saved).toMatchObject({
    registrationId: expect.stringMatching(/^hst_/),
    serverId: null,
    label: "Unavailable",
    source: { id: "owner", key: "stable" },
    metadata: { team: "infra" },
    enabled: true,
  });
  expect(JSON.stringify(await paseo.hosts.list())).not.toContain("private-secret");
  await paseo.hosts.update(saved.registrationId, { enabled: false });
  expect(
    await paseo.hosts.add({
      connection: "tcp://127.0.0.1:1?password=private-secret",
      label: "Unavailable",
      metadata: { team: "infra" },
      sourceKey: "stable",
    }),
  ).toMatchObject({ registrationId: saved.registrationId, enabled: false, status: "disabled" });
  await expect(
    paseo.hosts.add({ connection: "127.0.0.1:2", sourceKey: "stable" }),
  ).rejects.toMatchObject({ code: "source_conflict" });
  await paseo.hosts.remove(saved.registrationId);
  expect((await paseo.hosts.list()).hosts).toEqual([]);
});

test("ordinary routed APIs isolate scopes and enforce one-hop, disable and origin disposal", async () => {
  const b = await daemon();
  const wire = await hostWire(b);
  const a = await daemon();
  const { paseo } = await api(a);
  const observation = paseo.hosts.observe();
  expect((await observation.ready).hosts).toEqual([]);
  const saved = await paseo.hosts.add({ connection: wire.connection, label: "B" });
  const directory = await online(paseo);
  const serverId = directory.hosts[0]!.serverId!;
  const first = await paseo.hosts.client(serverId);
  const second = await paseo.hosts.client(serverId);
  expect(wire.connections()).toBe(1);
  expect(wire.active()).toBe(1);
  const workspaces = await second.workspaces.list({ subscribe: {} });
  expect(workspaces.entries).toEqual([]);
  await first.dispose();
  expect(wire.active()).toBe(1);
  expect((await second.workspaces.list()).entries).toEqual([]);
  await expect(second.hosts.client(directory.self.serverId)).rejects.toMatchObject({
    code: "unsupported_capability",
  });
  await paseo.hosts.update(saved.registrationId, { enabled: false });
  await expect(paseo.hosts.client(serverId)).rejects.toMatchObject({ code: "host_disabled" });
  await paseo.hosts.update(saved.registrationId, { enabled: true });
  await online(paseo);
  await expect
    .poll(
      async () => {
        try {
          return (await second.workspaces.list()).entries.length;
        } catch {
          return -1;
        }
      },
      { timeout: 20000 },
    )
    .toBe(0);
  expect(wire.connections()).toBe(2);
  expect(wire.active()).toBe(1);
  await second.dispose();
  expect(wire.active()).toBe(1);
  await observation.release();
  await paseo.dispose();
});

test("routed authority is bounded by the caller, with isolated simultaneous sessions", async () => {
  const b = await daemon();
  const a = await daemon();
  const owner = await api(a);
  await owner.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const directory = await online(owner.paseo);
  const serverId = directory.hosts[0]!.serverId!;
  const viewerClient = createHostClient(`127.0.0.1:${a.port}`, {
    clientId: "overlapping",
    sessionPermissions: ["daemon.read", "workspace.read"],
    reconnect: { enabled: false },
  });
  await viewerClient.connect();
  const viewer = createPaseoApi(viewerClient);
  cleanup.push(async () => {
    await viewer.dispose();
    await viewerClient.close();
  });
  const remote = await viewer.hosts.client(serverId);
  expect((await remote.workspaces.list()).entries).toEqual([]);
  await expect(
    remote.workspaces.create({ source: { kind: "directory", path: b.paseoHome } }),
  ).rejects.toMatchObject({ code: "access_denied" });
  await expect(viewer.hosts.add({ connection: "127.0.0.1:1" })).rejects.toMatchObject({
    code: "permission_denied",
  });
  expect((await owner.paseo.hosts.list()).hosts).toHaveLength(1);
  await remote.dispose();
});

test("SDK host clients preserve ordinary permission RPC errors", async () => {
  const b = await daemon();
  const a = await daemon();
  const owner = await api(a);
  await owner.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const serverId = (await online(owner.paseo)).hosts[0]!.serverId!;
  const clients = [a, b].map((host) =>
    createHostClient(`127.0.0.1:${host.port}`, {
      clientId: crypto.randomUUID(),
      sessionPermissions: ["daemon.read", "workspace.read"],
      reconnect: { enabled: false },
    }),
  );
  for (const client of clients) {
    cleanup.push(() => client.close());
    await client.connect();
  }
  const origin = createPaseoApi(clients[0]!);
  const direct = createPaseoApi(clients[1]!);
  const remote = await origin.hosts.client(serverId);
  cleanup.push(async () => {
    await remote.dispose();
    await direct.dispose();
    await origin.dispose();
  });
  const input = { source: { kind: "directory" as const, path: b.staticDir } };
  const directError = (await direct.workspaces.create(input).catch((error: unknown) => error)) as {
    code: string;
  };
  const remoteError = (await remote.workspaces.create(input).catch((error: unknown) => error)) as {
    code: string;
  };
  expect(directError.code).toBe("access_denied");
  expect(remoteError.code).toBe(directError.code);
});

test("distinct origin sessions cannot collide through a caller-selected route scope, including terminal binary output", async () => {
  const b = await daemon();
  const wire = await hostWire(b);
  const a = await daemon();
  const admin = await api(a);
  await admin.paseo.hosts.add({ connection: wire.connection });
  const serverId = (await online(admin.paseo)).hosts[0]!.serverId!;
  const remote = await admin.paseo.hosts.client(serverId);
  const workspace = await remote.workspaces.create({
    source: { kind: "directory", path: b.staticDir },
  });
  const one = await workspace.terminals.create({
    command: process.execPath,
    args: ["-e", "process.stdin.on('data', data => process.stdout.write(data))"],
    name: "First",
  });
  const two = await workspace.terminals.create({
    command: process.execPath,
    args: ["-e", "process.stdin.on('data', data => process.stdout.write(data))"],
    name: "Second",
  });
  const firstOrigin = await api(a);
  const secondOrigin = await api(a);
  const first = await RoutePeer.open(firstOrigin.client, serverId);
  const second = await RoutePeer.open(secondOrigin.client, serverId);
  await first.subscribeTerminal(one.id);
  await second.subscribeTerminal(two.id);
  expect(wire.connections()).toBe(1);
  first.input("FIRST_ONLY\n");
  second.input("SECOND_ONLY\n");
  await expect.poll(() => first.output()).toContain("FIRST_ONLY");
  await expect.poll(() => second.output()).toContain("SECOND_ONLY");
  expect(first.output()).not.toContain("SECOND_ONLY");
  expect(second.output()).not.toContain("FIRST_ONLY");
  const firstBytes = new Uint8Array([0, 255, 128, 173]);
  const secondBytes = new Uint8Array([173, 128, 255, 0]);
  const paths = await Promise.all([
    first.upload("first.bin", firstBytes),
    second.upload("second.bin", secondBytes),
  ]);
  expect((await readFile(paths[0]!)).equals(firstBytes)).toBe(true);
  expect((await readFile(paths[1]!)).equals(secondBytes)).toBe(true);

  const binary = wire.frames.filter((frame) => frame.binary);
  expect(binary.length).toBeGreaterThan(0);
  expect(binary.every((frame) => decodeHostRouteFrame(frame.bytes) !== null)).toBe(true);
  expect(
    binary.some((frame) => {
      const payload = decodeHostRouteFrame(frame.bytes)!.payload;
      return Buffer.from(payload).equals(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          slot: 0,
          payload: "FIRST_ONLY\n",
        }),
      );
    }),
  ).toBe(true);
  const json = wire.frames
    .filter((frame) => !frame.binary)
    .map((frame) => JSON.parse(frame.bytes.toString()));
  expect(json.filter((frame) => frame.type === "hello")).toHaveLength(1);
  expect(json.some((frame) => frame.message?.type === "hosts.link.open.request")).toBe(true);
  expect(
    json.some((frame) => frame.message?.binary === true || frame.message?.payload?.binary === true),
  ).toBe(false);
  await first.close();
  second.input("STILL_SECOND\n");
  await expect.poll(() => second.output()).toContain("STILL_SECOND");
  await second.close();
  await one.kill();
  await two.kill();
  await remote.dispose();
});

import {
  encodeFileTransferFrame,
  FileTransferOpcode,
  decodeHostRouteFrame,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import {
  WSOutboundMessageSchema,
  type SessionOutboundMessage,
  type SessionInboundMessage,
} from "@getpaseo/protocol/messages";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
class RoutePeer {
  readonly messages: SessionOutboundMessage[] = [];
  readonly bytes: Uint8Array[] = [];
  private slot = -1;
  private detach = () => {};
  private constructor(
    private readonly origin: DaemonClient,
    private readonly routeId: string,
  ) {
    const binary = origin.subscribeHostFrames((frame) => {
      if (frame.routeId === routeId) this.bytes.push(frame.payload);
    });
    const text = origin.subscribeRawMessages((message) => {
      if (message.type !== "hosts.route.frame" || message.payload.subscriptionId !== routeId)
        return;
      {
        const frame = WSOutboundMessageSchema.parse(JSON.parse(message.payload.data));
        if (frame.type === "session") this.messages.push(frame.message);
      }
    });
    this.detach = () => {
      binary();
      text();
    };
  }
  static async open(origin: DaemonClient, serverId: string) {
    const peer = new RoutePeer(
      origin,
      await origin.openHostRoute(serverId, "same-untrusted-scope"),
    );
    origin.sendHostFrame(
      peer.routeId,
      JSON.stringify({
        type: "hello",
        clientId: "same-untrusted-client",
        clientType: "cli",
        protocolVersion: 1,
        capabilities: { owned_subscriptions: true },
      }),
    );
    await expect
      .poll(
        () =>
          peer.messages.filter(
            (message) => message.type === "status" && message.payload.status === "server_info",
          ).length,
      )
      .toBe(1);
    const info = peer.messages.find(
      (message) => message.type === "status" && message.payload.status === "server_info",
    );
    if (info?.type !== "status") throw new Error("Missing routed server info");
    expect(info.payload).toMatchObject({
      sourceId: `route:owner:${origin.getLastServerInfoMessage()!.serverId}:owner`,
    });
    expect(info.payload).not.toHaveProperty("principalId");
    return peer;
  }
  send(message: SessionInboundMessage) {
    this.origin.sendHostFrame(this.routeId, JSON.stringify({ type: "session", message }));
  }
  async subscribeTerminal(terminalId: string) {
    this.send({ type: "subscribe_terminal_request", terminalId, requestId: "same-request" });
    await expect
      .poll(
        () =>
          this.messages.filter((message) => message.type === "subscribe_terminal_response").length,
      )
      .toBe(1);
    const response = this.messages.find(
      (message) => message.type === "subscribe_terminal_response",
    );
    if (response?.type !== "subscribe_terminal_response" || response.payload.slot === null)
      throw new Error("Missing terminal response");
    this.slot = response.payload.slot!;
  }
  input(text: string) {
    this.origin.sendHostFrame(
      this.routeId,
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Input,
        slot: this.slot,
        payload: text,
      }),
    );
  }
  async upload(fileName: string, bytes: Uint8Array) {
    const requestId = "same-upload-request";
    const modifiedAt = new Date().toISOString();
    this.send({
      type: "file.upload.request",
      requestId,
      fileName,
      mimeType: "application/octet-stream",
      size: bytes.length,
      modifiedAt,
    });
    for (const frame of [
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId,
        metadata: {
          mime: "application/octet-stream",
          size: bytes.length,
          encoding: "binary",
          modifiedAt,
          fileName,
        },
      }),
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileChunk, requestId, payload: bytes }),
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }),
    ])
      this.origin.sendHostFrame(this.routeId, frame);
    await expect
      .poll(() => this.messages.some((message) => message.type === "file.upload.response"))
      .toBe(true);
    const response = this.messages.find((message) => message.type === "file.upload.response");
    if (response?.type !== "file.upload.response" || !response.payload.file)
      throw new Error("Upload failed");
    return response.payload.file.path;
  }
  output() {
    return this.bytes
      .flatMap((bytes) => {
        const frame = decodeTerminalStreamFrame(bytes);
        return frame?.opcode === TerminalStreamOpcode.Output
          ? [new TextDecoder().decode(frame.payload)]
          : [];
      })
      .join("");
  }
  async close() {
    this.detach();
    this.origin.closeHostRoute(this.routeId);
  }
}

import { mkdir, writeFile, readFile, chmod, stat, mkdtemp, rm, readdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { resolveDaemonVersion } from "../daemon-version.js";

test("identity discovery failures remain inspectable and changing a pinned destination requires explicit replacement", async () => {
  const a = await daemon();
  const b = await daemon();
  const c = await daemon();
  const { paseo } = await api(a);
  const self = await paseo.hosts.add({ connection: `127.0.0.1:${a.port}` });
  await expect.poll(async () => (await paseo.hosts.list()).hosts[0]!.error?.code).toBe("self_host");
  expect((await paseo.hosts.list()).hosts[0]!.serverId).toBe(a.daemon.getServerId());
  await paseo.hosts.remove(self.registrationId);
  const original = await paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const bId = (await online(paseo)).hosts[0]!.serverId;
  const duplicate = await paseo.hosts.add({ connection: `ws://127.0.0.1:${b.port}/ws` });
  await expect
    .poll(async () => (await paseo.hosts.list()).hosts[1]!.error?.code)
    .toBe("duplicate_host");
  expect((await paseo.hosts.list()).hosts[1]!.serverId).toBe(bId);
  await paseo.hosts.remove(duplicate.registrationId);
  await paseo.hosts.update(original.registrationId, { connection: `127.0.0.1:${c.port}` });
  await expect
    .poll(async () => (await paseo.hosts.list()).hosts[0]!.error?.code)
    .toBe("server_id_mismatch");
  expect((await paseo.hosts.list()).hosts[0]!.serverId).toBe(bId);
  await paseo.hosts.update(original.registrationId, {
    connection: `127.0.0.1:${c.port}`,
    replaceIdentity: true,
  });
  expect((await online(paseo)).hosts[0]!.serverId).toBe(c.daemon.getServerId());
});

test("disabled host configuration and source survive a fresh daemon instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-host-restart-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const a = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => a.close());
  const { paseo } = await api(a);
  const host = await paseo.hosts.add({
    connection: "tcp://127.0.0.1:1?password=secret",
    label: "Persistent",
    metadata: { team: "infra" },
    sourceKey: "stable",
  });
  await paseo.hosts.update(host.registrationId, { enabled: false });
  // Windows exposes inherited ACLs, not POSIX owner/group/other mode bits.
  if (process.platform !== "win32")
    expect((await stat(join(a.paseoHome, "hosts.json"))).mode & 0o777).toBe(0o600);
  await a.close();
  const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => restarted.close());
  const next = await api(restarted);
  expect((await next.paseo.hosts.list()).hosts).toEqual([
    expect.objectContaining({
      registrationId: host.registrationId,
      label: "Persistent",
      metadata: { team: "infra" },
      source: { id: "owner", key: "stable" },
      enabled: false,
      status: "disabled",
    }),
  ]);
});

test("server plugins use ordinary remote SDK operations and retain qualified source ownership on B", async () => {
  const b = await daemon();
  const a = await daemon();
  const { paseo, client } = await api(a);
  await paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const serverId = (await online(paseo)).hosts[0]!.serverId!;
  const directory = join(a.staticDir, "host-plugin");
  await mkdir(directory);
  await writeFile(
    join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "connected-host-test",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    join(directory, "index.server.ts"),
    `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const operate = defineRpc({ name: "operate", input: z.object({ serverId: z.string(), path: z.string() }), output: z.object({ workspaceId: z.string(), registrationId: z.string(), sourceId: z.string() }) });
export default function contribute(server) {
  server.handle(operate, async (input, context) => {
    const remote = await context.paseo.hosts.client(input.serverId);
    try {
      const workspace = await remote.workspaces.create({ source: { kind: "directory", path: input.path }, title: "Plugin remote workspace" });
      const host = await remote.hosts.add({ connection: "127.0.0.1:1", sourceKey: "plugin-stable", metadata: { team: "plugin" } });
      return { workspaceId: workspace.id, registrationId: host.registrationId, sourceId: host.source.id };
    } finally { await remote.dispose(); }
  });
  return () => {};
}`,
  );
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installDirectoryPlugin(directory);
  const result = await client.invokePluginRpc("connected-host-test", "operate", {
    serverId,
    path: b.staticDir,
  });
  expect(result).toEqual({
    workspaceId: expect.stringMatching(/^wks_/),
    registrationId: expect.stringMatching(/^hst_/),
    sourceId: `route:owner:${a.daemon.getServerId()}:plugin%3Aconnected-host-test`,
  });
  const direct = await api(b);
  expect((await direct.paseo.workspaces.list()).entries).toHaveLength(1);
  expect((await direct.paseo.hosts.list()).hosts[0]).toMatchObject({
    source: {
      id: `route:owner:${a.daemon.getServerId()}:plugin%3Aconnected-host-test`,
      key: "plugin-stable",
    },
    metadata: { team: "plugin" },
  });
  await client.removePlugin("connected-host-test");
  expect((await direct.paseo.workspaces.list()).entries).toHaveLength(1);
});

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("CLI host commands manage the selected daemon and emit secret-free structured output", async () => {
  const a = await daemon();
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [
            "--conditions=source",
            "--import",
            "tsx",
            fileURLToPath(new URL("../../../../cli/src/index.ts", import.meta.url)),
            "--host",
            `127.0.0.1:${a.port}`,
            "host",
            ...args,
            "--json",
          ],
          { timeout: 20000 },
        )
      ).stdout,
    );
  const malformed = await cli("add", "alice:example-secret@localhost:6767").catch(
    (error: unknown) => error,
  );
  expect(malformed).toHaveProperty("stderr");
  expect((malformed as { stderr: string }).stderr).toContain("invalid_connection");
  expect((malformed as { stderr: string }).stderr).not.toContain("example-secret");
  expect(await cli("ls")).toEqual([]);
  const saved = await cli(
    "add",
    "tcp://127.0.0.1:1?password=cli-secret",
    "--label",
    "CLI host",
    "--meta",
    "team=infra",
  );
  expect(saved).toMatchObject({
    label: "CLI host",
    metadata: { team: "infra" },
    registrationId: expect.stringMatching(/^hst_/),
  });
  expect(JSON.stringify(await cli("ls"))).not.toContain("cli-secret");
  expect(
    await cli(
      "update",
      saved.registrationId,
      "--meta",
      "team=tools",
      "--meta",
      "other=value",
      "--remove-meta",
      "team",
    ),
  ).toMatchObject({ metadata: { other: "value" } });
  expect(await cli("disable", saved.registrationId)).toMatchObject({
    status: "disabled",
    enabled: false,
  });
  expect(await cli("inspect", saved.registrationId)).toMatchObject({
    enabled: false,
    targetDescription: "tcp://127.0.0.1:1",
  });
  expect(await cli("enable", saved.registrationId)).toMatchObject({ enabled: true });
  await cli("rm", saved.registrationId);
  expect(await cli("ls")).toEqual([]);
}, 60000);

test("resuming an A session with narrower grants terminates existing routes and restores observations with current authority", async () => {
  const b = await daemon();
  const a = await daemon();
  const admin = await api(a);
  await admin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const serverId = (await online(admin.paseo)).hosts[0]!.serverId!;
  const origin = createHostClient(`127.0.0.1:${a.port}`, {
    clientId: "resumed-authority",
    reconnect: { enabled: false },
  });
  await origin.connect();
  const paseo = createPaseoApi(origin);
  cleanup.push(async () => {
    await paseo.dispose();
    await origin.close();
  });
  const remote = await paseo.hosts.client(serverId);
  const observed = await remote.workspaces.list({ subscribe: {} });
  const snapshots: unknown[] = [];
  observed.subscription.subscribe({
    snapshot: (snapshot) => snapshots.push(snapshot),
    update() {},
  });
  const restricted = createHostClient(`127.0.0.1:${a.port}`, {
    clientId: "resumed-authority",
    sessionPermissions: ["daemon.read", "workspace.read"],
    reconnect: { enabled: false },
  });
  await restricted.connect();
  cleanup.push(() => restricted.close());
  await expect.poll(() => snapshots.length, { timeout: 15000 }).toBe(2);
  await expect(
    remote.workspaces.create({ source: { kind: "directory", path: b.staticDir } }),
  ).rejects.toMatchObject({ code: "access_denied" });
  expect((await remote.workspaces.list()).entries).toEqual([]);
  await remote.dispose();
});

import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";
import { hashSync } from "bcryptjs";

test("old capabilities fail before execution and authentication errors recover through credential replacement", async () => {
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  const operations: string[] = [];
  ws.on("connection", (socket) =>
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "hello")
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "srv_old",
                hostname: "old",
                version: "0.1.0",
              },
            },
          }),
        );
      else if (frame.type === "session") operations.push(frame.message.type);
    }),
  );
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  cleanup.push(async () => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing old daemon port");
  const old = createHostClient(`127.0.0.1:${address.port}`, {
    clientId: "old-capability",
    reconnect: { enabled: false },
  });
  await old.connect();
  cleanup.push(() => old.close());
  await expect(createPaseoApi(old).hosts.add({ connection: "127.0.0.1:1" })).rejects.toMatchObject({
    code: "unsupported_capability",
  });
  expect(operations).toEqual([]);
  const a = await daemon();
  const { paseo } = await api(a);
  const registration = await paseo.hosts.add({ connection: `127.0.0.1:${address.port}` });
  await expect
    .poll(async () => (await paseo.hosts.list()).hosts[0]!.error?.code)
    .toBe("unsupported_capability");
  await expect(paseo.hosts.client("srv_old")).rejects.toMatchObject({
    code: "unsupported_capability",
  });
  expect(operations).toEqual([]);
  await paseo.hosts.remove(registration.registrationId);
  const b = await createTestPaseoDaemon({ auth: { password: hashSync("right-password", 4) } });
  cleanup.push(() => b.close());
  const saved = await paseo.hosts.add({
    connection: `tcp://127.0.0.1:${b.port}?password=wrong-password`,
  });
  await expect
    .poll(async () => (await paseo.hosts.list()).hosts[0]!.error?.code)
    .toBe("authentication_failed");
  expect(JSON.stringify(await paseo.hosts.list())).not.toContain("wrong-password");
  await paseo.hosts.update(saved.registrationId, {
    connection: `tcp://127.0.0.1:${b.port}?password=right-password`,
  });
  expect((await online(paseo)).hosts[0]!.serverId).toBe(b.daemon.getServerId());
});

test("an unreachable saved target becomes online after its daemon starts without being added again", async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing reserved port");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const a = await daemon();
  const { paseo } = await api(a);
  const host = await paseo.hosts.add({ connection: `127.0.0.1:${address.port}` });
  await expect.poll(async () => (await paseo.hosts.list()).hosts[0]!.status).toBe("offline");
  const b = await createTestPaseoDaemon({ listenPort: address.port });
  cleanup.push(() => b.close());
  expect((await online(paseo)).hosts[0]).toMatchObject({
    registrationId: host.registrationId,
    serverId: b.daemon.getServerId(),
    status: "online",
    nextRetryAt: null,
    error: null,
  });
});

test("losing a sent mutation result retains ordinary errors, identifies the destination and never replays it", async () => {
  const b = await daemon();
  const a = await daemon();
  const { paseo, client } = await api(a);
  await paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const serverId = (await online(paseo)).hosts[0]!.serverId!;
  const remote = await paseo.hosts.client(serverId);
  const pending = remote.config.patch({ pluginsEnabled: false });
  const result = pending.catch((error: unknown) => error);
  await client.close();
  expect(await result).toMatchObject({
    code: "DAEMON_CONNECTION_LOST",
    outcome: "unknown",
    serverId,
  });
  await expect(remote.workspaces.list()).rejects.toMatchObject({
    code: "DAEMON_CONNECTION_LOST",
    serverId,
  });
  const direct = await api(b);
  await direct.client.close();
  const terminalFailure = (await direct.paseo.terminals
    .list()
    .catch((error: unknown) => error)) as Error;
  await expect(remote.terminals.list()).rejects.toThrow(terminalFailure.message);
  const creation = {
    source: { kind: "directory" as const, path: "/tmp" },
    workspaceId: "offline-never-created",
  };
  const creationFailure = (await direct.paseo.workspaces
    .create(creation)
    .catch((error: unknown) => error)) as Error;
  await expect(remote.workspaces.create(creation)).rejects.toThrow(creationFailure.message);
  await remote.dispose();
});

test("disposing an origin during routed handshake settles acquisition and closes only its pending session", async () => {
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  let connections = 0;
  let routeHello = false;
  let routeClosed = false;
  ws.on("connection", (socket) => {
    connections++;
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      if (frame.type === "hello")
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "srv_pending",
                hostname: "pending",
                version: "0.12.0",
                features: {
                  connectedHosts: true,
                  hostMultiplexing: true,
                  ownedSubscriptions: true,
                },
              },
            },
          }),
        );
      if (frame.message?.type === "hosts.link.open.request")
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "hosts.link.open.response",
              payload: { requestId: frame.message.requestId, routeId: "pending-channel" },
            },
          }),
        );
      if (frame.message?.type === "hosts.route.frame.request") routeHello = true;
      if (frame.message?.type === "hosts.route.close.request") routeClosed = true;
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  cleanup.push(async () => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing pending endpoint port");
  const a = await daemon();
  const { paseo } = await api(a);
  await paseo.hosts.add({ connection: `127.0.0.1:${address.port}` });
  await online(paseo);
  const pending = paseo.hosts.client("srv_pending");
  const result = pending.catch((error: unknown) => error);
  await expect.poll(() => routeHello).toBe(true);
  await paseo.dispose();
  expect(await result).toBeInstanceOf(Error);
  await expect.poll(() => routeClosed).toBe(true);
  expect(ws.clients.size).toBe(1);
  expect(connections).toBe(1);
  routeClosed = false;
  const next = await api(a);
  await expect(next.paseo.hosts.client("srv_pending")).rejects.toMatchObject({
    code: "host_offline",
    serverId: "srv_pending",
  });
  await expect.poll(() => routeClosed).toBe(true);
  expect(ws.clients.size).toBe(1);
  expect(connections).toBe(1);
  expect((await next.paseo.workspaces.list()).entries).toEqual([]);
  expect((await next.paseo.hosts.list()).hosts[0]?.status).toBe("online");
});

test("source-key registration remains idempotent at directory capacity", async () => {
  const { ConnectedHosts } = await import("./index.js");
  const home = await mkdtemp(join(tmpdir(), "hosts-capacity-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const rows = Array.from({ length: 128 }, (_, index) => ({
    registrationId: `saved-${index}`,
    serverId: null,
    label: null,
    source: { id: "plugin:capacity", key: `key-${index}` },
    metadata: {},
    enabled: false,
    status: "disabled",
    targetDescription: "127.0.0.1:1",
    lastOnlineAt: null,
    nextRetryAt: null,
    error: null,
    connection: "127.0.0.1:1",
  }));
  await writeFile(join(home, "hosts.json"), JSON.stringify(rows));
  const registry = new ConnectedHosts(home, { serverId: "self", label: "self" });
  cleanup.push(() => registry.close());
  const actor = { sourceId: "plugin:capacity", manageSources: false };
  await expect(
    registry.add({ connection: "127.0.0.1:1", sourceKey: "key-0" }, actor),
  ).resolves.toMatchObject({ registrationId: "saved-0", enabled: false });
  await expect(
    registry.add({ connection: "127.0.0.1:1", sourceKey: "new" }, actor),
  ).rejects.toMatchObject({ code: "resource_limit" });
});

/** Real WebSocket proxy records the A–B physical wire without replacing either daemon. */
async function hostWire(b: TestPaseoDaemon) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const frames: { binary: boolean; bytes: Buffer; direction: "toB" | "fromB" }[] = [];
  let connections = 0;
  wss.on("connection", (downstream) => {
    connections++;
    const upstream = new WebSocket(`ws://127.0.0.1:${b.port}/ws`);
    const pending: (() => void)[] = [];
    upstream.on("open", () => {
      for (const send of pending.splice(0)) send();
    });
    downstream.on("message", (data, binary) => {
      const bytes = Buffer.from(data as Buffer);
      frames.push({ binary, bytes, direction: "toB" });
      const send = () => {
        if (upstream.readyState === 1) upstream.send(bytes, { binary });
      };
      if (upstream.readyState === 0) pending.push(send);
      else send();
    });
    upstream.on("message", (data, binary) => {
      const bytes = Buffer.from(data as Buffer);
      frames.push({ binary, bytes, direction: "fromB" });
      if (downstream.readyState === 1) downstream.send(bytes, { binary });
    });
    upstream.on("error", () => downstream.close());
    upstream.on("close", () => downstream.close());
    downstream.on("close", () => upstream.close());
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing wire port");
  return {
    connection: `127.0.0.1:${address.port}`,
    frames,
    connections: () => connections,
    active: () => wss.clients.size,
  };
}

test("a resumed physical link re-admits every logical session under its current grant ceiling", async () => {
  const b = await daemon();
  const parent = createHostClient(`127.0.0.1:${b.port}`, { clientId: "physical-grants" });
  cleanup.push(() => parent.close());
  await parent.connect();
  const serverId = parent.getLastServerInfoMessage()!.serverId;
  const logical = new DaemonClient({
    url: "ws://logical/ws",
    clientId: "logical",
    transportFactory: createHostChannelTransport(parent, serverId, "logical", null, true),
  });
  cleanup.push(() => logical.close());
  const connecting = logical.connect();
  expect(() => logical.ensureConnected()).not.toThrow();
  const scoped = createPaseoApi(logical);
  cleanup.push(() => scoped.dispose());
  const initialCall = scoped.workspaces.list();
  await connecting;
  expect((await initialCall).entries).toEqual([]);
  const recoveryCalls: Promise<unknown>[] = [];
  const stopRecovery = logical.subscribeConnectionStatus((state) => {
    if (state.status === "connecting")
      recoveryCalls.push(scoped.workspaces.list().catch((error: unknown) => error));
  });
  cleanup.push(async () => stopRecovery());
  const bytes = Uint8Array.from({ length: 256 * 1024 + 123 }, (_, index) => index % 251);
  const upload = await logical.uploadFile({
    fileName: "routed.bin",
    mimeType: "application/octet-stream",
    bytes,
  });
  expect(upload.error).toBeNull();
  const downloaded = await logical.readFile(
    dirname(upload.file!.path),
    basename(upload.file!.path),
  );
  expect(Buffer.from(downloaded.bytes).equals(bytes)).toBe(true);

  const observed = await scoped.workspaces.list({ subscribe: {} });
  const snapshots: unknown[] = [];
  observed.subscription.subscribe({ snapshot: (value) => snapshots.push(value), update() {} });
  const narrowed = createHostClient(`127.0.0.1:${b.port}`, {
    clientId: "physical-grants",
    sessionPermissions: ["daemon.read", "workspace.read"],
    reconnect: { enabled: false },
  });
  cleanup.push(() => narrowed.close());
  await narrowed.connect();
  await expect.poll(() => snapshots.length, { timeout: 15000 }).toBe(2);
  expect(logical.getLastServerInfoMessage()?.permissions).toEqual([
    "daemon.read",
    "workspace.read",
  ]);
  await expect(
    scoped.workspaces.create({ source: { kind: "directory", path: b.staticDir } }),
  ).rejects.toMatchObject({ code: "access_denied" });
  const restored = createHostClient(`127.0.0.1:${b.port}`, {
    clientId: "physical-grants",
    reconnect: { enabled: false },
  });
  cleanup.push(() => restored.close());
  await restored.connect();
  await expect.poll(() => snapshots.length, { timeout: 15000 }).toBe(3);
  expect(logical.getLastServerInfoMessage()?.permissions).toContain("workspace.write");
  expect(recoveryCalls.length).toBeGreaterThanOrEqual(2);
  for (const call of recoveryCalls) expect(await call).toMatchObject({ entries: [] });
  await scoped.workspaces.create({ source: { kind: "directory", path: b.staticDir } });
});

import { DaemonLinkEndpoint, VirtualHostSocket } from "./index.js";
import { SessionDelivery } from "../session/owned-subscriptions/index.js";
import { sendBoundedPhysicalFrameAndWait } from "../websocket/physical-socket.js";

test("channel output accounts for escaped text, awaits physical drain, and preserves its sibling", async () => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const accepted = once(wss, "connection");
  const tcpAccepted = once(http, "connection");
  const receiver = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const received: { binary: boolean; bytes: Buffer }[] = [];
  receiver.on("message", (bytes, binary) =>
    received.push({ bytes: Buffer.from(bytes as Buffer), binary }),
  );
  const [physical] = (await accepted) as [WebSocket];
  const [tcp] = (await tcpAccepted) as [Socket];
  await once(receiver, "open");
  cleanup.push(async () => {
    receiver.terminate();
    physical.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const delivery = new SessionDelivery(
    async (source, message) => {
      expect(delivery.permits(source, message)).toBe(true);
      await sendBoundedPhysicalFrameAndWait({
        socket: physical,
        frame: JSON.stringify({ type: "session", message }),
        onHighWater: () => {
          throw new Error("Shared link overflowed");
        },
      });
    },
    async (source, frame) => {
      expect(delivery.permitsBinary(source, frame)).toBe(true);
      await sendBoundedPhysicalFrameAndWait({
        socket: physical,
        frame,
        onHighWater: () => {
          throw new Error("Shared link overflowed");
        },
      });
    },
  );
  delivery.attach(physical, true);
  const channels: VirtualHostSocket[] = [];
  const endpoint = new DaemonLinkEndpoint({
    identity: "authenticated",
    permissions: () => ["daemon.read"],
    routed: () => false,
    bufferedAmount: () => physical.bufferedAmount,
    delivery,
    admit: async (socket) => {
      channels.push(socket);
    },
  });
  cleanup.push(async () => {
    endpoint.close();
    await delivery.close();
  });
  for (const channelId of ["slow", "sibling"]) {
    const request = { type: "hosts.link.open.request" as const, requestId: channelId, channelId };
    await delivery.request(physical, request, () => endpoint.dispatch(request));
  }
  await expect(channels[0]!.send('"'.repeat(34 * 1024 * 1024))).rejects.toThrow(
    "Host channel output limit reached",
  );
  expect(channels[0]!.readyState).toBe(3);
  expect(physical.readyState).toBe(1);
  await channels[1]!.send("sibling-before");
  await expect
    .poll(() => received.some((frame) => !frame.binary && frame.bytes.includes("sibling-before")))
    .toBe(true);
  receiver.pause();
  // Hold real physical writes independently of the OS receive-buffer size.
  // A paused receiver alone can still accept the entire frame on Windows.
  tcp.cork();
  let completed = false;
  const bytes = new Uint8Array(8 * 1024 * 1024).fill(173);
  const pending = channels[1]!.send(bytes).then(() => {
    completed = true;
    return undefined;
  });
  await expect.poll(() => physical.bufferedAmount).toBeGreaterThan(0);
  expect(completed).toBe(false);
  expect(physical.bufferedAmount).toBeLessThan(64 * 1024 * 1024);
  receiver.resume();
  tcp.uncork();
  await pending;
  await channels[1]!.send("sibling-after");
  await expect
    .poll(() => received.some((frame) => !frame.binary && frame.bytes.includes("sibling-after")))
    .toBe(true);
  const binary = received.find((frame) => frame.binary)!;
  expect(Buffer.from(decodeHostRouteFrame(binary.bytes)!.payload).equals(bytes)).toBe(true);
  expect(wss.clients.size).toBe(1);
});

import { existsSync } from "node:fs";
test.skipIf(process.platform !== "linux" || !existsSync("/usr/sbin/sshd"))(
  "real SSH shares one tunnel across scopes and owns fresh attempts after recovery",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hosts-ssh-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const run = promisify(execFile);
    for (const name of ["host", "client"])
      await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", join(root, name)]);
    const authorized = await readFile(join(root, "client.pub"));
    await writeFile(join(root, "authorized_keys"), authorized);
    const portServer = createServer();
    portServer.listen(0, "127.0.0.1");
    await once(portServer, "listening");
    const address = portServer.address();
    if (!address || typeof address === "string") throw new Error("Missing SSH port");
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    await writeFile(
      join(root, "sshd_config"),
      `Port ${address.port}\nListenAddress 127.0.0.1\nHostKey ${root}/host\nPidFile ${root}/pid\nAuthorizedKeysFile ${root}/authorized_keys\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowTcpForwarding yes\n`,
    );
    await writeFile(
      join(root, "ssh"),
      `#!/bin/sh\nprintf 'attempt\\n' >> '${root}/attempts'\nexec /usr/bin/ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile='${root}/known_hosts' -i '${root}/client' "$@"\n`,
    );
    await chmod(join(root, "ssh"), 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${root}:${originalPath}`;
    cleanup.push(async () => {
      process.env.PATH = originalPath;
    });
    const b = await createTestPaseoDaemon({ auth: { password: hashSync("ssh-password", 4) } });
    cleanup.push(() => b.close());
    const a = await daemon();
    const { paseo, client } = await api(a);
    const host = await paseo.hosts.add({
      connection: `ssh://${userInfo().username}@127.0.0.1:${address.port}?daemonPort=${b.port}&password=ssh-password`,
    });
    await expect.poll(async () => (await paseo.hosts.list()).hosts[0]?.status).toBe("offline");
    const sshd = spawn("/usr/sbin/sshd", [
      "-D",
      "-f",
      join(root, "sshd_config"),
      "-E",
      join(root, "sshd.log"),
    ]);
    cleanup.push(async () => {
      sshd.kill();
    });
    await online(paseo);
    const attempts = async () =>
      (await readFile(join(root, "attempts"), "utf8")).trim().split("\n").length;
    const before = await attempts();
    const first = await paseo.hosts.client(b.daemon.getServerId());
    const sibling = await paseo.hosts.client(b.daemon.getServerId());
    expect((await sibling.workspaces.list()).entries).toEqual([]);
    expect(await attempts()).toBe(before);
    await first.dispose();
    expect((await sibling.workspaces.list()).entries).toEqual([]);
    expect(await attempts()).toBe(before);
    const workspace = await sibling.workspaces.create({
      source: { kind: "directory", path: b.staticDir },
    });
    const terminal = await workspace.terminals.create({
      command: process.execPath,
      args: ["-e", "process.stdin.on('data', data => process.stdout.write(data))"],
    });
    const stream = await RoutePeer.open(client, b.daemon.getServerId());
    await stream.subscribeTerminal(terminal.id);
    stream.input("SSH_BINARY_BEFORE\n");
    await expect.poll(() => stream.output()).toContain("SSH_BINARY_BEFORE");
    await stream.close();
    expect(await attempts()).toBe(before);

    await paseo.hosts.update(host.registrationId, { enabled: false });
    await paseo.hosts.update(host.registrationId, { enabled: true });
    await online(paseo);
    await expect
      .poll(
        async () => {
          try {
            return (await sibling.workspaces.list()).entries.length;
          } catch {
            return -1;
          }
        },
        { timeout: 15000 },
      )
      .toBe(1);
    expect(await attempts()).toBe(before + 1);
    const resumed = await RoutePeer.open(client, b.daemon.getServerId());
    await resumed.subscribeTerminal(terminal.id);
    resumed.input("SSH_BINARY_AFTER\n");
    await expect.poll(() => resumed.output()).toContain("SSH_BINARY_AFTER");
    await resumed.close();
    await terminal.kill();
    expect(await attempts()).toBe(before + 1);
    await sibling.dispose();
    await paseo.hosts.update(host.registrationId, { enabled: false });
    await writeFile(join(root, "authorized_keys"), "");
    await paseo.hosts.update(host.registrationId, { enabled: true });
    await expect
      .poll(async () => (await paseo.hosts.list()).hosts[0]?.error?.code, { timeout: 15000 })
      .toBe("authentication_failed");
    expect((await paseo.hosts.list()).hosts[0]?.nextRetryAt).toBeNull();
    await writeFile(join(root, "authorized_keys"), authorized);
    await paseo.hosts.update(host.registrationId, { enabled: true });
    await online(paseo);
  },
  60000,
);

test("malformed routing headers terminate their physical source and leave the daemon usable", async () => {
  const b = await daemon();
  const socket = new WebSocket(`ws://127.0.0.1:${b.port}/ws`);
  cleanup.push(async () => socket.terminate());
  await once(socket, "open");
  const info = once(socket, "message");
  socket.send(
    JSON.stringify({
      type: "hello",
      clientId: "malformed-route",
      clientType: "cli",
      protocolVersion: 1,
      capabilities: { owned_subscriptions: true },
    }),
  );
  await info;
  const opened = once(socket, "message");
  socket.send(
    JSON.stringify({
      type: "session",
      message: { type: "hosts.link.open.request", requestId: "channel", channelId: "channel" },
    }),
  );
  const [response] = await opened;
  expect(JSON.parse(String(response)).message.type).toBe("hosts.link.open.response");
  const closed = once(socket, "close");
  socket.send(new Uint8Array([0x30, 0, 3, 97]));
  expect((await closed)[0]).toBe(1008);
  expect((await (await api(b)).paseo.workspaces.list()).entries).toEqual([]);
});

test("cancelling a logical scope during admission settles it and releases its owned channel", async () => {
  const source = {};
  const messages: SessionOutboundMessage[] = [];
  const delivery = new SessionDelivery((_source, message) => {
    messages.push(message);
  });
  delivery.attach(source, true);
  let pendingSocket: VirtualHostSocket | undefined;
  const endpoint = new DaemonLinkEndpoint({
    identity: "physical",
    permissions: () => ["daemon.read"],
    routed: () => false,
    bufferedAmount: () => 0,
    delivery,
    admit: (socket) =>
      new Promise<void>((resolve) => {
        pendingSocket = socket;
        socket.once("close", resolve);
      }),
  });
  const open = {
    type: "hosts.link.open.request" as const,
    requestId: "pending",
    channelId: "logical-scope",
  };
  const acquiring = delivery.request(source, open, () => endpoint.dispatch(open));
  expect(pendingSocket).toBeDefined();
  const cancel = { type: "hosts.route.close.request" as const, scopeId: "logical-scope" };
  expect(endpoint.handles(cancel)).toBe(true);
  await delivery.request(source, cancel, () => endpoint.dispatch(cancel));
  await acquiring;
  expect(pendingSocket!.readyState).toBe(3);
  expect(messages.some((message) => message.type === "hosts.link.open.response")).toBe(false);
  expect(messages.filter((message) => message.type === "hosts.route.closed")).toHaveLength(1);
  endpoint.close();
  await delivery.close();
});

test(
  "agent MCP discovers hosts, creates children on self and B, and notifies their parent",
  { timeout: 30000 },
  async () => {
    const parentPrompts: string[] = [];
    const a = await daemon({
      agentClients: createTestAgentClients({
        onStartTurn: (prompt, config) => {
          if (config.title === "Fleet parent") parentPrompts.push(JSON.stringify(prompt));
        },
      }),
    });
    const b = await daemon();
    const { paseo, client: aClient } = await api(a);
    await paseo.hosts.add({ connection: `127.0.0.1:${b.port}`, label: "Fleet B" });
    const directory = await online(paseo);
    const workspace = await paseo.workspaces.create({
      source: { kind: "directory", path: a.staticDir },
    });
    const parent = await workspace.agents.create({
      config: { provider: "claude/claude-test" },
      title: "Fleet parent",
    });
    const mcp = new Client({ name: "fleet-delegation", version: "1" });
    cleanup.push(() => mcp.close());
    await mcp.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${a.port}/mcp/agents?callerAgentId=${parent.id}`),
      ),
    );
    const result = await mcp.callTool({ name: "list_hosts", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      self: { serverId: directory.self.serverId },
      hosts: [
        expect.objectContaining({ serverId: directory.hosts[0]!.serverId, label: "Fleet B" }),
      ],
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await mcp.callTool({ name, arguments: args });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return z.record(z.string(), z.unknown()).parse(response.structuredContent);
    };
    const serverId = directory.hosts[0]!.serverId!;
    const destination = await call("create_workspace", {
      serverId,
      isolation: "local",
      path: b.staticDir,
      title: "Destination workspace",
    });
    expect(await call("list_workspaces", { serverId })).toMatchObject({
      serverId,
      workspaces: [expect.objectContaining({ workspaceId: destination.workspaceId })],
    });
    const self = await call("create_agent", {
      title: "Self child",
      provider: "claude/claude-test",
      initialPrompt: "Finish local delegation",
    });
    const remote = await call("create_agent", {
      serverId,
      workspaceId: destination.workspaceId,
      title: "B child",
      provider: "claude/claude-test",
      initialPrompt: "Finish destination delegation",
    });
    expect(self.serverId).toBe(directory.self.serverId);
    expect(remote.serverId).toBe(serverId);
    const bApi = await api(b);
    expect(
      (await bApi.paseo.agents.ref(String(remote.agentId)).refresh())?.agent.labels,
    ).toMatchObject({
      "paseo.parent-agent-id": parent.id,
      "paseo.parent-server-id": directory.self.serverId,
    });
    await expect
      .poll(() => parentPrompts.join("\n"), { timeout: 10000 })
      .toContain(`Agent ${self.agentId}`);
    await expect
      .poll(() => parentPrompts.join("\n"), { timeout: 10000 })
      .toContain(`Agent ${remote.agentId}`);
    expect(parentPrompts.join("\n")).toContain(`Server: ${serverId}`);
    expect(parentPrompts.join("\n")).toContain(`Server: ${directory.self.serverId}`);

    await aClient.createAgent({
      agentId: String(remote.agentId),
      provider: "claude",
      model: "claude-test",
      cwd: a.staticDir,
      workspaceId: workspace.id,
      title: "Unrelated equal ID on A",
    });
    expect(await call("get_agent_status", { serverId, agentId: remote.agentId })).toMatchObject({
      serverId,
      snapshot: { id: remote.agentId, title: "B child", cwd: b.staticDir },
    });
    expect(await call("get_agent_status", { agentId: remote.agentId })).toMatchObject({
      serverId: directory.self.serverId,
      snapshot: { title: "Unrelated equal ID on A" },
    });
    const beforeFollowup = parentPrompts.filter((prompt) =>
      prompt.includes(`Agent ${remote.agentId}`),
    ).length;
    expect(beforeFollowup).toBe(1);
    expect(
      await call("send_agent_prompt", {
        serverId,
        agentId: remote.agentId,
        prompt: "REMOTE_FOLLOWUP_MARKER",
        sessionMode: "full-access",
      }),
    ).toMatchObject({ success: true, serverId, guidance: expect.stringContaining("notified") });
    await bApi.client.waitForFinish(String(remote.agentId), 10000);
    expect(await call("get_agent_activity", { serverId, agentId: remote.agentId })).toMatchObject({
      serverId,
      agentId: remote.agentId,
      currentModeId: "full-access",
      content: expect.stringContaining("REMOTE_FOLLOWUP_MARKER"),
    });
    expect(await call("list_agents", { serverId })).toMatchObject({
      serverId,
      agents: expect.arrayContaining([
        expect.objectContaining({ id: remote.agentId, title: "B child", cwd: b.staticDir }),
      ]),
    });
    expect(await call("list_agents", {})).toMatchObject({
      serverId: directory.self.serverId,
      agents: expect.arrayContaining([
        expect.objectContaining({
          id: remote.agentId,
          title: "Unrelated equal ID on A",
          cwd: a.staticDir,
        }),
      ]),
    });
    await expect
      .poll(
        () => parentPrompts.filter((prompt) => prompt.includes(`Agent ${remote.agentId}`)).length,
        { timeout: 10000 },
      )
      .toBe(2);
    expect(
      parentPrompts.findLast((prompt) => prompt.includes(`Agent ${remote.agentId}`)),
    ).toContain(`Server: ${serverId}`);
    expect((await aClient.fetchAgent(String(remote.agentId)))?.agent.lastUserMessageAt).toBeNull();
    expect(JSON.stringify(await aClient.fetchAgentTimeline(String(remote.agentId)))).not.toContain(
      "REMOTE_FOLLOWUP_MARKER",
    );

    for (const selector of [{}, { serverId: directory.self.serverId }]) {
      expect(await call("get_agent_status", { ...selector, agentId: self.agentId })).toMatchObject({
        serverId: directory.self.serverId,
        snapshot: { title: "Self child" },
      });
      const previous = parentPrompts.filter((prompt) =>
        prompt.includes(`Agent ${self.agentId}`),
      ).length;
      expect(
        await call("send_agent_prompt", {
          ...selector,
          agentId: self.agentId,
          prompt: "SELF_FOLLOWUP_MARKER",
        }),
      ).toMatchObject({
        success: true,
        serverId: directory.self.serverId,
        deliveryStatus: "queued",
      });
      await aClient.waitForFinish(String(self.agentId), 10000);
      expect(
        await call("get_agent_activity", { ...selector, agentId: self.agentId }),
      ).toMatchObject({
        serverId: directory.self.serverId,
        content: expect.stringContaining("SELF_FOLLOWUP_MARKER"),
      });
      expect(await call("list_agents", selector)).toMatchObject({
        serverId: directory.self.serverId,
        agents: expect.arrayContaining([
          expect.objectContaining({ id: self.agentId, title: "Self child" }),
        ]),
      });
      await expect
        .poll(
          () => parentPrompts.filter((prompt) => prompt.includes(`Agent ${self.agentId}`)).length,
          { timeout: 10000 },
        )
        .toBe(previous + 1);
    }
  },
);

test(
  "remote agent reports, local CLI sends and automatic completion share the recipient batch",
  { timeout: 30000 },
  async () => {
    const parentPrompts: string[] = [];
    const childStarted = Promise.withResolvers<void>();
    const finishChild = Promise.withResolvers<void>();
    cleanup.push(async () => {
      finishChild.resolve();
    });
    const a = await daemon({
      agentClients: createTestAgentClients({
        onStartTurn: (prompt, config) => {
          if (config.title === "Batch parent")
            parentPrompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
        },
      }),
    });
    const b = await daemon({
      agentClients: createTestAgentClients({
        onStartTurn: () => childStarted.resolve(),
        beforeTurnComplete: () => finishChild.promise,
      }),
    });
    const origin = await api(a);
    const destination = await api(b);
    await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
    await destination.paseo.hosts.add({ connection: `127.0.0.1:${a.port}` });
    const aDirectory = await online(origin.paseo);
    const bDirectory = await online(destination.paseo);
    const aId = aDirectory.self.serverId;
    const bId = bDirectory.self.serverId;
    const aWorkspace = await origin.paseo.workspaces.create({
      source: { kind: "directory", path: a.staticDir },
    });
    const bWorkspace = await destination.paseo.workspaces.create({
      source: { kind: "directory", path: b.staticDir },
    });
    const parent = await aWorkspace.agents.create({
      config: { provider: "claude/claude-test", modeId: "full-access" },
      title: "Batch parent",
    });
    const child = await bWorkspace.agents.create({
      config: { provider: "claude/claude-test", modeId: "full-access" },
      title: "Batch child",
      labels: { "paseo.parent-agent-id": parent.id, "paseo.parent-server-id": aId },
    });
    const caller = async (host: TestPaseoDaemon, agentId: string) => {
      const mcp = new Client({ name: "batching-agent", version: "1" });
      await mcp.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${host.port}/mcp/agents?callerAgentId=${agentId}`),
        ),
      );
      cleanup.push(() => mcp.close());
      return mcp;
    };
    const parentMcp = await caller(a, parent.id);
    const childMcp = await caller(b, child.id);
    const task = await parentMcp.callTool({
      name: "send_agent_prompt",
      arguments: { serverId: bId, agentId: child.id, prompt: "Do the delegated task" },
    });
    expect(task.isError).not.toBe(true);
    expect(task.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining('"deliveryStatus": "queued"'),
      }),
    ]);
    expect(task.structuredContent).toMatchObject({
      success: true,
      deliveryStatus: "queued",
      serverId: bId,
    });
    // An idle recipient must not report old idle as completion of its queued task.
    expect((await destination.client.waitForFinish(child.id, 50)).status).toBe("timeout");
    await childStarted.promise;
    const report = await childMcp.callTool({
      name: "send_agent_prompt",
      arguments: {
        serverId: aId,
        agentId: parent.id,
        prompt: "REMOTE_REPORT <ready>",
        notifyOnFinish: false,
      },
    });
    expect(report.isError).not.toBe(true);
    expect(report.structuredContent).toMatchObject({ deliveryStatus: "queued", serverId: aId });
    expect(parentPrompts).toEqual([]);

    const cli = await promisify(execFile)(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        fileURLToPath(new URL("../../../../cli/src/index.ts", import.meta.url)),
        "--host",
        `127.0.0.1:${a.port}`,
        "send",
        parent.id,
        "LOCAL_CLI_REPORT",
        "--no-wait",
        "--json",
      ],
      {
        env: { ...process.env, PASEO_AGENT_ID: parent.id },
        timeout: 15000,
      },
    );
    expect(JSON.parse(cli.stdout)).toMatchObject({ status: "queued" });
    expect(parentPrompts).toEqual([]);
    const receiptStates = async () => {
      const directory = join(a.paseoHome, "agent-requests");
      const receipts = await Promise.all(
        (await readdir(directory))
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8"))),
      );
      return receipts
        .filter(
          (receipt) => receipt.agentId === parent.id && typeof receipt.fingerprint === "string",
        )
        .map((receipt) => receipt.state)
        .sort();
    };
    expect(await receiptStates()).toEqual(["pending", "pending"]);
    finishChild.resolve();
    await expect.poll(() => parentPrompts, { timeout: 10000 }).toHaveLength(1);
    expect(parentPrompts[0]).toContain("REMOTE_REPORT &lt;ready&gt;");
    expect(parentPrompts[0]).toContain("LOCAL_CLI_REPORT");
    expect(parentPrompts[0]).toContain('event="finished"');
    expect(parentPrompts[0]).toContain(`source-agent-id="${child.id}"`);
    await expect.poll(receiptStates, { timeout: 10000 }).toEqual(["completed", "completed"]);
    const timeline = await origin.client.fetchAgentTimeline(parent.id);
    const messages = timeline.entries.flatMap((row) =>
      row.item.type === "tool_call" && row.item.agentMessage ? [row.item.agentMessage] : [],
    );
    expect(
      messages.map((message) => [message.event, message.sender.id, message.sender.serverId]),
    ).toEqual([
      ["message", child.id, bId],
      ["message", parent.id, undefined],
      ["finished", child.id, bId],
    ]);
    expect(messages[0]!.text).toBe("REMOTE_REPORT <ready>");
    expect(timeline.entries.filter((row) => row.item.type === "user_message")).toEqual([]);

    const human = await aWorkspace.agents.create({
      config: { provider: "claude/claude-test", modeId: "full-access" },
      title: "Human recipient",
    });
    expect(await origin.client.sendAgentMessage(human.id, "HUMAN_PROMPT")).toEqual({});
    expect(
      (await origin.client.fetchAgentTimeline(human.id)).entries.some(
        (row) => row.item.type === "user_message" && row.item.text === "HUMAN_PROMPT",
      ),
    ).toBe(true);
  },
);

test(
  "remote top-level sends set the mode through the existing RPC before sending",
  { timeout: 15000 },
  async () => {
    const a = await daemon();
    const b = await daemon();
    const wire = await hostWire(b);
    const origin = await api(a);
    const destination = await api(b);
    await origin.paseo.hosts.add({ connection: wire.connection });
    const serverId = (await online(origin.paseo)).hosts[0]!.serverId!;
    const workspace = await destination.paseo.workspaces.create({
      source: { kind: "directory", path: b.staticDir },
    });
    const agent = await workspace.agents.create({
      config: { provider: "claude/claude-test", modeId: "default" },
      title: "Human mode recipient",
    });
    const mcp = new Client({ name: "human-mode-send", version: "1" });
    cleanup.push(() => mcp.close());
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${a.port}/mcp/agents`)),
    );
    const response = await mcp.callTool({
      name: "send_agent_prompt",
      arguments: { serverId, agentId: agent.id, prompt: "Human task", sessionMode: "full-access" },
    });
    expect(response.isError).not.toBe(true);
    expect((await destination.client.fetchAgent(agent.id))?.agent.currentModeId).toBe(
      "full-access",
    );
    const requests = wire.frames
      .filter((frame) => frame.direction === "toB" && !frame.binary)
      .flatMap((frame) => {
        const outer = JSON.parse(frame.bytes.toString());
        if (outer.type !== "session" || outer.message.type !== "hosts.route.frame.request")
          return [];
        const inner = JSON.parse(outer.message.data);
        return inner.type === "session" ? [inner.message] : [];
      })
      .filter(
        (message) =>
          message.type === "set_agent_mode_request" ||
          message.type === "send_agent_message_request",
      );
    expect(requests.map((message) => message.type)).toEqual([
      "set_agent_mode_request",
      "send_agent_message_request",
    ]);
    expect(requests[1]).not.toHaveProperty("sessionMode");
  },
);
