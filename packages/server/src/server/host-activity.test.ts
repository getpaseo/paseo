import { describe, expect, it } from "vitest";
import {
  HostActivityMonitor,
  type HostActivityAgentSource,
  type HostActivityAgentView,
  type HostActivityTerminalSource,
} from "./host-activity.js";
import type { AgentSubscriber, ManagedAgent } from "./agent/agent-manager.js";
import type { ClientPresenceState } from "./agent-attention-policy.js";
import { PRESENCE_THRESHOLD_MS } from "./agent-attention-policy.js";
import type { ScriptRuntimeEntry } from "./workspace-script-runtime-store.js";
import type {
  TerminalActivityListener,
  TerminalWorkspaceContributionChangedListener,
} from "../terminal/terminal-manager.js";
import type { TerminalExitInfo, TerminalForeground } from "../terminal/terminal.js";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";

const AT_PROMPT: TerminalForeground = { commandState: "prompt" };

const NOTHING_ELSE = {
  commands: [],
  services: [],
  waiting: [],
  clients: { connected: 0, visible: 0, present: false, lastActivityAt: null },
};

function agentView(input: {
  id: string;
  lifecycle: HostActivityAgentView["lifecycle"];
  pendingPermissions?: number;
  backgroundWorkPending?: boolean;
}): HostActivityAgentView {
  return {
    id: input.id,
    lifecycle: input.lifecycle,
    pendingPermissions: { size: input.pendingPermissions ?? 0 },
    ...(input.backgroundWorkPending === undefined
      ? {}
      : { backgroundWorkPending: input.backgroundWorkPending }),
  };
}

class FakeAgentManager implements HostActivityAgentSource {
  agents: HostActivityAgentView[] = [];
  private readonly listeners = new Set<AgentSubscriber>();
  private readonly registrationListeners = new Set<() => void>();
  private pendingRegistrations = 0;

  subscribe(callback: AgentSubscriber): () => void {
    this.listeners.add(callback);
    for (const agent of this.agents) {
      callback({ type: "agent_state", agent: agent as unknown as ManagedAgent });
    }
    return () => {
      this.listeners.delete(callback);
    };
  }

  listAgents(): HostActivityAgentView[] {
    return [...this.agents];
  }

  pendingAgentRegistrationCount(): number {
    return this.pendingRegistrations;
  }

  subscribeAgentRegistrations(listener: () => void): () => void {
    this.registrationListeners.add(listener);
    return () => {
      this.registrationListeners.delete(listener);
    };
  }

  setPendingRegistrations(count: number): void {
    this.pendingRegistrations = count;
    for (const listener of this.registrationListeners) {
      listener();
    }
  }

  setAgents(agents: HostActivityAgentView[]): void {
    this.agents = agents;
    for (const agent of agents) {
      this.emitState(agent);
    }
  }

