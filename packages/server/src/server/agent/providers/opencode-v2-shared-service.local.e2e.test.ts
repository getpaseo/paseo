import { OpenCode } from "@opencode/client";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentLaunchContext, AgentSession, AgentSessionConfig } from "../agent-sdk-types.js";
import { OpenCodeBridge } from "./opencode/bridge.js";
import { provisionLocalBridge } from "./opencode/v2/bridge-provisioning.js";
import { OpenCodeV2AgentClient } from "./opencode/v2/agent.js";
import {
  EXTERNAL_SERVER_PASSWORD_ENV,
  EXTERNAL_SERVER_URL_ENV,
} from "./opencode/v2/external-server.js";
import {
  HttpMcpFixture,
  isProcessAlive,
  writeStdioMcpFixture,
} from "./opencode/test-utils/mcp-fixtures.js";
import {
  OPENCODE_V2_COMMAND,
  SCRIPTED_MODEL,
  ScriptedOpenCodeService,
  scriptedCall,
  type ScriptedRequest,
  type ScriptedTool,
} from "./opencode/test-utils/v2-scripted-server.js";
import {
  collectPermissions,
  collectProviderSubagents,
} from "./opencode/test-utils/v2-local-e2e-helpers.js";

/** Where the OpenCode server runs: named by the user, found running, or started by Paseo. */
type Mode = "explicit" | "discovered" | "owned";

interface Fixture {
  root: string;
  /** An MCP server named `hub` in the user's own OpenCode configuration, when the test has one. */
  userHub?: HttpMcpFixture;
  project: string;
  bridge: OpenCodeBridge;
  service: ScriptedOpenCodeService;
  client: OpenCodeV2AgentClient;
}

