import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import type { SplitNode, WorkspaceLayout } from "@/stores/workspace-layout-store";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/workspace-tabs/model";
import { selectWorkspaceTabRows, type SelectWorkspaceTabRowsInput } from "./model";

const WORKSPACE_ID = "ws-1";

function makeAgent(input: {
  id: string;
  serverId?: string;
  workspaceId?: string | null;
  parentAgentId?: string | null;
  archivedAt?: Date | null;
  createdAt?: Date;
  title?: string | null;
  status?: Agent["status"];
  requiresAttention?: boolean;
  attentionReason?: Agent["attentionReason"];
  pendingPermissions?: Agent["pendingPermissions"];
}): Agent {
  const createdAt = input.createdAt ?? new Date("2026-03-04T00:00:00.000Z");
  return {
    serverId: input.serverId ?? "srv",
    id: input.id,
    provider: "codex",
    status: input.status ?? "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt,
    updatedAt: createdAt,
    lastUserMessageAt: null,
    lastActivityAt: createdAt,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: input.pendingPermissions ?? [],
    persistence: null,
    runtimeInfo: { provider: "codex", sessionId: null },
    title: input.title ?? null,
    cwd: "/repo/worktree",
    workspaceId: input.workspaceId === null ? undefined : (input.workspaceId ?? WORKSPACE_ID),
    model: null,
    thinkingOptionId: null,
    parentAgentId: input.parentAgentId ?? null,
    labels: {},
    requiresAttention: input.requiresAttention ?? false,
    attentionReason: input.attentionReason ?? null,
    attentionTimestamp: null,
    archivedAt: input.archivedAt ?? null,
  };
}

function tab(tabId: string, target: WorkspaceTabTarget): WorkspaceTab {
  return { tabId, target, createdAt: 0 };
}

/** Panes carry their tabs inline in the store; the public `SplitPane` type only names the ids. */
function pane(id: string, tabs: WorkspaceTab[], focusedTabId: string | null = null): SplitNode {
  return {
    kind: "pane",
    pane: { id, tabIds: tabs.map((entry) => entry.tabId), focusedTabId, tabs },
  } as unknown as SplitNode;
}

function split(...children: SplitNode[]): SplitNode {
  return {
    kind: "group",
    group: {
      id: "group",
      direction: "horizontal",
      children,
      sizes: children.map(() => 1 / children.length),
    },
  };
}

function select(input: Partial<SelectWorkspaceTabRowsInput>) {
  return selectWorkspaceTabRows({
    layout: null,
    explorerSidebarPaneId: null,
    hiddenAgentIds: null,
    agents: [],
    serverId: "srv",
    workspaceId: WORKSPACE_ID,
    ...input,
  });
}

function rowTabIds(input: Partial<SelectWorkspaceTabRowsInput>): string[] {
  return select(input).rows.map((row) => row.descriptor.tabId);
}

