import { afterEach, expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { createHostClient } from "@getpaseo/client/node";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import type { HostDirectory } from "@getpaseo/protocol/hosts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function daemon(): Promise<TestPaseoDaemon> {
  const instance = await createTestPaseoDaemon();
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
  const a = await daemon();
  const { paseo } = await api(a);
  const observation = paseo.hosts.observe();
  expect((await observation.ready).hosts).toEqual([]);
  const saved = await paseo.hosts.add({ connection: `127.0.0.1:${b.port}`, label: "B" });
  const directory = await online(paseo);
  const serverId = directory.hosts[0]!.serverId!;
  const first = await paseo.hosts.client(serverId);
  const second = await paseo.hosts.client(serverId);
  const workspaces = await second.workspaces.list({ subscribe: {} });
  expect(workspaces.entries).toEqual([]);
  await first.dispose();
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
  await second.dispose();
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
  ).rejects.toMatchObject({ code: "permission_denied" });
  await expect(viewer.hosts.add({ connection: "127.0.0.1:1" })).rejects.toMatchObject({
    code: "permission_denied",
  });
  expect((await owner.paseo.hosts.list()).hosts).toHaveLength(1);
  await remote.dispose();
});

test("distinct origin sessions cannot collide through a caller-selected route scope, including terminal binary output", async () => {
  const b = await daemon();
  const a = await daemon();
  const admin = await api(a);
  await admin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
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
  first.input("FIRST_ONLY\n");
  second.input("SECOND_ONLY\n");
  await expect.poll(() => first.output()).toContain("FIRST_ONLY");
  await expect.poll(() => second.output()).toContain("SECOND_ONLY");
  expect(first.output()).not.toContain("SECOND_ONLY");
  expect(second.output()).not.toContain("FIRST_ONLY");
  await first.close();
  second.input("STILL_SECOND\n");
  await expect.poll(() => second.output()).toContain("STILL_SECOND");
  await second.close();
  await one.kill();
  await two.kill();
  await remote.dispose();
});

import {
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import {
  WSOutboundMessageSchema,
  type SessionOutboundMessage,
  type SessionInboundMessage,
} from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
class RoutePeer {
  readonly messages: SessionOutboundMessage[] = [];
  readonly bytes: Uint8Array[] = [];
  private slot = -1;
  private detach = () => {};
  private constructor(
    private readonly origin: DaemonClient,
    private readonly routeId: string,
  ) {
    this.detach = origin.subscribeRawMessages((message) => {
      if (message.type !== "hosts.route.frame" || message.payload.subscriptionId !== routeId)
        return;
      if (message.payload.binary) this.bytes.push(Buffer.from(message.payload.data, "base64"));
      else {
        const frame = WSOutboundMessageSchema.parse(JSON.parse(message.payload.data));
        if (frame.type === "session") this.messages.push(frame.message);
      }
    });
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
      false,
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
    this.origin.sendHostFrame(this.routeId, JSON.stringify({ type: "session", message }), false);
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
      Buffer.from(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          slot: this.slot,
          payload: text,
        }),
      ).toString("base64"),
      true,
    );
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

import { mkdir, writeFile, stat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

import { execFile } from "node:child_process";
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
  ).rejects.toMatchObject({ code: "permission_denied" });
  expect((await remote.workspaces.list()).entries).toEqual([]);
  await remote.dispose();
});

import { WebSocketServer } from "ws";
import { createServer } from "node:http";
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

test("losing a sent mutation result identifies the destination and never queues unavailable operations", async () => {
  const b = await daemon();
  const a = await daemon();
  const { paseo, client } = await api(a);
  await paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const serverId = (await online(paseo)).hosts[0]!.serverId!;
  const remote = await paseo.hosts.client(serverId);
  const pending = remote.config.patch({ pluginsEnabled: false });
  const result = pending.catch((error: unknown) => error);
  await client.close();
  expect(await result).toMatchObject({ code: "outcome_unknown", serverId });
  await expect(remote.workspaces.list()).rejects.toMatchObject({ code: "host_offline", serverId });
  await expect(remote.terminals.list()).rejects.toMatchObject({ code: "host_offline", serverId });
  await expect(
    remote.workspaces.create({
      source: { kind: "directory", path: "/tmp" },
      workspaceId: "offline-never-created",
    }),
  ).rejects.toMatchObject({ code: "host_offline", serverId });
  await remote.dispose();
});

test("disposing an origin during routed handshake settles acquisition and closes only its pending session", async () => {
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  let connections = 0;
  let routeHello = false;
  let routeClosed = false;
  ws.on("connection", (socket) => {
    const monitor = ++connections === 1;
    socket.on("close", () => {
      if (!monitor) routeClosed = true;
    });
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type !== "hello") return;
      if (monitor)
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "srv_pending",
                hostname: "pending",
                version: "0.11.0",
                features: { connectedHosts: true, ownedSubscriptions: true },
              },
            },
          }),
        );
      else routeHello = true;
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
});