  emitState(agent: HostActivityAgentView): void {
    const event = { type: "agent_state" as const, agent: agent as unknown as ManagedAgent };
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class FakeTerminalManager implements HostActivityTerminalSource {
  private readonly activities = new Map<string, TerminalActivity | null>();
  private readonly foregrounds = new Map<string, TerminalForeground>();
  private readonly exited = new Set<string>();
  private readonly existing = new Set<string>();
  private readonly activityListeners = new Set<TerminalActivityListener>();
  private readonly contributionListeners = new Set<TerminalWorkspaceContributionChangedListener>();

  subscribeTerminalActivity(listener: TerminalActivityListener): () => void {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  subscribeTerminalWorkspaceContributionChanged(
    listener: TerminalWorkspaceContributionChangedListener,
  ): () => void {
    this.contributionListeners.add(listener);
    return () => {
      this.contributionListeners.delete(listener);
    };
  }

  getTerminal(id: string): { getActivity: () => TerminalActivity | null } | undefined {
    if (!this.existing.has(id)) {
      return undefined;
    }
    return { getActivity: () => this.activities.get(id) ?? null };
  }

  listTerminals() {
    return Array.from(this.existing, (id) => ({
      id,
      getActivity: () => this.activities.get(id) ?? null,
      getForeground: () => this.foregrounds.get(id) ?? AT_PROMPT,
      getExitInfo: (): TerminalExitInfo | null =>
        this.exited.has(id) ? { exitCode: 0, signal: null, lastOutputLines: [] } : null,
    }));
  }

  open(
    id: string,
    activity: TerminalActivity | null = null,
    foreground: TerminalForeground = AT_PROMPT,
  ): void {
    this.existing.add(id);
    this.activities.set(id, activity);
    this.foregrounds.set(id, foreground);
  }

  setForeground(id: string, foreground: TerminalForeground): void {
    this.foregrounds.set(id, foreground);
  }

  exit(id: string): void {
    this.exited.add(id);
  }

  close(id: string): void {
    this.existing.delete(id);
    this.activities.delete(id);
    this.foregrounds.delete(id);
  }

  transition(id: string, activity: TerminalActivity | null): void {
    const previous = this.activities.get(id) ?? null;
    this.activities.set(id, activity);
    for (const listener of this.activityListeners) {
      listener({ terminalId: id, name: id, cwd: "/work", workspaceId: "ws", activity, previous });
    }
  }

  contributionChanged(id: string): void {
    for (const listener of this.contributionListeners) {
      listener({ terminalId: id, cwd: "/work", workspaceId: "ws" });
    }
  }
}

function setup() {
  let nowMs = Date.parse("2026-10-11T00:00:00.000Z");
  const agents = new FakeAgentManager();
  const terminals = new FakeTerminalManager();
  const scripts: ScriptRuntimeEntry[] = [];
  const presence: ClientPresenceState[] = [];
  const monitor = new HostActivityMonitor({
    agentManager: agents,
    terminalManager: terminals,
    scriptRuntime: { list: () => [...scripts] },
    clientPresence: () => [...presence],
    now: () => nowMs,
  });
  return {
    agents,
    terminals,
    scripts,
    presence,
    monitor,
    advance: (ms: number): void => {
      nowMs += ms;
    },
    nowMs: (): number => nowMs,
    nowIso: (): string => new Date(nowMs).toISOString(),
  };
}

function client(overrides: Partial<ClientPresenceState>): ClientPresenceState {
  return {
    appVisible: true,
    focusedAgentId: null,
    focusedTerminalId: null,
    lastActivityAtMs: null,
    ...overrides,
  };
}

describe("HostActivityMonitor", () => {
  it("starts quiescent with an empty busy set", () => {
    const { monitor, nowIso } = setup();

    expect(monitor.snapshot()).toEqual({
      state: "quiescent",
      since: nowIso(),
      busy: [],
      ...NOTHING_ELSE,
    });
  });

  it("reports a running agent as busy and moves since", () => {
    const { agents, monitor, advance, nowIso } = setup();

    advance(1000);
    agents.setAgents([agentView({ id: "a-1", lifecycle: "running" })]);

    expect(monitor.snapshot()).toEqual({
      state: "busy",
      since: nowIso(),
      busy: [{ kind: "agent", id: "a-1", reason: "running" }],
      ...NOTHING_ELSE,
    });
  });

  it("treats a running agent blocked on a permission as quiescent and lists it as waiting", () => {
    const { agents, monitor } = setup();

    agents.setAgents([agentView({ id: "a-1", lifecycle: "running", pendingPermissions: 1 })]);

    expect(monitor.snapshot()).toEqual({
      state: "quiescent",
      since: monitor.snapshot().since,
      busy: [],
      ...NOTHING_ELSE,
      waiting: [{ kind: "agent", id: "a-1", reason: "permission" }],
    });
  });

  it("stays busy while an agent starts, before it is listed", () => {
    const { agents, monitor, advance, nowIso } = setup();

    advance(1000);
    agents.setPendingRegistrations(1);
    const startedAt = nowIso();
    expect(monitor.snapshot()).toMatchObject({
      state: "busy",
      since: startedAt,
      busy: [{ kind: "agent_registration", count: 1, reason: "starting" }],
    });

    // Registration lists the agent before the pending operation settles, so
    // the host never reads quiescent in between.
    advance(1000);
    agents.setAgents([agentView({ id: "a-1", lifecycle: "initializing" })]);
    agents.setPendingRegistrations(0);
    expect(monitor.snapshot()).toMatchObject({
      state: "busy",
      since: startedAt,
      busy: [{ kind: "agent", id: "a-1", reason: "running" }],
    });
  });

  it("reports an idle agent with pending background work as busy", () => {
    const { agents, monitor, advance, nowIso } = setup();

    advance(2000);
    agents.setAgents([agentView({ id: "a-1", lifecycle: "idle", backgroundWorkPending: true })]);

    expect(monitor.snapshot()).toEqual({
      state: "busy",
      since: nowIso(),
      busy: [{ kind: "agent", id: "a-1", reason: "background_work" }],
      ...NOTHING_ELSE,
    });
  });

  it("reports a working terminal as busy", () => {
    const { terminals, monitor, advance, nowIso } = setup();
    terminals.open("t-1", { state: "idle", changedAt: 1 });

    advance(500);
    terminals.transition("t-1", { state: "working", changedAt: 2 });

    expect(monitor.snapshot()).toEqual({
      state: "busy",
      since: nowIso(),
      busy: [{ kind: "terminal", id: "t-1", reason: "working" }],
      ...NOTHING_ELSE,
    });
  });

  it("returns to quiescent when a working terminal exits", () => {
    const { terminals, monitor, advance, nowIso } = setup();
    terminals.open("t-1", { state: "idle", changedAt: 1 });
    terminals.transition("t-1", { state: "working", changedAt: 2 });
    expect(monitor.snapshot().state).toBe("busy");

    advance(500);
    terminals.close("t-1");
    terminals.contributionChanged("t-1");

    expect(monitor.snapshot()).toEqual({
      state: "quiescent",
      since: nowIso(),
      busy: [],
      ...NOTHING_ELSE,
    });
  });

  it("only moves since on busy/quiescent flips", () => {
    const { agents, terminals, monitor, advance } = setup();
    const running = agentView({ id: "a-1", lifecycle: "running" });

    agents.setAgents([running]);
    const busySince = monitor.snapshot().since;

    advance(1000);
    agents.emitState(running);
    expect(monitor.snapshot().since).toBe(busySince);

    advance(1000);
    terminals.open("t-1");
    terminals.transition("t-1", { state: "working", changedAt: 1 });
    expect(monitor.snapshot().since).toBe(busySince);
    expect(monitor.snapshot().busy).toEqual([
      { kind: "agent", id: "a-1", reason: "running" },
      { kind: "terminal", id: "t-1", reason: "working" },
    ]);

    advance(1000);
    agents.setAgents([]);
    agents.emitState(agentView({ id: "a-1", lifecycle: "closed" }));
    terminals.close("t-1");
    terminals.contributionChanged("t-1");
    const quietSince = monitor.snapshot().since;
    expect(monitor.snapshot().state).toBe("quiescent");
    expect(quietSince > busySince).toBe(true);

    advance(1000);
    agents.emitState(agentView({ id: "gone", lifecycle: "closed" }));
    expect(monitor.snapshot().since).toBe(quietSince);
  });

  describe("commands", () => {
    it("lists a terminal running a command or never at a prompt, and drops it at the prompt", () => {
      const { terminals, monitor } = setup();
      terminals.open("build", null, { commandState: "running" });
      terminals.open("tui", null, { commandState: "unknown" });
      terminals.open("shell");

      expect(monitor.snapshot().commands).toEqual([
        { terminalId: "build", reason: "running" },
        { terminalId: "tui", reason: "unknown" },
      ]);

      terminals.setForeground("build", AT_PROMPT);
      expect(monitor.snapshot().commands).toEqual([{ terminalId: "tui", reason: "unknown" }]);
    });

    it("skips exited terminals", () => {
      const { terminals, monitor } = setup();
      terminals.open("t-1", null, { commandState: "running" });
      terminals.exit("t-1");

      expect(monitor.snapshot().commands).toEqual([]);
    });
  });

  it("lists running service scripts under services instead of commands", () => {
    const { terminals, scripts, monitor } = setup();
    const running: TerminalForeground = { commandState: "running" };
    terminals.open("web", null, running);
    terminals.open("old-web", null, running);
    terminals.open("build", null, running);
    scripts.push(
      {
        workspaceId: "ws",
        scriptName: "web",
        type: "service",
        lifecycle: "running",
        terminalId: "web",
        exitCode: null,
      },
      {
        workspaceId: "ws",
        scriptName: "web",
        type: "service",
        lifecycle: "stopped",
        terminalId: "old-web",
        exitCode: 0,
      },
      {
        workspaceId: "ws",
        scriptName: "build",
        type: "script",
        lifecycle: "running",
        terminalId: "build",
        exitCode: null,
      },
    );

    const snapshot = monitor.snapshot();
    expect(snapshot.services).toEqual([
      { terminalId: "web", workspaceId: "ws", scriptName: "web" },
    ]);
    expect(snapshot.commands).toEqual([
      { terminalId: "old-web", reason: "running" },
      { terminalId: "build", reason: "running" },
    ]);
  });

  it("lists a terminal that needs input as waiting", () => {
    const { terminals, monitor } = setup();
    terminals.open("asks", { state: "attention", attentionReason: "needs_input", changedAt: 1 });
    terminals.open("finished", { state: "attention", attentionReason: "finished", changedAt: 1 });

    expect(monitor.snapshot().waiting).toEqual([
      { kind: "terminal", id: "asks", reason: "needs_input" },
    ]);
  });

  it("lists a service that needs input as waiting", () => {
    const { terminals, scripts, monitor } = setup();
    terminals.open(
      "web",
      { state: "attention", attentionReason: "needs_input", changedAt: 1 },
      { commandState: "running" },
    );
    scripts.push({
      workspaceId: "ws",
      scriptName: "web",
      type: "service",
      lifecycle: "running",
      terminalId: "web",
      exitCode: null,
    });

    const snapshot = monitor.snapshot();
    expect(snapshot.services).toEqual([
      { terminalId: "web", workspaceId: "ws", scriptName: "web" },
    ]);
    expect(snapshot.waiting).toEqual([{ kind: "terminal", id: "web", reason: "needs_input" }]);
  });

  describe("clients", () => {
    it("is present only for a visible client with input within the threshold", () => {
      const { presence, monitor, nowMs } = setup();
      presence.push(
        client({ appVisible: true, lastActivityAtMs: nowMs() - PRESENCE_THRESHOLD_MS - 1 }),
        client({ appVisible: false, lastActivityAtMs: nowMs() - 1_000 }),
        client({ appVisible: false, lastActivityAtMs: null }),
      );

      expect(monitor.snapshot().clients).toEqual({
        connected: 3,
        visible: 1,
        present: false,
        lastActivityAt: new Date(nowMs() - 1_000).toISOString(),
      });

      presence.push(
        client({ appVisible: true, lastActivityAtMs: nowMs() - PRESENCE_THRESHOLD_MS }),
      );
      expect(monitor.snapshot().clients.present).toBe(true);
    });

    it("clamps a client clock ahead of the daemon to now", () => {
      const { presence, monitor, nowIso, nowMs } = setup();
      presence.push(client({ appVisible: true, lastActivityAtMs: nowMs() + 600_000 }));

      expect(monitor.snapshot().clients).toMatchObject({ present: true, lastActivityAt: nowIso() });
    });
  });
});
