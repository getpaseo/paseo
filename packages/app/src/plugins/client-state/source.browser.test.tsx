import { Nested } from "../../../../../plugin-examples/sidebar-views/client/nested";
import { lightTheme } from "@/styles/theme";
import { toPluginTheme } from "../theme";
import { createConnectedPluginHosts } from "./connected-hosts";
import { i18n } from "@/i18n/i18next";
import { fr } from "@/i18n/resources/fr";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createEntityRefs, PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import {
  useAgents,
  useWorkspaces,
  useWorkspace,
  useAgent,
  type WorkspaceRef,
  type AgentRef,
} from "@getpaseo/plugin/client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { createPluginClientStateSource, type PluginConnectedHostsSource } from "./source";
import { agent, workspace } from "./fixtures";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const renders = new Map<string, number>();
function count(key: string) {
  renders.set(key, (renders.get(key) ?? 0) + 1);
}
function WorkspaceRow({ reference }: { reference: WorkspaceRef }) {
  const item = useWorkspace(reference);
  count(reference.key);
  return (
    <div>
      {item?.name}:{item?.indicator}
    </div>
  );
}
function Workspaces() {
  count("workspaces");
  const items = useWorkspaces({ orderBy: "name" });
  return (
    <div>
      {items.map((reference) => (
        <WorkspaceRow key={reference.key} reference={reference} />
      ))}
    </div>
  );
}
function SelectedWorkspace({ reference }: { reference: WorkspaceRef }) {
  const name = useWorkspace(reference, (item) => ({ name: item.name }));
  const custom = useWorkspace(reference, undefined, (a, b) => a?.name === b?.name);
  count("selected");
  return (
    <div>
      {name?.name}:{custom?.name}
    </div>
  );
}
function AgentRow({ reference }: { reference: AgentRef }) {
  const item = useAgent(reference);
  return <div>{item?.title}</div>;
}
function AgentSection({ section }: { section: string }) {
  const agents = useAgents({
    where: (item) => (item.requiresAttention ? "waiting" : item.status) === section,
  });
  count(section);
  return (
    <div>
      {agents.map((reference) => (
        <AgentRow key={reference.key} reference={reference} />
      ))}
    </div>
  );
}
function Agents() {
  return (
    <div>
      <AgentSection section="running" />
      <AgentSection section="waiting" />
      <AgentSection section="idle" />
    </div>
  );
}
function seedHost(hostId: string) {
  const store = useSessionStore.getState();
  store.initializeSession(hostId, null);
  store.setWorkspaces(
    hostId,
    new Map([
      ["workspace-1", { ...workspace, id: "workspace-1", status: "done", name: "First" }],
      ["workspace-2", { ...workspace, id: "workspace-2", status: "done", name: "Second" }],
    ]),
  );
  store.setProjects(hostId, [
    {
      projectId: "empty",
      projectDisplayName: "Empty project",
      projectCustomName: null,
      projectRootPath: "/empty",
      projectKind: "git",
    },
  ]);
  store.setAgents(
    hostId,
    new Map<string, Agent>([
      [
        "agent-1",
        {
          ...agent,
          serverId: hostId,
          id: "agent-1",
          workspaceId: "workspace-1",
          status: "running",
          requiresAttention: false,
          attentionReason: null,
          turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
        },
      ],
      [
        "agent-2",
        {
          ...agent,
          serverId: hostId,
          id: "agent-2",
          workspaceId: "workspace-2",
          status: "running",
          requiresAttention: false,
          attentionReason: null,
          turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
        },
      ],
    ]),
  );
}
it("keeps archived agents readable individually while excluding them from collections", () => {
  seedHost("host-1");
  const source = createPluginClientStateSource("host-1", { hosts: new ConnectedHosts() });
  const reference = source.getSnapshot().agents[0]!.ref;
  useSessionStore.getState().setAgents(
    "host-1",
    new Map([
      [
        agent.id,
        {
          ...agent,
          archivedAt: new Date("2026-11-01T00:00:00.000Z"),
        },
      ],
    ]),
  );
  expect(source.getSnapshot().agents).toEqual([]);
  expect(source.getAgent(reference)?.title).toBe(agent.title);
  expect(source.getAgent(agent.id)).toBe(source.getAgent(reference));
});

