import { resolveDaemonVersion } from "../daemon-version.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createPaseoClient, type PaseoClient, type DaemonEvent } from "@getpaseo/client";
import type { WorkspaceScriptPayload } from "../messages.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const SCRIPT_NAME = "sleeper";
const OBSERVE_TIMEOUT_MS = 15_000;

let daemon: TestPaseoDaemon;
let client: DaemonClient;
let cwd: string;
let sdk: PaseoClient;
const cleanupClients = new Set<DaemonClient>();

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "terminal-workspace-sdk-"));
  daemon = await createTestPaseoDaemon();
  client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await client.connect();
  sdk = createPaseoClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await sdk.connect();
});

afterEach(async () => {
  await Promise.all(Array.from(cleanupClients, (peer) => peer.close()));
  cleanupClients.clear();
  await client.close();
  await sdk.close();
  await daemon.close();
  await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

test("SDK and workspace handles preserve ownership and actual process directories", async () => {
  const first = await createWorkspace("main");
  const second = await createWorkspace("feature-work");
  const nested = path.join(cwd, "nested");
  await mkdir(nested);
  const a = await sdk.terminals.create({ workspaceId: first, name: "Main" });
  const b = await sdk.workspaces.ref(second).terminals.create({ name: "Feature", cwd: nested });
  const c = await sdk.terminals.create({
    workspaceId: second,
    cwd: daemon.staticDir,
    name: "Outside",
  });
  expect(a.current()).toEqual({ id: a.id, workspaceId: first, cwd, name: "Main" });
  expect(b.current()).toEqual({ id: b.id, workspaceId: second, cwd: nested, name: "Feature" });
  expect(c.current()).toEqual({
    id: c.id,
    workspaceId: second,
    cwd: daemon.staticDir,
    name: "Outside",
  });
  const result = await sdk.workspaces.ref(second).terminals.list({ requestId: "feature-list" });
  expect(result.requestId).toBe("feature-list");
  expect(result.entries).toEqual(expect.arrayContaining([b.current(), c.current()]));
  expect(result.entries).toHaveLength(2);
  expect((await sdk.terminals.list()).entries).toHaveLength(3);
  expect((await sdk.terminals.list({ cwd })).entries).toEqual([a.current(), b.current()]);
  const ref = sdk.terminals.ref(b.id);
  expect(ref.current()).toBeNull();
  expect(await ref.refresh()).toEqual(b.current());
  await ref.kill();
  expect(await ref.refresh()).toBeNull();
  expect((await sdk.terminals.list({ workspaceId: second })).entries).toEqual([c.current()]);
  expect((await sdk.terminals.list({ workspaceId: first })).entries).toEqual([a.current()]);
});

test("SDK creates a command terminal and sends literal input and key tokens", async () => {
  const workspaceId = await createWorkspace("Input");
  const terminal = await sdk.terminals.create({
    workspaceId,
    command: process.execPath,
    args: [
      "-e",
      "process.stdin.setRawMode(true); process.stdin.resume(); console.log('READY'); let hex = ''; process.stdin.on('data', data => { hex += data.toString('hex'); console.log('HEX:' + hex); });",
    ],
    size: { rows: 35, cols: 120 },
  });
  const screen = async () => (await terminal.capture({ stripAnsi: true })).lines.join("\n");
  await expect.poll(screen).toContain("READY");
  expect(terminal.write("Enter")).toBe(5);
  await expect.poll(screen).toContain("HEX:456e746572");
  expect(terminal.sendKeys(["Enter", "Tab", "Escape", "C-c"])).toBe(4);
  await expect.poll(screen).toContain("HEX:456e7465720d091b03");
  const capture = await terminal.capture({
    start: 0,
    end: 0,
    stripAnsi: true,
    requestId: "capture-first",
  });
  expect(capture).toMatchObject({ terminalId: terminal.id, requestId: "capture-first" });
  expect(capture.lines).toHaveLength(1);
  await terminal.kill();
  expect(terminal.current()).toBeNull();
  expect((await sdk.terminals.list({ workspaceId })).entries).toEqual([]);
});

test("terminal creation rejects unknown and archived owners, including explicit cwd overrides", async () => {
  const workspaceId = await createWorkspace("Archived");
  await sdk.workspaces.ref(workspaceId).archive();
  for (const id of [workspaceId, "wks_missing"]) {
    await expect(sdk.terminals.create({ workspaceId: id })).rejects.toThrow(/not active/);
    await expect(sdk.terminals.create({ workspaceId: id, cwd })).rejects.toThrow(/not active/);
    const raw = await client.createTerminal(cwd, undefined, undefined, { workspaceId: id });
    expect(raw).toMatchObject({
      terminal: null,
      error: `Workspace ${id} is not active or does not exist`,
    });
  }
  expect((await sdk.terminals.list()).entries).toEqual([]);
  expect((await client.fetchWorkspaces()).entries).toEqual([]);
});

test("plugin handlers operate terminals through their host-owned Paseo API", async () => {
  const workspaceId = await createWorkspace("Plugin workspace");
  const pluginDirectory = path.join(cwd, "plugin");
  await mkdir(pluginDirectory);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: "terminal-sdk",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const operate = defineRpc({ name: "operate", input: z.object({ workspaceId: z.string(), command: z.string() }), output: z.object({ workspaceIds: z.array(z.string()), lines: z.array(z.string()), remaining: z.number() }) });
async function waitForTerminalOutput(terminal, text) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const capture = await terminal.capture({ stripAnsi: true });
    if (capture.lines.some(line => line.includes(text))) return capture.lines;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for plugin terminal output: " + text);
}
export default function contribute(server) {
  server.handle(operate, async ({ workspaceId, command }, { paseo }) => {
    const workspace = paseo.workspaces.ref(workspaceId);
    const terminal = await workspace.terminals.create({ command, args: ["-e", "process.stdin.setRawMode(true); process.stdin.resume(); console.log('PLUGIN READY'); let hex = ''; process.stdin.on('data', data => { hex += data.toString('hex'); console.log('PLUGIN:' + hex); });"] });
    try {
      await waitForTerminalOutput(terminal, "PLUGIN READY");
      terminal.write("Enter");
      await waitForTerminalOutput(terminal, "PLUGIN:456e746572");
      terminal.sendKeys(["Enter"]);
      const lines = await waitForTerminalOutput(terminal, "PLUGIN:456e7465720d");
      const listed = await workspace.terminals.list();
      await paseo.terminals.ref(terminal.id).kill();
      return { workspaceIds: listed.entries.map(entry => entry.workspaceId), lines, remaining: (await workspace.terminals.list()).entries.length };
    } finally {
      await terminal.kill();
    }
  });
  return () => {};
}`,
  );
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installDirectoryPlugin(pluginDirectory);
  try {
    const result = await client.invokePluginRpc("terminal-sdk", "operate", {
      workspaceId,
      command: process.execPath,
    });
    expect(result).toMatchObject({
      workspaceIds: [workspaceId],
      remaining: 0,
      lines: expect.arrayContaining([expect.stringContaining("PLUGIN:456e7465720d")]),
    });
  } finally {
    await client.removePlugin("terminal-sdk");
  }
}, 30_000);

async function createWorkspace(title: string): Promise<string> {
  const result = await client.createWorkspace({ source: { kind: "directory", path: cwd }, title });
  if (!result.workspace) throw new Error(result.error ?? "Workspace creation failed");
  return result.workspace.id;
}

test("listing by workspace ID keeps terminals in a shared directory separate", async () => {
  const first = await createWorkspace("main");
  const second = await createWorkspace("feature-work");
  await client.createTerminal(cwd, "main terminal", undefined, { workspaceId: first });
  const created = await client.createTerminal(cwd, "feature terminal", undefined, {
    workspaceId: second,
  });
  expect(created.error).toBeNull();

  const result = await client.listTerminals(undefined, undefined, { workspaceId: second });
  expect(result.terminals).toEqual([
    expect.objectContaining({ id: created.terminal?.id, workspaceId: second, cwd }),
  ]);
});

async function connectClient(): Promise<DaemonClient> {
  const peer = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  cleanupClients.add(peer);
  await peer.connect();
  await peer.fetchAgents({ subscribe: {} });
  return peer;
}

function recordScriptLifecycles(peer: DaemonClient) {
  const updates: WorkspaceScriptPayload[] = [];
  peer.subscribe((event: DaemonEvent) => {
    if (event.type !== "workspace_update" || event.payload.kind !== "upsert") return;
    const script = event.payload.workspace.scripts.find(
      (entry) => entry.scriptName === SCRIPT_NAME,
    );
    if (!script) return;
    updates.push(script);
  });
  return updates;
}

test("workspace script lifecycle reaches other subscribed clients and only them", async () => {
  await writeFile(
    path.join(cwd, "paseo.json"),
    JSON.stringify({
      scripts: {
        [SCRIPT_NAME]: { type: "script", command: 'node -e "setInterval(() => {}, 1000)"' },
      },
    }),
  );

  const observer = await connectClient();
  const unsubscribed = await connectClient();
  await client.fetchWorkspaces({ subscribe: {} });
  await observer.fetchWorkspaces({ subscribe: {} });

  const observed = recordScriptLifecycles(observer);
  const bystander: string[] = [];
  unsubscribed.subscribe((event: DaemonEvent) => {
    if (event.type === "workspace_update") bystander.push(event.workspaceId);
  });

  const opened = await client.openProject(cwd);
  expect(opened.error).toBeNull();
  const workspaceId = opened.workspace!.id;

  // Exclude the initial stopped state from the lifecycle assertions.
  await expect.poll(() => observed[0]?.lifecycle, { timeout: OBSERVE_TIMEOUT_MS }).toBe("stopped");
  const afterCreate = observed.length;

  const started = await client.startWorkspaceScriptWithStatus(workspaceId, SCRIPT_NAME);
  expect(started.error).toBeNull();
  expect(started.script?.lifecycle).toBe("running");
  await expect
    .poll(() => observed[afterCreate]?.lifecycle, { timeout: OBSERVE_TIMEOUT_MS })
    .toBe("running");

  const stopped = await client.stopWorkspaceScript(workspaceId, SCRIPT_NAME);
  expect(stopped.error).toBeNull();
  expect(stopped.script?.lifecycle).toBe("stopped");
  await expect
    .poll(() => observed[afterCreate + 1]?.lifecycle, { timeout: OBSERVE_TIMEOUT_MS })
    .toBe("stopped");

  expect(observed.slice(afterCreate).map((script) => script.lifecycle)).toEqual([
    "running",
    "stopped",
  ]);

  await unsubscribed.listWorkspaceScripts(workspaceId);
  expect(bystander).toEqual([]);
}, 60_000);

test("a workspace script exiting on its own reaches other subscribed clients", async () => {
  await writeFile(
    path.join(cwd, "paseo.json"),
    JSON.stringify({
      scripts: {
        [SCRIPT_NAME]: {
          type: "script",
          command: `node -e "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync('exit')) clearInterval(timer); }, 10)" && exit`,
        },
      },
    }),
  );

  const observer = await connectClient();
  await observer.fetchWorkspaces({ subscribe: {} });
  const observed = recordScriptLifecycles(observer);

  const opened = await client.openProject(cwd);
  expect(opened.error).toBeNull();
  await expect.poll(() => observed[0]?.lifecycle, { timeout: OBSERVE_TIMEOUT_MS }).toBe("stopped");
  const afterCreate = observed.length;

  const started = await client.startWorkspaceScriptWithStatus(opened.workspace!.id, SCRIPT_NAME);
  expect(started.error).toBeNull();
  await expect
    .poll(() => observed[afterCreate]?.lifecycle, { timeout: OBSERVE_TIMEOUT_MS })
    .toBe("running");
  await writeFile(path.join(cwd, "exit"), "");
  await expect
    .poll(() => observed[afterCreate + 1], { timeout: OBSERVE_TIMEOUT_MS })
    .toMatchObject({
      scriptName: SCRIPT_NAME,
      terminalId: started.script!.terminalId,
      lifecycle: "stopped",
      exitCode: 0,
    });
  expect(observed.slice(afterCreate).map((script) => script.lifecycle)).toEqual([
    "running",
    "stopped",
  ]);
}, 60_000);

test("an immediately exiting script reaches observers with its final status", async () => {
  await writeFile(
    path.join(cwd, "paseo.json"),
    JSON.stringify({
      scripts: { [SCRIPT_NAME]: { type: "script", command: 'node -e "process.exit(0)" && exit' } },
    }),
  );

  const observer = await connectClient();
  await observer.fetchWorkspaces({ subscribe: {} });
  const observed = recordScriptLifecycles(observer);

  const opened = await client.openProject(cwd);
  expect(opened.error).toBeNull();
  await expect.poll(() => observed[0]?.lifecycle, { timeout: OBSERVE_TIMEOUT_MS }).toBe("stopped");
  const afterCreate = observed.length;

  const started = await client.startWorkspaceScriptWithStatus(opened.workspace!.id, SCRIPT_NAME);
  expect(started.error).toBeNull();
  expect(started.script!.terminalId).toEqual(expect.any(String));
  await expect
    .poll(() => observed.slice(afterCreate).find((script) => script.lifecycle === "stopped"), {
      timeout: OBSERVE_TIMEOUT_MS,
    })
    .toMatchObject({
      scriptName: SCRIPT_NAME,
      terminalId: started.script!.terminalId,
      lifecycle: "stopped",
      exitCode: 0,
    });
}, 60_000);
