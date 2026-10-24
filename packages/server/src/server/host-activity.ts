import { deriveTerminalActivityStatusBucket } from "@getpaseo/protocol/terminal-activity";
import type { AgentSubscriber, ManagedAgent } from "./agent/agent-manager.js";
import { type ClientPresenceState, PRESENCE_THRESHOLD_MS } from "./agent-attention-policy.js";
import type { ScriptRuntimeEntry } from "./workspace-script-runtime-store.js";
import type {
  TerminalActivityListener,
  TerminalWorkspaceContributionChangedListener,
} from "../terminal/terminal-manager.js";
import type { TerminalSession } from "../terminal/terminal.js";

// Minimal view of an agent for host-busy computation.
export interface HostActivityAgentView {
  id: string;
  lifecycle: ManagedAgent["lifecycle"];
  pendingPermissions: Pick<ManagedAgent["pendingPermissions"], "size">;
  backgroundWorkPending: boolean;
}

export interface HostActivityAgentSource {
  subscribe(callback: AgentSubscriber, options?: { includeInternal?: boolean }): () => void;
  listAgents(options?: { includeInternal?: boolean }): HostActivityAgentView[];
  // Agents being created, resumed, imported or reloaded, which listAgents()
  // does not include until their provider session exists.
  pendingAgentRegistrationCount(): number;
  subscribeAgentRegistrations(listener: () => void): () => void;
}

export interface HostActivityTerminalSource {
  subscribeTerminalActivity(listener: TerminalActivityListener): () => void;
  subscribeTerminalWorkspaceContributionChanged(
    listener: TerminalWorkspaceContributionChangedListener,
  ): () => void;
  getTerminal(id: string): Pick<TerminalSession, "getActivity"> | undefined;
  listTerminals(): Array<
    Pick<TerminalSession, "id" | "getActivity" | "getForeground" | "getExitInfo">
  >;
}

export interface HostActivityScriptSource {
  list(): ScriptRuntimeEntry[];
}

export type HostActivityState = "busy" | "quiescent";

export type HostActivityBusyEntry =
  | { kind: "agent"; id: string; reason: "running" | "background_work" }
  | { kind: "agent_registration"; count: number; reason: "starting" }
  | { kind: "terminal"; id: string; reason: "working" };

// A terminal whose foreground is not a shell prompt: `running` after OSC 633 C
// with no prompt since, `unknown` before any prompt mark.
export interface HostActivityCommandEntry {
  terminalId: string;
  reason: "running" | "unknown";
}

// A running workspace service script (`paseo.json` service): long-lived by
// design, so it is listed apart from commands and the caller decides.
export interface HostActivityServiceEntry {
  terminalId: string;
  workspaceId: string;
  scriptName: string;
}

// Waiting on a person. Informational: `state` treats these as quiescent.
export type HostActivityWaitingEntry =
  | { kind: "agent"; id: string; reason: "permission" }
  | { kind: "terminal"; id: string; reason: "needs_input" };

export interface HostActivityClients {
  connected: number;
  visible: number;
  // Some client has the app visible with input within PRESENCE_THRESHOLD_MS.
  present: boolean;
  lastActivityAt: string | null;
}

export interface HostActivitySnapshot {
  state: HostActivityState;
  since: string;
  busy: HostActivityBusyEntry[];
  commands: HostActivityCommandEntry[];
  services: HostActivityServiceEntry[];
  waiting: HostActivityWaitingEntry[];
  clients: HostActivityClients;
}

export interface HostActivityMonitorOptions {
  agentManager: HostActivityAgentSource;
  terminalManager: HostActivityTerminalSource;
  scriptRuntime: HostActivityScriptSource;
  clientPresence: () => ClientPresenceState[];
  now?: () => number;
}

// Reports what is happening on the host so an external controller (an idle
// shutdown, a sleep inhibitor, a notifier) can decide for itself. `state` and
// `since` cover explicit program-reported busy state only: running agents,
// agents with pending background work, and terminals in the working activity
// state; plain shell output and idle/attention terminals never do. The other
// fields are read when the snapshot is taken: foreground commands, services,
// who is waiting on a person, and client presence.
export class HostActivityMonitor {
  private readonly agentManager: HostActivityAgentSource;
  private readonly terminalManager: HostActivityTerminalSource;
  private readonly scriptRuntime: HostActivityScriptSource;
  private readonly clientPresence: () => ClientPresenceState[];
  private readonly now: () => number;
  private readonly workingTerminalIds = new Set<string>();
  private agentEntries: HostActivityBusyEntry[] = [];
  private busy: HostActivityBusyEntry[] = [];
  private state: HostActivityState = "quiescent";
  private sinceMs: number;
  private readonly unsubscribe: Array<() => void> = [];
  private disposed = false;

