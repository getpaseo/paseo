import type pino from "pino";
import type {
  SessionOutboundMessage,
  StartWorkspaceScriptRequest,
  WorkspaceDescriptorPayload,
  WorkspaceScriptPayload,
} from "../../messages.js";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { ServiceProxySubsystem } from "../../service-proxy.js";
import type { WorkspaceScriptRuntimeStore } from "../../workspace-script-runtime-store.js";
import type { ScriptHealthState } from "../../script-health-monitor.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../../workspace-registry.js";
import type {
  SpawnWorkspaceScriptOptions,
  WorktreeScriptResult,
} from "../../worktree-bootstrap.js";
import {
  buildWorkspaceScriptPayloads,
  readPaseoConfigForProjection,
} from "../../script-status-projection.js";
import { deriveProjectServiceSlug, deriveProjectSlug } from "../../workspace-git-metadata.js";
import type { PaseoServicePortAllocation } from "@getpaseo/protocol/paseo-config-schema";

type WorkspaceScriptsPayload = WorkspaceDescriptorPayload["scripts"];

/**
 * The service-proxy-backed scripts a workspace exposes: build the scripts payload
 * snapshot, emit a script_status_update to clients, and start a script.
 *
 * The workspace descriptor builder, the script-status emission path, and the
 * start-script RPC all funnel through one assembly of buildWorkspaceScriptPayloads'
 * inputs and one "scripts available on this daemon?" guard, instead of duplicating
 * that assembly and guard across the session.
 */
export interface WorkspaceScriptsService {
  buildSnapshot(
    workspace: PersistedWorkspaceRecord,
    project?: PersistedProjectRecord | null,
  ): WorkspaceScriptsPayload;
  emitStatusUpdate(workspaceId: string, workspaceDirectory: string): Promise<void>;
  list(workspaceId: string): Promise<WorkspaceScriptPayload[]>;
  launch(input: { workspaceId: string; scriptName: string }): Promise<WorkspaceScriptPayload>;
  stop(input: { workspaceId: string; scriptName: string }): Promise<WorkspaceScriptPayload>;
  start(request: StartWorkspaceScriptRequest): Promise<void>;
}

type WorkspaceScriptsGitSource = Pick<WorkspaceGitService, "peekSnapshot">;

