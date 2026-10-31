import { describe, expect, test } from "vitest";

import {
  parseWorkspaceLastAgentConfig,
  selectWorkspaceLastAgentConfig,
  serializeWorkspaceLastAgentConfig,
  toCreateAgentInitialValues,
} from "./workspace-draft-defaults";
import type { Agent } from "@/stores/session-store";

function agent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    serverId: "srv",
    provider: "pi",
    status: "idle",
    turn: { phase: "idle" },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastUserMessageAt: null,
    lastActivityAt: new Date(0),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/tmp/project",
    model: "model-a",
    workspaceId: "ws",
    parentAgentId: null,
    labels: {},
    ...overrides,
  } as Agent;
}

describe("selectWorkspaceLastAgentConfig", () => {
  test("yields nothing until the directory has fully hydrated", () => {
    const agents = new Map([["stale", agent({ id: "stale", createdAt: new Date(500) })]]);
    expect(
      selectWorkspaceLastAgentConfig({
        session: { agents, hasHydratedAgents: false },
        workspaceId: "ws",
      }),
    ).toBeNull();
  });

  test("picks the newest top-level agent of the workspace", () => {
    const agents = new Map([
      ["old", agent({ id: "old", createdAt: new Date(100), model: "model-old" })],
      ["new", agent({ id: "new", createdAt: new Date(200), model: "model-new" })],
    ]);
    expect(
      selectWorkspaceLastAgentConfig({ session: { agents, hasHydratedAgents: true }, workspaceId: "ws" })
        ?.model,
    ).toBe("model-new");
  });

  test("ignores subagents even when they are the newest", () => {
    const agents = new Map([
      ["top", agent({ id: "top", createdAt: new Date(100), model: "model-top" })],
      [
        "sub",
        agent({ id: "sub", createdAt: new Date(300), model: "model-sub", parentAgentId: "top" }),
      ],
    ]);
    expect(
      selectWorkspaceLastAgentConfig({ session: { agents, hasHydratedAgents: true }, workspaceId: "ws" })?.model,
    ).toBe("model-top");
  });

  test("ignores agents from other workspaces and untrimmed id mismatches resolve by trim", () => {
    const agents = new Map([
      ["other", agent({ id: "other", workspaceId: "other-ws", createdAt: new Date(300) })],
      ["mine", agent({ id: "mine", workspaceId: " ws ", createdAt: new Date(100) })],
    ]);
    expect(
      selectWorkspaceLastAgentConfig({ session: { agents, hasHydratedAgents: true }, workspaceId: "ws" })
        ?.model,
    ).toBe("model-a");
  });

  test("skips model-less agents and falls back to an older agent with a model", () => {
    const agents = new Map([
      ["none", agent({ id: "none", model: null, createdAt: new Date(300) })],
      ["old", agent({ id: "old", createdAt: new Date(100), model: "model-old" })],
    ]);
    expect(
      selectWorkspaceLastAgentConfig({ session: { agents, hasHydratedAgents: true }, workspaceId: "ws" })?.model,
    ).toBe("model-old");
  });

  test("returns null when no agent has a usable model", () => {
    const agents = new Map([
      ["none", agent({ id: "none", model: null, createdAt: new Date(300) })],
    ]);
    expect(
      selectWorkspaceLastAgentConfig({ session: { agents, hasHydratedAgents: true }, workspaceId: "ws" }),
    ).toBeNull();
  });

  test("round-trips through serialize/parse and yields create-flow initial values", () => {
    const config = selectWorkspaceLastAgentConfig({
      session: {
        agents: new Map([
          [
            "a",
            agent({
              id: "a",
              createdAt: new Date(100),
              currentModeId: "plan",
              thinkingOptionId: "high",
            }),
          ],
        ]),
        hasHydratedAgents: true,
      },
      workspaceId: "ws",
    });
    const parsed = parseWorkspaceLastAgentConfig(serializeWorkspaceLastAgentConfig(config));
    expect(parsed).toEqual(config);
    expect(toCreateAgentInitialValues(parsed)).toEqual({
      provider: "pi",
      modeId: "plan",
      model: "model-a",
      thinkingOptionId: "high",
    });
  });

  test("empty serializations parse to null and map to undefined initial values", () => {
    expect(parseWorkspaceLastAgentConfig("")).toBeNull();
    expect(toCreateAgentInitialValues(null)).toBeUndefined();
  });
});