async function startFixture(mode: Mode, options: { userHub?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-v2-shared-"));
  const project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  const bridge = new OpenCodeBridge({
    paseoHome: path.join(root, "paseo"),
    logger: createTestLogger(),
  });
  bridge.setManifestCatalog({ tools: new Map() });
  await bridge.start();
  const userHub = options.userHub
    ? // Its `marker` requires an input that the agents' `marker` does not have.
      await HttpMcpFixture.start({ token: "user-token", marker: "USER_OK", requiredInput: "value" })
    : undefined;
  const service = await ScriptedOpenCodeService.start({
    ...(userHub
      ? {
          mcpServers: {
            hub: {
              type: "remote",
              url: userHub.url,
              headers: { Authorization: "Bearer user-token" },
              oauth: false,
            },
          },
        }
      : {}),
    // A user installs the plugin on an explicit server; Paseo installs it on a discovered one.
    beforeStart:
      mode === "explicit"
        ? async ({ configDirectory }) =>
            provisionLocalBridge({
              configDirectory,
              artifact: path.join(fileURLToPath(await bridge.materializeV2Plugin()), "server.js"),
            })
        : undefined,
  });
  const settings = {
    explicit: {
      env: {
        [EXTERNAL_SERVER_URL_ENV]: service.url,
        [EXTERNAL_SERVER_PASSWORD_ENV]: service.password,
      },
    },
    discovered: { env: service.discoveryEnvironment },
    // Process environment makes Paseo start its own server despite the registered service.
    owned: {
      command: { mode: "replace" as const, argv: [OPENCODE_V2_COMMAND] },
      env: service.ownedEnvironment,
    },
  }[mode];
  const client = new OpenCodeV2AgentClient({ logger: createTestLogger(), bridge, settings });
  return { root, project, bridge, service, client, ...(userHub ? { userHub } : {}) };
}

async function stopFixture(fixture: Fixture | undefined) {
  if (!fixture) return;
  await fixture.client.shutdown();
  await fixture.service.stop();
  await fixture.bridge.close();
  await fixture.userHub?.close();
  await rm(fixture.root, { recursive: true, force: true });
}

/** The create request Hub sends for an execution: its MCP endpoint, preapproval, and env. */
function hubLaunch(input: {
  cwd: string;
  agentId: string;
  hub: HttpMcpFixture;
  token: string;
  secret: string;
  stdio?: string;
}): { config: AgentSessionConfig; launch: AgentLaunchContext } {
  return {
    config: {
      provider: "opencode",
      cwd: input.cwd,
      model: SCRIPTED_MODEL,
      mcpServers: {
        hub: {
          type: "http",
          url: input.hub.url,
          headers: { Authorization: `Bearer ${input.token}` },
        },
        ...(input.stdio
          ? { local: { type: "stdio" as const, command: process.execPath, args: [input.stdio] } }
          : {}),
      },
      toolPolicy: {
        preapproved: [
          { kind: "mcp", server: "hub", tool: "marker" },
          { kind: "mcp", server: "local", tool: "env" },
        ],
      },
    },
    launch: {
      agentId: input.agentId,
      env: {
        HUB_SECRET: input.secret,
        PASEO_AGENT_PROVIDER: "opencode",
        PASEO_HUB_CONFIG_JSON: JSON.stringify({ execution: input.agentId }),
        PASEO_AGENT_ID: input.agentId,
        PASEO_AGENT_CWD: input.cwd,
      },
    },
  };
}

/** The tools a model request offers from the agents' `hub` and `local` MCP servers. */
function agentMcpTools(request: ScriptedRequest): ScriptedTool[] {
  return request.tools.filter(
    (tool) => tool.name.startsWith("hub_") || tool.name.startsWith("local_"),
  );
}

function useFixture(mode: Mode, options: { userHub?: boolean } = {}) {
  const state: { fixture?: Fixture; cleanups: Array<() => Promise<void>> } = { cleanups: [] };
  beforeEach(async () => {
    state.fixture = await startFixture(mode, options);
  }, 60_000);
  afterEach(async () => {
    for (const cleanup of state.cleanups.splice(0).toReversed()) await cleanup();
    await stopFixture(state.fixture);
    state.fixture = undefined;
  }, 60_000);
  return state;
}

describe.each<Mode>(["explicit", "discovered", "owned"])("OpenCode v2 %s server", (mode) => {
  const state = useFixture(mode);

  test("lists models, runs Hub MCP tools, and exposes launch env to shells, stdio MCP, and subagents", async () => {
    const { cleanups } = state;
    const fixture = state.fixture!;
    const { client, project } = fixture;
    const catalog = await client.fetchCatalog({ scope: "workspace", cwd: project, force: false });
    expect(catalog.models.map((model) => model.id)).toContain(SCRIPTED_MODEL);
    const hub = await HttpMcpFixture.start({
      token: "token-1",
      marker: "HUB_OK_1",
      instructions: "Always finish the Hub execution.",
    });
    cleanups.push(() => hub.close());
    const stdio = await writeStdioMcpFixture(fixture.root);
    const { config, launch } = hubLaunch({
      cwd: project,
      agentId: "agent-1",
      hub,
      token: "token-1",
      secret: "secret-1",
      stdio: stdio.script,
    });
    const session = await client.createSession(config, launch, { persistSession: false });
    cleanups.push(() => session.close());
    const permissions = collectPermissions(session);

    const hubCall = scriptedCall("hub_marker");
    const marker = await session.run(hubCall);
    expect(marker.finalText).toBe("RESULT HUB_OK_1");
    expect(marker.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", name: "hub_marker", status: "completed" }),
      ]),
    );
    const stdioEnv = await session.run(scriptedCall("local_env", { name: "HUB_SECRET" }));
    expect(stdioEnv.finalText).toBe("RESULT secret-1");
    const shell = await session.run(
      scriptedCall("shell", { command: 'printf %s "$HUB_SECRET"', description: "Print secret" }),
    );
    expect(shell.finalText).toContain("secret-1");

    const subagents = collectProviderSubagents(session);
    const childPrompt = scriptedCall("shell", {
      command: 'printf %s "child:$HUB_SECRET"',
      description: "Print secret",
    });
    await session.run(
      scriptedCall("subagent", { agent: "general", description: "Print", prompt: childPrompt }),
    );
    await expect.poll(subagents.childText, { timeout: 30_000 }).toContain("child:secret-1");
    expect(permissions).toEqual([]);
    // OpenCode introduces the prompt it gives the subagent, so match the child request by its end.
    const childRequest = fixture.service.agentRequests.find((request) =>
      request.prompt.endsWith(childPrompt),
    );
    expect(childRequest?.tools.map((tool) => tool.name)).toContain("hub_marker");
    // The model receives the server's instructions with the first request of each session.
    expect(fixture.service.requestsFor(hubCall)[0]?.transcript).toContain(
      "Always finish the Hub execution.",
    );
    expect(childRequest?.transcript).toContain("Always finish the Hub execution.");
  }, 120_000);
});

