import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { OpenCodeBridge } from "../bridge.js";
import { provisionLocalBridge } from "./bridge-provisioning.js";
import { V2Runtime } from "./runtime.js";

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
