import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { OpenCodeBridge } from "../bridge.js";
import { provisionLocalBridge } from "./bridge-provisioning.js";
import { V2Runtime, type V2Connection } from "./runtime.js";

test("an owned helper uses an installed bridge once and survives catalog refresh", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-owned-opencode-"));
  const config = path.join(root, "config", "opencode");
  const script = path.join(root, "server.cjs");
  const record = path.join(root, "env.json");
  const bridge = new OpenCodeBridge({ paseoHome: root, logger: createTestLogger() });
  await bridge.start();
  const artifact = fileURLToPath(await bridge.materializeV2Plugin());
  await provisionLocalBridge({
    configDirectory: config,
    artifact: path.join(artifact, "server.js"),
  });
  await writeFile(
    script,
    `
    const http = require('node:http');
    require('node:fs').writeFileSync(${JSON.stringify(record)}, process.env.OPENCODE_CONFIG_CONTENT);
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
    });
    server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
  `,
  );
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    bridge,
    selection: { kind: "owned" },
    settings: {
      command: { mode: "replace", argv: [process.execPath, script] },
      env: { XDG_CONFIG_HOME: path.join(root, "config"), OPENCODE_CONFIG_CONTENT: "{}" },
    },
  });
  try {
    const first = await runtime.acquire();
    const pid = (await first.client.server.info()).pid;
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({});
    await first.release();
    const refreshed = await runtime.acquire({ fresh: true });
    expect((await refreshed.client.server.info()).pid).toBe(pid);
    await refreshed.release();
  } finally {
    await runtime.shutdown();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("reports a bridge port change that has not been applied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-port-"));
  const bridge = new OpenCodeBridge({ paseoHome: root, logger: createTestLogger() });
  await bridge.start();
  const actual = Number(new URL(bridge.sharedV2Connection().baseUrl).port);
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    bridge,
    selection: { kind: "explicit", server: { url: "http://127.0.0.1:1" } },
    settings: { env: { PASEO_OPENCODE_BRIDGE_PORT: actual === 1 ? "2" : "1" } },
  });
  try {
    await expect(runtime.acquire()).rejects.toThrow("restart Paseo to apply the bridge port");
  } finally {
    await runtime.shutdown();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the workspace scope starts one helper per workspace and stops it with its last user", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-scope-"));
  const script = path.join(root, "server.cjs");
  const records = path.join(root, "records");
  const bridge = new OpenCodeBridge({ paseoHome: root, logger: createTestLogger() });
  await bridge.start();
  await writeFile(
    script,
    `
    const http = require('node:http');
    const fs = require('node:fs');
    fs.mkdirSync(${JSON.stringify(records)}, { recursive: true });
    fs.writeFileSync(${JSON.stringify(records)} + '/' + process.pid, JSON.stringify({
      workspace: process.env.PASEO_WORKSPACE_ID ?? null,
      agent: process.env.SCOPE_TEST_AGENT ?? null,
    }));
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
    });
    server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
  `,
  );
  // A Paseo terminal running the test would otherwise pass its own workspace to every helper.
  vi.stubEnv("PASEO_WORKSPACE_ID", undefined);
  // No selection is injected: the scope itself must keep the runtime off discovered services.
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    bridge,
    settings: {
      command: { mode: "replace", argv: [process.execPath, script] },
      env: {
        PASEO_OPENCODE_SERVER_SCOPE: "workspace",
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
      },
    },
  });
  async function pidOf(connection: V2Connection): Promise<number> {
    return (await connection.client.server.info()).pid;
  }
  async function recordOf(pid: number): Promise<unknown> {
    return JSON.parse(await readFile(path.join(records, String(pid)), "utf8"));
  }
  try {
    const first = await runtime.acquire({ workspaceId: "wks_a" });
    const second = await runtime.acquire({ workspaceId: "wks_a" });
    const other = await runtime.acquire({ workspaceId: "wks_b" });
    const shared = await runtime.acquire();
    const isolated = await runtime.acquire({
      dedicated: true,
      env: { SCOPE_TEST_AGENT: "agent" },
      workspaceId: "wks_a",
    });
    const workspacePid = await pidOf(first);
    expect(await pidOf(second)).toBe(workspacePid);
    expect(
      new Set([workspacePid, await pidOf(other), await pidOf(shared), await pidOf(isolated)]).size,
    ).toBe(4);
    expect(await recordOf(workspacePid)).toEqual({ workspace: "wks_a", agent: null });
    expect(await recordOf(await pidOf(other))).toEqual({ workspace: "wks_b", agent: null });
    expect(await recordOf(await pidOf(shared))).toEqual({ workspace: null, agent: null });
    expect(await recordOf(await pidOf(isolated))).toEqual({ workspace: "wks_a", agent: "agent" });

    await first.release();
    await second.release();
    await second.exited;
    const restarted = await runtime.acquire({ workspaceId: "wks_a" });
    expect(await pidOf(restarted)).not.toBe(workspacePid);
    await Promise.all(
      [restarted, other, shared, isolated].map((connection) => connection.release()),
    );
  } finally {
    vi.unstubAllEnvs();
    await runtime.shutdown();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("a scope other than shared rejects a configured server URL", async () => {
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    settings: {
      env: {
        PASEO_OPENCODE_SERVER_URL: "http://127.0.0.1:1",
        PASEO_OPENCODE_SERVER_SCOPE: "workspace",
      },
    },
  });
  try {
    await expect(runtime.acquire()).rejects.toThrow(
      "PASEO_OPENCODE_SERVER_SCOPE=workspace starts Paseo's own OpenCode servers and cannot be combined with PASEO_OPENCODE_SERVER_URL",
    );
  } finally {
    await runtime.shutdown();
  }
});