describe("selectWorkspaceTabRows", () => {
  it("lists every open tab kind, pane by pane, in the strip's order", () => {
    const layout: WorkspaceLayout = {
      root: split(
        pane("left", [
          tab("agent-tab", { kind: "agent", agentId: "a" }),
          tab("term-tab", { kind: "terminal", terminalId: "t1" }),
        ]),
        pane("right", [tab("diff-tab", { kind: "working_diff" })]),
      ),
      focusedPaneId: "left",
    };
    expect(rowTabIds({ layout, agents: [makeAgent({ id: "a" })] })).toEqual([
      "agent-tab",
      "term-tab",
      "diff-tab",
    ]);
  });

  it("leaves out the Explorer's pane and the blank launcher tab", () => {
    const layout: WorkspaceLayout = {
      root: split(
        pane("main", [
          tab("launcher", { kind: "new_tab" }),
          tab("term-tab", { kind: "terminal", terminalId: "t1" }),
        ]),
        pane("explorer", [tab("files-tab", { kind: "files" })]),
      ),
      focusedPaneId: "main",
    };
    expect(rowTabIds({ layout, explorerSidebarPaneId: "explorer" })).toEqual(["term-tab"]);
  });

  it("reports the focused pane's focused tab as active", () => {
    const layout: WorkspaceLayout = {
      root: split(
        pane("left", [tab("term-1", { kind: "terminal", terminalId: "t1" })], "term-1"),
        pane("right", [tab("term-2", { kind: "terminal", terminalId: "t2" })], "term-2"),
      ),
      focusedPaneId: "right",
    };
    expect(select({ layout }).activeTabId).toBe("term-2");
  });

  it("drops an active tab id the folder does not list", () => {
    const layout: WorkspaceLayout = {
      root: pane("main", [tab("launcher", { kind: "new_tab" })], "launcher"),
      focusedPaneId: "main",
    };
    expect(select({ layout })).toEqual({ rows: [], activeTabId: null });
  });

  it("appends root agents with no tab yet, oldest first, after the layout's tabs", () => {
    const layout: WorkspaceLayout = {
      root: pane("main", [tab("agent-tab", { kind: "agent", agentId: "open" })]),
      focusedPaneId: "main",
    };
    const rows = select({
      layout,
      agents: [
        makeAgent({ id: "open" }),
        makeAgent({ id: "later", createdAt: new Date("2026-03-04T10:00:00.000Z") }),
        makeAgent({ id: "earlier", createdAt: new Date("2026-03-04T09:00:00.000Z") }),
      ],
    }).rows;
    expect(rows.map((row) => [row.descriptor.target, row.inLayout])).toEqual([
      [{ kind: "agent", agentId: "open" }, true],
      [{ kind: "agent", agentId: "earlier" }, false],
      [{ kind: "agent", agentId: "later" }, false],
    ]);
  });

  it("fills a never-opened workspace's folder from its agents alone", () => {
    expect(select({ agents: [makeAgent({ id: "a" })] }).rows).toHaveLength(1);
  });

  it("keeps an agent out when the user closed its tab", () => {
    const rows = select({ agents: [makeAgent({ id: "a" })], hiddenAgentIds: new Set(["a"]) }).rows;
    expect(rows).toEqual([]);
  });

  it("appends only live root agents of this workspace and host", () => {
    const parent = makeAgent({ id: "parent" });
    const rows = select({
      agents: [
        parent,
        makeAgent({ id: "sub", parentAgentId: "parent" }),
        makeAgent({ id: "archived", archivedAt: new Date() }),
        makeAgent({ id: "elsewhere", workspaceId: "ws-2" }),
        makeAgent({ id: "other-host", serverId: "srv-2" }),
      ],
    }).rows;
    expect(rows.map((row) => row.descriptor.target)).toEqual([
      { kind: "agent", agentId: "parent" },
    ]);
  });

  it("keeps a child agent that was detached into this workspace", () => {
    const parent = makeAgent({ id: "parent", workspaceId: "ws-2" });
    const detached = makeAgent({ id: "detached", parentAgentId: "parent" });
    expect(select({ agents: [parent, detached] }).rows.map((row) => row.descriptor.target)).toEqual(
      [{ kind: "agent", agentId: "detached" }],
    );
  });

  it("breaks a same-millisecond tie on agent id rather than input order", () => {
    const createdAt = new Date("2026-03-04T09:00:00.000Z");
    const first = makeAgent({ id: "b", createdAt });
    const second = makeAgent({ id: "a", createdAt });
    const ids = (agents: Agent[]) =>
      select({ agents }).rows.map((row) =>
        row.descriptor.target.kind === "agent" ? row.descriptor.target.agentId : null,
      );
    expect(ids([first, second])).toEqual(["a", "b"]);
    expect(ids([second, first])).toEqual(["a", "b"]);
  });

  it("returns nothing when the workspace has no opaque id", () => {
    expect(select({ agents: [makeAgent({ id: "a" })], workspaceId: null }).rows).toEqual([]);
    expect(select({ agents: [makeAgent({ id: "a" })], workspaceId: "  " }).rows).toEqual([]);
  });

  it("keys rows by host and workspace so two workspaces cannot collide", () => {
    const layout: WorkspaceLayout = {
      root: pane("main", [tab("term-tab", { kind: "terminal", terminalId: "t1" })]),
      focusedPaneId: "main",
    };
    expect(select({ layout }).rows[0]?.key).toBe("srv:ws-1:term-tab");
  });
});