export function createWorkspaceScriptsService(deps: {
  serviceProxy: ServiceProxySubsystem | null;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore | null;
  terminalManager: TerminalManager | null;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  projectRegistry: Pick<ProjectRegistry, "get">;
  workspaceGitService: WorkspaceScriptsGitSource;
  getDaemonTcpPort: (() => number | null) | null;
  getDaemonTcpHost: (() => string | null) | null;
  serviceProxyPublicBaseUrl: string | null;
  resolveScriptHealth: ((hostname: string) => ScriptHealthState | null) | null;
  globalServicePorts?: PaseoServicePortAllocation;
  logger: pino.Logger;
  emit: (message: SessionOutboundMessage) => void;
  spawnWorkspaceScript: (options: SpawnWorkspaceScriptOptions) => Promise<WorktreeScriptResult>;
}): WorkspaceScriptsService {
  const {
    serviceProxy,
    scriptRuntimeStore,
    terminalManager,
    workspaceRegistry,
    projectRegistry,
    workspaceGitService,
    getDaemonTcpPort,
    getDaemonTcpHost,
    serviceProxyPublicBaseUrl,
    resolveScriptHealth,
    globalServicePorts,
    logger,
    emit,
    spawnWorkspaceScript,
  } = deps;

  function resolveGitMetadata(
    workspace: PersistedWorkspaceRecord,
    project: { projectId: string; rootPath: string } | null,
  ) {
    const snapshot = workspaceGitService.peekSnapshot(workspace.cwd);
    const currentBranch = snapshot?.git.currentBranch ?? workspace.branch ?? null;
    if (project) {
      return {
        projectSlug: deriveProjectServiceSlug(project),
        currentBranch,
      };
    }
    return {
      projectSlug: deriveProjectSlug(
        workspace.cwd,
        snapshot?.git.isGit ? snapshot.git.remoteUrl : null,
      ),
      currentBranch,
    };
  }

  function buildSnapshot(
    workspace: PersistedWorkspaceRecord,
    project: PersistedProjectRecord | null = null,
  ): WorkspaceScriptsPayload {
    if (!serviceProxy || !scriptRuntimeStore) {
      return [];
    }
    return buildWorkspaceScriptPayloads({
      workspaceId: workspace.workspaceId,
      workspaceDirectory: workspace.cwd,
      paseoConfig: readPaseoConfigForProjection(workspace.cwd, logger),
      serviceProxy,
      runtimeStore: scriptRuntimeStore,
      daemonPort: getDaemonTcpPort?.() ?? null,
      serviceProxyPublicBaseUrl,
      gitMetadata: resolveGitMetadata(workspace, project),
      resolveHealth: resolveScriptHealth ?? undefined,
    });
  }

  async function emitStatusUpdate(workspaceId: string, _workspaceDirectory: string): Promise<void> {
    try {
      const workspace = await workspaceRegistry.get(workspaceId);
      if (!workspace) return;
      const project = await projectRegistry.get(workspace.projectId);
      emit({
        type: "script_status_update",
        payload: { workspaceId, scripts: buildSnapshot(workspace, project) },
      });
    } catch (error) {
      logger.warn({ err: error, workspaceId }, "Failed to project workspace script status");
    }
  }

  async function getWorkspace(workspaceId: string) {
    const workspace = await workspaceRegistry.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return workspace;
  }

  function requireAvailable(): {
    serviceProxy: ServiceProxySubsystem;
    runtimeStore: WorkspaceScriptRuntimeStore;
    terminalManager: TerminalManager;
  } {
    if (!terminalManager || !serviceProxy || !scriptRuntimeStore) {
      throw new Error("Workspace scripts are not available on this daemon");
    }
    return { serviceProxy, runtimeStore: scriptRuntimeStore, terminalManager };
  }

  async function list(workspaceId: string): Promise<WorkspaceScriptPayload[]> {
    requireAvailable();
    const workspace = await getWorkspace(workspaceId);
    const project = await projectRegistry.get(workspace.projectId);
    return buildSnapshot(workspace, project);
  }

  async function launchProcess(
    input: { workspaceId: string; scriptName: string },
    hooks?: { onTerminalReady?: (terminalId: string) => void },
  ) {
    const available = requireAvailable();
    const workspace = await getWorkspace(input.workspaceId);
    const project = await projectRegistry.get(workspace.projectId);
    const gitMetadata = resolveGitMetadata(workspace, project);
    const result = await spawnWorkspaceScript({
      repoRoot: workspace.cwd,
      workspaceId: workspace.workspaceId,
      projectSlug: gitMetadata.projectSlug,
      branchName: gitMetadata.currentBranch,
      scriptName: input.scriptName,
      daemonPort: getDaemonTcpPort?.() ?? null,
      daemonListenHost: getDaemonTcpHost?.() ?? null,
      serviceProxyPublicBaseUrl,
      serviceProxy: available.serviceProxy,
      runtimeStore: available.runtimeStore,
      terminalManager: available.terminalManager,
      globalServicePorts,
      logger,
      onLifecycleChanged: () => {
        void emitStatusUpdate(workspace.workspaceId, workspace.cwd);
      },
      onTerminalReady: (terminalId) => {
        void emitStatusUpdate(workspace.workspaceId, workspace.cwd);
        hooks?.onTerminalReady?.(terminalId);
      },
    });
    return { workspace, project, terminalId: result.terminalId };
  }

  async function launch(input: {
    workspaceId: string;
    scriptName: string;
  }): Promise<WorkspaceScriptPayload> {
    const { workspace, project } = await launchProcess(input);
    const script = buildSnapshot(workspace, project).find(
      (entry) => entry.scriptName === input.scriptName,
    );
    if (!script) {
      throw new Error(`Script '${input.scriptName}' did not produce a status record`);
    }
    void emitStatusUpdate(workspace.workspaceId, workspace.cwd);
    return script;
  }

  async function stop(input: {
    workspaceId: string;
    scriptName: string;
  }): Promise<WorkspaceScriptPayload> {
    const available = requireAvailable();
    const workspace = await getWorkspace(input.workspaceId);
    const project = await projectRegistry.get(workspace.projectId);
    const runtime = available.runtimeStore.get(input);
    if (!runtime || runtime.lifecycle !== "running") {
      throw new Error(`Script '${input.scriptName}' is not running`);
    }
    if (!available.terminalManager.getTerminal(runtime.terminalId)) {
      throw new Error(`Terminal for script '${input.scriptName}' is no longer available`);
    }

    // The launcher's terminal exit listener owns route removal and runtime state updates.
    await available.terminalManager.killTerminalAndWait(runtime.terminalId);

    const script = buildSnapshot(workspace, project).find(
      (entry) => entry.scriptName === input.scriptName,
    );
    if (!script) {
      throw new Error(`Script '${input.scriptName}' did not produce a status record`);
    }
    void emitStatusUpdate(workspace.workspaceId, workspace.cwd);
    return script;
  }

  async function start(request: StartWorkspaceScriptRequest): Promise<void> {
    const respond = (terminalId: string | null, error: string | null): void => {
      emit({
        type: "start_workspace_script_response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          terminalId,
          error,
        },
      });
    };

    // Respond as soon as the terminal exists so a client can focus its tab
    // immediately, then let the readiness wait + command send run in the
    // background. Awaiting the whole thing would block this connection's
    // message loop for up to the readiness timeout, and delay the tab.
    let responded = false;
    const respondOnce = (terminalId: string | null, error: string | null): void => {
      if (responded) {
        return;
      }
      responded = true;
      respond(terminalId, error);
    };
    const failStart = (error: unknown): void => {
      const message = error instanceof Error ? error.message : "Failed to start workspace script";
      logger.error(
        { err: error, workspaceId: request.workspaceId, scriptName: request.scriptName },
        "Failed to start workspace script",
      );
      respondOnce(null, message);
    };

    // Resolves with the response, not with the finished readiness wait, so this
    // returns as soon as the terminal is handed over (or the start failed).
    await new Promise<void>((resolveStart) => {
      void launchProcess(request, {
        onTerminalReady: (terminalId) => {
          respondOnce(terminalId, null);
          resolveStart();
        },
      })
        .catch((error: unknown) => {
          if (responded) {
            // The terminal was already handed over: this is a shell that stopped
            // to ask something on its way to a prompt, not a start failure. It is
            // on the client's screen showing what it wants. Don't respond again,
            // and don't log it as an error — it is a normal interaction that
            // would otherwise flood the log on every start under oh-my-zsh.
            logger.debug(
              { err: error, workspaceId: request.workspaceId, scriptName: request.scriptName },
              "Script terminal handed over before its shell reached a prompt",
            );
            return;
          }
          // A failure before any terminal existed is a real start error.
          failStart(error);
        })
        .finally(resolveStart);
    });
  }

  return { buildSnapshot, emitStatusUpdate, list, launch, stop, start };
}
