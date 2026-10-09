import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { OpenCodeBridge } from "./opencode/bridge.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";

describe("OpenCode bridge adapter", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  test("shares the server and binds exact managed env per OpenCode session", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-adapter-"));
    const bridge = new OpenCodeBridge({ paseoHome, logger: createTestLogger() });
    await bridge.start();
    cleanups.push(async () => {
      await bridge.close();
      await rm(paseoHome, { recursive: true, force: true });
    });

    const runtime = new TestOpenCodeHarness();
    const firstClient = new TestOpenCodeClient();
    const secondClient = new TestOpenCodeClient();
    firstClient.sessionCreateResponse = { data: { id: "ses_first" } };
    secondClient.sessionCreateResponse = { data: { id: "ses_second" } };
    runtime.enqueueClient(firstClient);
    runtime.enqueueClient(secondClient);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
      bridge,
    });

    const first = await client.createSession(
      { provider: "opencode", cwd: "/workspace/one" },
      {
        agentId: "agent-one",
        env: { PASEO_AGENT_ID: "agent-one", PASEO_AGENT_CWD: "/workspace/one" },
      },
    );
    const second = await client.createSession(
      { provider: "opencode", cwd: "/workspace/two" },
      {
        agentId: "agent-two",
        env: { PASEO_AGENT_ID: "agent-two", PASEO_AGENT_CWD: "/workspace/two" },
      },
    );

    expect(client.capabilities.supportsNativePaseoTools).toBe(true);
    expect(runtime.acquisitions.map(({ kind }) => kind)).toEqual(["current", "current"]);
    await expect(readBridgeContext(bridge, "ses_first")).resolves.toEqual({
      env: { PASEO_AGENT_ID: "agent-one", PASEO_AGENT_CWD: "/workspace/one" },
    });
    await expect(readBridgeContext(bridge, "ses_second")).resolves.toEqual({
      env: { PASEO_AGENT_ID: "agent-two", PASEO_AGENT_CWD: "/workspace/two" },
    });

    await first.close();
    await expect(readBridgeContext(bridge, "ses_first")).rejects.toThrow("404");
    await expect(readBridgeContext(bridge, "ses_second")).resolves.toBeDefined();
    await second.close();
  });

  test("keeps process-scoped env and directory-scoped MCP on dedicated servers", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-adapter-"));
    const bridge = new OpenCodeBridge({ paseoHome, logger: createTestLogger() });
    await bridge.start();
    cleanups.push(async () => {
      await bridge.close();
      await rm(paseoHome, { recursive: true, force: true });
    });
    const runtime = new TestOpenCodeHarness();
    runtime.enqueueClient(new TestOpenCodeClient());
    runtime.enqueueClient(new TestOpenCodeClient());
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
      bridge,
    });

    const customEnv = await client.createSession(
      { provider: "opencode", cwd: "/workspace/one" },
      { env: { PASEO_AGENT_ID: "one", CUSTOM_TOKEN: "secret" } },
    );
    const customMcp = await client.createSession(
      {
        provider: "opencode",
        cwd: "/workspace/two",
        mcpServers: { custom: { transport: "http", url: "http://127.0.0.1:9999/mcp" } },
      },
      { env: { PASEO_AGENT_ID: "two" } },
    );

    expect(runtime.acquisitions.map(({ kind }) => kind)).toEqual(["dedicated", "dedicated"]);
    await customEnv.close();
    await customMcp.close();
  });
});

async function readBridgeContext(bridge: OpenCodeBridge, sessionId: string): Promise<unknown> {
  const decorated = bridge.decorateServerEnv({});
  const config = JSON.parse(decorated.OPENCODE_CONFIG_CONTENT);
  const [, options] = config.plugin[0];
  const response = await fetch(
    new URL(
      `/_internal/opencode/sessions/${encodeURIComponent(sessionId)}/context`,
      options.baseUrl,
    ),
    { headers: { Authorization: `Bearer ${options.token}` } },
  );
  if (!response.ok) throw new Error(`OpenCode bridge returned ${response.status}`);
  return response.json();
}
