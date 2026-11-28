import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";
import { ACPAgentClient, type SessionStateResponse } from "./acp-agent.js";
import { CopilotACPAgentClient, COPILOT_ALLOW_ALL_MODE_ID } from "./copilot-acp-agent.js";
import type { AgentSession } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const modes = {
  currentModeId: "accept_edits",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "accept_edits", name: "Accept Edits" },
    { id: "dont_ask", name: "Don't Ask" },
  ],
};

function editOptions(currentValue = "workspace_session"): SessionConfigOption[] {
  return [
    {
      id: "edit_approval_policy",
      name: "Edits",
      category: "mode",
      type: "select",
      currentValue,
      options: [
        { value: "ask", name: "Default" },
        { value: "workspace_session", name: "Accept Edits" },
        { value: "session", name: "Don't Ask" },
      ],
    },
  ];
}

// A controlled ACP process, speaking the same stdio protocol as a provider.
// Notifications precede session/new's response to exercise queued initialization updates.
const modePeerScript = String.raw`
import { createInterface } from "node:readline";
import { readFileSync, appendFileSync } from "node:fs";
const scenario = JSON.parse(readFileSync(process.argv[2], "utf8"));
let configOptions = scenario.state.configOptions;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const reply = (result) => send({jsonrpc: "2.0", id: request.id, result});
  const reject = (message) => send({jsonrpc: "2.0", id: request.id, error: {code: -32602, message}});
  switch (request.method) {
    case "initialize":
      reply({protocolVersion: 1, agentCapabilities: {}});
      break;
    case "session/new":
      for (const update of scenario.updates) {
        send({jsonrpc: "2.0", method: "session/update", params: {sessionId: "mode-session", update}});
      }
      reply({sessionId: "mode-session", ...scenario.state});
      break;
    case "session/set_mode":
      appendFileSync(process.argv[3], JSON.stringify(request) + "\n");
      if (request.params.modeId === scenario.rejectedMode) {
        reject("mode denied");
      } else if (!scenario.state.modes?.availableModes.some(mode => mode.id === request.params.modeId)) {
        reject("invalid_params");
      } else {
        reply({});
      }
      break;
    case "session/set_config_option":
      appendFileSync(process.argv[3], JSON.stringify(request) + "\n");
      configOptions = configOptions.map(option => option.id === request.params.configId
        ? {...option, currentValue: request.params.value} : option);
      reply({configOptions});
      break;
    default:
      reject("Unexpected request: " + request.method);
  }
});
`;

interface ModeCall {
  method: string;
  params: { sessionId: string; modeId?: string; configId?: string; value?: string };
}

let session: AgentSession | undefined;
let directory: string | undefined;