it("demands directories for connected hosts and releases them with its last reader", () => {
  const hostId = "plugin-demand-host";
  let online = true;
  let demands = 0;
  const listeners = new Set<() => void>();
  const hosts = createConnectedPluginHosts(() => ({
    getHosts: () => [{ serverId: hostId }],
    getSnapshot: () => ({ connectionStatus: online ? "online" : "offline" }),
    subscribeAll: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeHostList: () => () => {},
    acquireDirectoryDemand: () => {
      demands++;
      seedHost(hostId);
      return () => {
        demands--;
      };
    },
  }));
  const source = createPluginClientStateSource(undefined, { hosts });
  const first = source.subscribe(() => {});
  const second = source.subscribe(() => {});
  expect(demands).toBe(1);
  expect(source.getSnapshot().workspaces.map((item) => item.hostId)).toEqual([hostId, hostId]);
  useSessionStore
    .getState()
    .setWorkspaces(
      hostId,
      (previous) =>
        new Map([...previous].map(([id, item]) => [id, { ...item, name: "Live update" }])),
    );
  expect(source.getSnapshot().workspaces.map((item) => item.name)).toEqual([
    "Live update",
    "Live update",
  ]);
  online = false;
  for (const listener of listeners) listener();
  expect(demands).toBe(0);
  expect(source.getSnapshot().workspaces).toEqual([]);
  online = true;
  for (const listener of listeners) listener();
  expect(demands).toBe(1);
  first();
  expect(demands).toBe(1);
  second();
  expect(demands).toBe(0);
  expect(listeners.size).toBe(0);
});

function waitForInput() {
  useSessionStore.getState().setAgents("host-1", (previous) => {
    const current = previous.get("agent-1");
    if (!current) throw new Error("Missing test agent");
    const next = new Map(previous);
    next.set(current.id, {
      ...current,
      status: "idle",
      turn: { phase: "idle", cancellationRequestId: null },
      requiresAttention: true,
      attentionReason: "permission",
    });
    return next;
  });
}
class ConnectedHosts implements PluginConnectedHostsSource {
  private ids: readonly string[] = ["host-1"];
  private listeners = new Set<() => void>();
  getSnapshot = () => this.ids;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  connect(id: string) {
    this.ids = [...this.ids, id];
    for (const listener of this.listeners) listener();
  }
}
function mount(children: React.ReactNode, hosts = new ConnectedHosts()) {
  const source = createPluginClientStateSource("host-1", { hosts });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(<PluginClientStateProvider source={source}>{children}</PluginClientStateProvider>),
  );
  return source;
}
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useSessionStore.getState().clearSession("host-1");
  useSessionStore.getState().clearSession("host-2");
  renders.clear();
});

it("shows a restored child in the nested example while its cached parent remains archived", () => {
  seedHost("host-1");
  const parent = {
    ...agent,
    id: "archived-parent",
    title: "Archived parent",
    archivedAt: new Date("2026-11-01T00:00:00Z"),
  };
  const child = {
    ...agent,
    id: "restored-child",
    title: "Restored child",
    parentAgentId: parent.id,
    labels: { "paseo.parent-agent-id": parent.id },
    archivedAt: parent.archivedAt,
  };
  const store = useSessionStore.getState();
  store.setProjects("host-1", [
    {
      projectId: workspace.projectId,
      projectDisplayName: "Project",
      projectCustomName: null,
      projectRootPath: workspace.projectRootPath,
      projectKind: "git",
    },
  ]);
  store.setAgents(
    "host-1",
    new Map<string, Agent>([
      [parent.id, parent],
      [child.id, child],
    ]),
  );
  const view = {
    theme: toPluginTheme(lightTheme),
    layout: { compact: false, platform: "web" as const },
    active: { workspace: null, agent: null },
    navigation: { openWorkspace() {}, openAgent() {}, openProject() {}, openTerminal() {} },
    dismiss() {},
  };
  const source = mount(<Nested {...view} />);
  expect(source.getAgent(parent.id)?.title).toBe(parent.title);
  expect(container?.textContent).not.toContain(child.title);
  act(() =>
    store.setAgents(
      "host-1",
      new Map<string, Agent>([
        [parent.id, parent],
        [child.id, { ...child, archivedAt: null }],
      ]),
    ),
  );
  expect(container?.querySelector('[aria-label="Open agent Restored child"]')).not.toBeNull();
  expect(container?.querySelector('[aria-label="Open agent Archived parent"]')).toBeNull();
});