  constructor(options: HostActivityMonitorOptions) {
    this.agentManager = options.agentManager;
    this.terminalManager = options.terminalManager;
    this.scriptRuntime = options.scriptRuntime;
    this.clientPresence = options.clientPresence;
    this.now = options.now ?? (() => Date.now());
    this.sinceMs = this.now();
    this.unsubscribe.push(
      this.agentManager.subscribe(
        (event) => {
          if (event.type !== "agent_state") {
            return;
          }
          this.recomputeAgents();
        },
        { includeInternal: true },
      ),
      this.agentManager.subscribeAgentRegistrations(() => {
        this.recomputeAgents();
      }),
      this.terminalManager.subscribeTerminalActivity((event) => {
        if (event.activity?.state === "working") {
          this.workingTerminalIds.add(event.terminalId);
        } else {
          this.workingTerminalIds.delete(event.terminalId);
        }
        this.refresh();
      }),
      this.terminalManager.subscribeTerminalWorkspaceContributionChanged((event) => {
        // Terminal exit emits no activity transition, only a contribution
        // change, so prune ids whose terminal is gone and reconcile the
        // event's terminal against its current activity.
        this.pruneExitedTerminals();
        const session = this.terminalManager.getTerminal(event.terminalId);
        if (session === undefined) {
          this.workingTerminalIds.delete(event.terminalId);
        } else if (session.getActivity()?.state === "working") {
          this.workingTerminalIds.add(event.terminalId);
        } else {
          this.workingTerminalIds.delete(event.terminalId);
        }
        this.refresh();
      }),
    );
    this.recomputeAgents();
  }

  snapshot(): HostActivitySnapshot {
    const nowMs = this.now();
    const servicesByTerminal = new Map<string, ScriptRuntimeEntry>();
    for (const entry of this.scriptRuntime.list()) {
      if (entry.type === "service" && entry.lifecycle === "running") {
        servicesByTerminal.set(entry.terminalId, entry);
      }
    }

    const commands: HostActivityCommandEntry[] = [];
    const services: HostActivityServiceEntry[] = [];
    const waiting: HostActivityWaitingEntry[] = [];
    for (const terminal of this.terminalManager.listTerminals()) {
      if (terminal.getExitInfo() !== null) {
        continue;
      }
      if (deriveTerminalActivityStatusBucket(terminal.getActivity()) === "needs_input") {
        waiting.push({ kind: "terminal", id: terminal.id, reason: "needs_input" });
      }
      const service = servicesByTerminal.get(terminal.id);
      if (service) {
        services.push({
          terminalId: terminal.id,
          workspaceId: service.workspaceId,
          scriptName: service.scriptName,
        });
        continue;
      }
      const { commandState } = terminal.getForeground();
      if (commandState === "prompt") {
        continue;
      }
      commands.push({ terminalId: terminal.id, reason: commandState });
    }
    for (const agent of this.agentManager.listAgents({ includeInternal: true })) {
      if (agent.lifecycle !== "closed" && agent.pendingPermissions.size > 0) {
        waiting.push({ kind: "agent", id: agent.id, reason: "permission" });
      }
    }

    const presence = this.clientPresence();
    let lastActivityAtMs: number | null = null;
    let present = false;
    for (const client of presence) {
      if (client.lastActivityAtMs === null) {
        continue;
      }
      const activityAtMs = Math.min(client.lastActivityAtMs, nowMs);
      lastActivityAtMs = Math.max(lastActivityAtMs ?? activityAtMs, activityAtMs);
      if (client.appVisible && nowMs - activityAtMs <= PRESENCE_THRESHOLD_MS) {
        present = true;
      }
    }

    return {
      state: this.state,
      since: new Date(this.sinceMs).toISOString(),
      busy: [...this.busy],
      commands,
      services,
      waiting,
      clients: {
        connected: presence.length,
        visible: presence.filter((client) => client.appVisible).length,
        present,
        lastActivityAt: lastActivityAtMs === null ? null : new Date(lastActivityAtMs).toISOString(),
      },
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const unsubscribe of this.unsubscribe) {
      unsubscribe();
    }
    this.unsubscribe.length = 0;
  }

  private recomputeAgents(): void {
    const entries: HostActivityBusyEntry[] = [];
    const pendingRegistrations = this.agentManager.pendingAgentRegistrationCount();
    if (pendingRegistrations > 0) {
      entries.push({ kind: "agent_registration", count: pendingRegistrations, reason: "starting" });
    }
    for (const agent of this.agentManager.listAgents({ includeInternal: true })) {
      if (agent.lifecycle === "closed") {
        continue;
      }
      if (agent.backgroundWorkPending === true) {
        entries.push({ kind: "agent", id: agent.id, reason: "background_work" });
      } else if (
        (agent.lifecycle === "initializing" || agent.lifecycle === "running") &&
        agent.pendingPermissions.size === 0
      ) {
        entries.push({ kind: "agent", id: agent.id, reason: "running" });
      }
    }
    this.agentEntries = entries;
    this.refresh();
  }

  private pruneExitedTerminals(): void {
    for (const id of this.workingTerminalIds) {
      if (this.terminalManager.getTerminal(id) === undefined) {
        this.workingTerminalIds.delete(id);
      }
    }
  }

  private refresh(): void {
    const busy: HostActivityBusyEntry[] = [...this.agentEntries];
    for (const id of this.workingTerminalIds) {
      busy.push({ kind: "terminal", id, reason: "working" });
    }
    const next: HostActivityState = busy.length > 0 ? "busy" : "quiescent";
    if (next !== this.state) {
      this.state = next;
      this.sinceMs = this.now();
    }
    this.busy = busy;
  }
}