describe.each<Mode>(["explicit", "discovered"])("OpenCode v2 %s shared service", (mode) => {
  const state = useFixture(mode, { userHub: true });

  test("isolates same-named MCP servers between sessions in one directory and closes them", async () => {
    const { cleanups } = state;
    const fixture = state.fixture!;
    const { client, project, service } = fixture;
    const hubs = await Promise.all(
      [1, 2].map((index) =>
        HttpMcpFixture.start({ token: `token-${index}`, marker: `HUB_OK_${index}` }),
      ),
    );
    for (const hub of hubs) cleanups.push(() => hub.close());
    const stdio = await writeStdioMcpFixture(fixture.root);
    const sessions: AgentSession[] = [];
    for (const index of [1, 2]) {
      const { config, launch } = hubLaunch({
        cwd: project,
        agentId: `agent-${index}`,
        hub: hubs[index - 1]!,
        token: `token-${index}`,
        secret: `secret-${index}`,
        ...(index === 1 ? { stdio: stdio.script } : {}),
      });
      const session = await client.createSession(config, launch, { persistSession: false });
      sessions.push(session);
      cleanups.push(() => session.close());
    }
    const [first, second] = sessions;

    // Each session prompts with its own text, so the scripted model sees which session asked.
    const firstCall = `first ${scriptedCall("hub_marker")}`;
    const secondCall = `second ${scriptedCall("hub_marker")}`;
    expect((await first!.run(firstCall)).finalText).toBe("RESULT HUB_OK_1");
    expect((await second!.run(secondCall)).finalText).toBe("RESULT HUB_OK_2");
    const advertised = (prompt: string) => agentMcpTools(service.requestsFor(prompt)[0]!);
    expect(advertised(firstCall)).toEqual([
      expect.objectContaining({ name: "hub_marker", description: "Return HUB_OK_1" }),
      expect.objectContaining({ name: "local_env" }),
    ]);
    expect(advertised(secondCall)).toEqual([
      expect.objectContaining({ name: "hub_marker", description: "Return HUB_OK_2" }),
    ]);

    // A session the user opens in OpenCode itself sees no Paseo MCP tools. It keeps the
    // same-named tool from the user's own OpenCode configuration.
    const unrelatedPrompt = `unrelated ${scriptedCall("hub_marker")}`;
    const opencode = OpenCode.make({
      baseUrl: service.url,
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}`,
      },
    });
    const unrelated = await opencode.session.create({
      location: { directory: project },
      agent: "build",
    });
    await opencode.session.prompt({ sessionID: unrelated.id, text: unrelatedPrompt });
    await expect
      .poll(() => service.requestsFor(unrelatedPrompt).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    expect(advertised(unrelatedPrompt)).toEqual([
      expect.objectContaining({ name: "hub_marker", description: "Return USER_OK" }),
    ]);

    expect(hubs.map((hub) => hub.openSessions)).toEqual([1, 1]);
    const pid = Number(await readFile(stdio.pidFile, "utf8"));
    expect(isProcessAlive(pid)).toBe(true);
    await first!.close();
    expect(hubs.map((hub) => hub.openSessions)).toEqual([0, 1]);
    await expect.poll(() => isProcessAlive(pid), { timeout: 10_000 }).toBe(false);
    // The remaining session keeps its own endpoint after the other one closes.
    const afterClose = `after close ${scriptedCall("hub_marker")}`;
    expect((await second!.run(afterClose)).finalText).toBe("RESULT HUB_OK_2");
  }, 120_000);
});