describe("sidebar data hooks through the app store and plugin provider", () => {
  it("renders only one workspace row when its root agent starts waiting", () => {
    seedHost("host-1");
    const source = mount(<Workspaces />);
    const first = source.getSnapshot().workspaces[0]!;
    const second = source.getSnapshot().workspaces[1]!;
    const before = source.getSnapshot();
    act(waitForInput);
    expect(renders.get("workspaces")).toBe(1);
    expect(renders.get(first.ref.key)).toBe(2);
    expect(renders.get(second.ref.key)).toBe(1);
    expect(source.getSnapshot().workspaces[0]?.indicator).toBe("needs_input");
    expect(source.getSnapshot().workspaces[1]).toBe(before.workspaces[1]);
  });
  it("moves the agent and renders only its two affected sections without memo", () => {
    seedHost("host-1");
    mount(<Agents />);
    act(waitForInput);
    expect(renders.get("running")).toBe(2);
    expect(renders.get("waiting")).toBe(2);
    expect(renders.get("idle")).toBe(1);
  });
  it("uses shallow selected equality and custom equality without a selector", () => {
    seedHost("host-1");
    const source = createPluginClientStateSource("host-1", { hosts: new ConnectedHosts() });
    mount(<SelectedWorkspace reference={source.getSnapshot().workspaces[0]!.ref} />);
    act(waitForInput);
    expect(renders.get("selected")).toBe(1);
  });
  it("refreshes translated labels through the subscribed source when language changes", async () => {
    seedHost("host-1");
    i18n.addResourceBundle("fr", "translation", fr);
    const source = mount(<Workspaces />);
    const before = source.getSnapshot().workspaces[0]!;
    const previousLanguage = i18n.language;
    try {
      await act(async () => {
        await i18n.changeLanguage("fr");
      });
      const after = source.getSnapshot().workspaces[0]!;
      expect(after).not.toBe(before);
      expect(after.indicatorLabel).toBe("En cours");
      expect(after.ref).toBe(before.ref);
      expect(renders.get(before.ref.key)).toBe(2);
      expect(renders.get("workspaces")).toBe(1);
    } finally {
      await act(async () => {
        await i18n.changeLanguage(previousLanguage);
      });
    }
  });
  it("adds a newly connected host and exposes projects with no workspaces", () => {
    seedHost("host-1");
    seedHost("host-2");
    const hosts = new ConnectedHosts();
    const source = mount(<Workspaces />, hosts);
    expect(source.getSnapshot().workspaces).toHaveLength(2);
    expect(source.getSnapshot().projects[0]?.displayName).toBe("Empty project");
    act(() => hosts.connect("host-2"));
    expect(source.getSnapshot().workspaces).toHaveLength(4);
    expect(source.getSnapshot().projects).toHaveLength(2);
    expect(new Set(source.getSnapshot().workspaces.map((item) => item.ref.key)).size).toBe(4);
  });
});

it("observes terminals only while a terminal reader is subscribed", () => {
  let active = 0;
  const source = createPluginClientStateSource(undefined, {
    hosts: { getSnapshot: () => [], subscribe: () => () => {} },
    terminals: {
      getSnapshot: () => [],
      subscribe: () => {
        active++;
        return () => {
          active--;
        };
      },
    },
  });
  const releaseWorkspace = source.subscribe(() => {});
  expect(active).toBe(0);
  const releaseTerminal = source.subscribe(() => {}, { terminals: true });
  const releaseSecond = source.subscribe(() => {}, { terminals: true });
  expect(active).toBe(1);
  releaseTerminal();
  expect(active).toBe(1);
  releaseSecond();
  expect(active).toBe(0);
  releaseWorkspace();
});

it("terminal row reads propagate only the referenced host's observation error", () => {
  const error = new Error("Update the host");
  const source = createPluginClientStateSource(undefined, {
    hosts: { getSnapshot: () => [], subscribe: () => () => {} },
    terminals: {
      getSnapshot: () => [],
      subscribe: () => () => {},
      getErrors: () => new Map([["unsupported", error]]),
    },
  });
  const refs = createEntityRefs();
  expect(() => source.getTerminal(refs.terminal("unsupported", "retained"))).toThrow(error);
  expect(source.getTerminal(refs.terminal("supported", "missing"))).toBeNull();
});