afterEach(async () => {
  try {
    await session?.close();
  } finally {
    session = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

async function fixture(
  options: {
    state?: Omit<SessionStateResponse, "sessionId">;
    updates?: SessionUpdate[];
    rejectedMode?: string;
    startupMode?: string;
    copilot?: boolean;
  } = {},
) {
  const artifacts = path.resolve(".artifacts");
  await mkdir(artifacts, { recursive: true });
  directory = await mkdtemp(path.join(artifacts, "acp-mode-"));
  const script = path.join(directory, "peer.mjs");
  const scenario = path.join(directory, "scenario.json");
  const calls = path.join(directory, "calls.jsonl");
  await writeFile(script, modePeerScript);
  await writeFile(calls, "");
  await writeFile(
    scenario,
    JSON.stringify({
      state: options.state ?? { modes, configOptions: editOptions() },
      updates: options.updates ?? [
        { sessionUpdate: "config_option_update", configOptions: editOptions() },
      ],
      rejectedMode: options.rejectedMode,
    }),
  );
  const command: [string, ...string[]] = [process.execPath, script, scenario, calls];
  const client = options.copilot
    ? new CopilotACPAgentClient({
        logger: createTestLogger(),
        runtimeSettings: { command: { mode: "replace", argv: command } },
      })
    : new ACPAgentClient({
        provider: "mode-peer",
        logger: createTestLogger(),
        defaultCommand: command,
      });
  session = await client.createSession({
    provider: options.copilot ? "copilot" : "mode-peer",
    cwd: directory,
    modeId: options.startupMode,
  });
  return {
    session,
    async calls(): Promise<ModeCall[]> {
      const lines = (await readFile(calls, "utf8")).trim();
      return lines
        ? lines.split("\n").map((line) => {
            const { method, params } = JSON.parse(line) as ModeCall;
            return { method, params };
          })
        : [];
    },
  };
}

const modeCall = (modeId: string) => ({
  method: "session/set_mode",
  params: { sessionId: "mode-session", modeId },
});
const configCall = (configId: string, value: string) => ({
  method: "session/set_config_option",
  params: { sessionId: "mode-session", configId, value },
});

describe("ACP mode and config-value namespaces over stdio", () => {
  test("selects Don't Ask from the advertised catalogue after a queued config update", async () => {
    const peer = await fixture();
    const available = await peer.session.getAvailableModes();
    const dontAsk = available.find((mode) => mode.label === "Don't Ask");
    expect(dontAsk).toBeDefined();
    await peer.session.setMode(dontAsk!.id);
    expect(await peer.calls()).toEqual([modeCall("dont_ask")]);
    expect(await peer.session.getCurrentMode()).toBe("dont_ask");
    expect(available.map((mode) => mode.id)).toEqual(["default", "accept_edits", "dont_ask"]);
  });

  test("keeps a pushed current mode through separate-policy and empty config updates", async () => {
    const peer = await fixture({
      updates: [
        { sessionUpdate: "current_mode_update", currentModeId: "dont_ask" },
        { sessionUpdate: "config_option_update", configOptions: editOptions("session") },
        { sessionUpdate: "config_option_update", configOptions: [] },
      ],
    });
    expect(await peer.session.getCurrentMode()).toBe("dont_ask");
    expect((await peer.session.getAvailableModes()).map((mode) => mode.id)).toEqual([
      "default",
      "accept_edits",
      "dont_ask",
    ]);
    expect(await peer.calls()).toEqual([]);
  });

  test("ignores policy values outside the advertised session modes without an RPC", async () => {
    const peer = await fixture();
    await peer.session.setMode("session");
    expect(await peer.calls()).toEqual([]);
    expect(await peer.session.getCurrentMode()).toBe("accept_edits");
  });

  test("retains confirmed state after rejection without falling back to a config write", async () => {
    const peer = await fixture({ rejectedMode: "dont_ask", updates: [] });
    await expect(peer.session.setMode("dont_ask")).rejects.toThrow("mode denied");
    expect(await peer.session.getCurrentMode()).toBe("accept_edits");
    expect(await peer.calls()).toEqual([modeCall("dont_ask")]);
  });

  test("selects a config-only mode through its owning config option", async () => {
    const peer = await fixture({ state: { configOptions: editOptions() } });
    await peer.session.setMode("session");
    expect(await peer.calls()).toEqual([configCall("edit_approval_policy", "session")]);
    expect(await peer.session.getCurrentMode()).toBe("session");
  });

  test.each([true, false])("routes startup overrides with session modes: %s", async (withModes) => {
    const peer = await fixture({
      state: { modes: withModes ? modes : undefined, configOptions: editOptions() },
      startupMode: withModes ? "dont_ask" : "session",
    });
    expect(await peer.calls()).toEqual([
      withModes ? modeCall("dont_ask") : configCall("edit_approval_policy", "session"),
    ]);
    expect(await peer.session.getCurrentMode()).toBe(withModes ? "dont_ask" : "session");
  });
});

const agentMode = "https://agentclientprotocol.com/protocol/session-modes#agent";
const planMode = "https://agentclientprotocol.com/protocol/session-modes#plan";
function copilotConfig(allowAll: string): SessionConfigOption[] {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: agentMode,
      options: [
        { value: agentMode, name: "Agent" },
        { value: planMode, name: "Plan" },
      ],
    },
    {
      id: "allow_all",
      name: "Allow All",
      type: "select",
      currentValue: allowAll,
      options: [
        { value: "on", name: "On" },
        { value: "off", name: "Off" },
      ],
    },
  ];
}
function copilotFixture(initial: string, pushed: string) {
  return fixture({
    copilot: true,
    state: {
      modes: {
        currentModeId: agentMode,
        availableModes: [
          { id: agentMode, name: "Agent" },
          { id: planMode, name: "Plan" },
        ],
      },
      configOptions: copilotConfig(initial),
    },
    updates: [{ sessionUpdate: "config_option_update", configOptions: copilotConfig(pushed) }],
  });
}

describe("Copilot Allow All through the public client", () => {
  test("adopts an Allow All notification and disables it before switching modes", async () => {
    const peer = await copilotFixture("off", "on");
    expect(await peer.session.getCurrentMode()).toBe(COPILOT_ALLOW_ALL_MODE_ID);
    await peer.session.setMode(planMode);
    expect(await peer.calls()).toEqual([configCall("allow_all", "off"), modeCall(planMode)]);
    expect(await peer.session.getCurrentMode()).toBe(planMode);
  });

  test("adopts an Allow All off notification after initializing with it enabled", async () => {
    const peer = await copilotFixture("on", "off");
    expect(await peer.session.getCurrentMode()).toBe(agentMode);
    expect(await peer.calls()).toEqual([]);
  });

  test("selects Allow All and switches away in provider RPC order", async () => {
    const peer = await copilotFixture("off", "off");
    await peer.session.setMode(COPILOT_ALLOW_ALL_MODE_ID);
    expect(await peer.session.getCurrentMode()).toBe(COPILOT_ALLOW_ALL_MODE_ID);
    await peer.session.setMode(planMode);
    expect(await peer.calls()).toEqual([
      modeCall(agentMode),
      configCall("allow_all", "on"),
      configCall("allow_all", "off"),
      modeCall(planMode),
    ]);
    expect(await peer.session.getCurrentMode()).toBe(planMode);
  });
});
