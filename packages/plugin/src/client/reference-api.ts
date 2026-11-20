import type {
  PaseoApi,
  PaseoAgent,
  PaseoAgentHandle,
  PaseoWorkspace,
  PaseoWorkspaceHandle,
  PaseoWorkspaceCreateOptions,
} from "@getpaseo/client";
import type { PaseoTerminal, PaseoTerminalHandle } from "@getpaseo/client";
import type { PluginProjectSnapshot } from "../contracts.js";
import type { AgentRef, ProjectRef, TerminalRef, WorkspaceRef } from "../refs.js";
import type { PluginSidebarViewProps } from "./contracts.js";

export interface PluginProjectHandle {
  readonly ref: ProjectRef;
  open(): void;
  createWorkspace(
    input?: Omit<PaseoWorkspaceCreateOptions, "source"> & {
      source?: PaseoWorkspaceCreateOptions["source"];
    },
  ): Promise<PaseoWorkspaceHandle>;
}
export interface PluginTerminalHandle extends PaseoTerminalHandle {
  focus(): void;
}
export interface PluginPaseoApi extends PaseoApi {
  workspaces: Omit<PaseoApi["workspaces"], "ref"> & {
    ref(workspace: string | PaseoWorkspace | WorkspaceRef): PaseoWorkspaceHandle;
  };
  agents: Omit<PaseoApi["agents"], "ref"> & {
    ref(agent: string | PaseoAgent | AgentRef): PaseoAgentHandle;
  };
  projects: PaseoApi["projects"] & { ref(project: ProjectRef): PluginProjectHandle };
  terminals: Omit<PaseoApi["terminals"], "ref"> & {
    ref(terminal: TerminalRef): PluginTerminalHandle;
    ref(terminal: string | PaseoTerminal): PaseoTerminalHandle;
  };
}

/** Host adapter; the installation retains its single API identity across every surface. */
export function createPluginReferenceApi(input: {
  paseo: PaseoApi;
  resolveHost(hostId: string): PaseoApi;
  readProject(ref: ProjectRef): PluginProjectSnapshot | null;
  navigation: PluginSidebarViewProps["navigation"];
}): PluginPaseoApi {
  const { paseo } = input;
  const workspaceRef = paseo.workspaces.ref;
  const agentRef = paseo.agents.ref;
  const terminalRef = paseo.terminals.ref;
  function refWorkspace(workspace: string | PaseoWorkspace | WorkspaceRef) {
    if (typeof workspace !== "string" && "hostId" in workspace)
      return input.resolveHost(workspace.hostId).workspaces.ref(workspace.id);
    return workspaceRef(workspace);
  }
  function refAgent(agent: string | PaseoAgent | AgentRef) {
    if (typeof agent !== "string" && "hostId" in agent)
      return input.resolveHost(agent.hostId).agents.ref(agent.id);
    return agentRef(agent);
  }
  function terminal(ref: TerminalRef): PluginTerminalHandle;
  function terminal(ref: string | PaseoTerminal): PaseoTerminalHandle;
  function terminal(ref: TerminalRef | string | PaseoTerminal): PaseoTerminalHandle {
    if (typeof ref !== "string" && "hostId" in ref) {
      const handle = input.resolveHost(ref.hostId).terminals.ref(ref.id);
      return Object.assign(handle, { focus: () => input.navigation.openTerminal(ref) });
    }
    return terminalRef(ref);
  }
  function project(ref: ProjectRef): PluginProjectHandle {
    return {
      ref,
      open: () => input.navigation.openProject(ref),
      async createWorkspace(options = {}) {
        const snapshot = input.readProject(ref);
        if (!snapshot) throw new Error("Project is no longer available");
        const source = options.source ?? { kind: "directory", path: snapshot.rootPath };
        return input.resolveHost(ref.hostId).workspaces.create({ ...options, source });
      },
    };
  }
  return Object.assign(paseo, {
    workspaces: Object.assign(paseo.workspaces, { ref: refWorkspace }),
    agents: Object.assign(paseo.agents, { ref: refAgent }),
    projects: Object.assign(paseo.projects, { ref: project }),
    terminals: Object.assign(paseo.terminals, { ref: terminal }),
  });
}
