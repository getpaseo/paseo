/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { useOpenAgentTabLabels } from "./use-open-agent-tab-labels";

const SERVER_ID = "srv_a";
const TABS: WorkspaceTab[] = [
  { tabId: "agent_open", target: { kind: "agent", agentId: "open" }, createdAt: 1 },
];

function agent(id: string, title: string): Agent {
  return { id, title, parentAgentId: null, labels: {} } as unknown as Agent;
}

function publish(agents: Agent[]): void {
  useSessionStore
    .getState()
    .setAgents(SERVER_ID, new Map(agents.map((entry) => [entry.id, entry])));
}

describe("useOpenAgentTabLabels", () => {
  let root: Root | null = null;
  let renders = 0;

  function Probe() {
    renders += 1;
    useOpenAgentTabLabels({ client: null, serverId: SERVER_ID, tabs: TABS, enabled: true });
    return null;
  }

  beforeEach(() => {
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    renders = 0;
  });

  it("does not re-render when an agent without an open tab updates", () => {
    const open = agent("open", "Open");
    publish([open, agent("elsewhere", "Before")]);
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Probe />));
    const initialRenders = renders;

    act(() => publish([open, agent("elsewhere", "After")]));

    expect(renders).toBe(initialRenders);
  });

  it("re-renders when an agent with an open tab updates", () => {
    const elsewhere = agent("elsewhere", "Elsewhere");
    publish([agent("open", "Before"), elsewhere]);
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Probe />));
    const initialRenders = renders;

    act(() => publish([agent("open", "After"), elsewhere]));

    expect(renders).toBe(initialRenders + 1);
  });
});
