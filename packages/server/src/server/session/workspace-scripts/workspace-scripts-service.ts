import type pino from "pino";
import type {
  SessionOutboundMessage,
  StartWorkspaceScriptRequest,
  WorkspaceDescriptorPayload,
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
    if (!snapshot) return undefined;
    return {
      projectSlug: deriveProjectSlug(
        workspace.cwd,
        snapshot.git.isGit ? snapshot.git.remoteUrl : null,
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

  async function start(request: StartWorkspaceScriptRequest): Promise<void> {
    try {
      if (!terminalManager || !serviceProxy || !scriptRuntimeStore) {
        throw new Error("Workspace scripts are not available on this daemon");
      }

      const workspace = await workspaceRegistry.get(request.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${request.workspaceId}`);
      }
      const project = await projectRegistry.get(workspace.projectId);
      const projectSlug = project
        ? deriveProjectServiceSlug(project)
        : deriveProjectSlug(
            workspace.cwd,
            workspaceGitService.peekSnapshot(workspace.cwd)?.git.remoteUrl ?? null,
          );
      const branchName =
        workspaceGitService.peekSnapshot(workspace.cwd)?.git.currentBranch ??
        workspace.branch ??
        null;

      const serviceResult = await spawnWorkspaceScript({
        repoRoot: workspace.cwd,
        workspaceId: workspace.workspaceId,
        projectSlug,
        branchName,
        scriptName: request.scriptName,
        daemonPort: getDaemonTcpPort?.() ?? null,
        daemonListenHost: getDaemonTcpHost?.() ?? null,
        serviceProxyPublicBaseUrl,
        serviceProxy,
        runtimeStore: scriptRuntimeStore,
        terminalManager,
        logger,
        onLifecycleChanged: () => {
          void emitStatusUpdate(workspace.workspaceId, workspace.cwd);
        },
      });

      void emitStatusUpdate(workspace.workspaceId, workspace.cwd);
      emit({
        type: "start_workspace_script_response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          terminalId: serviceResult.terminalId,
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start workspace script";
      logger.error(
        {
          err: error,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
        },
        "Failed to start workspace script",
      );
      emit({
        type: "start_workspace_script_response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          terminalId: null,
          error: message,
        },
      });
    }
  }

  return { buildSnapshot, emitStatusUpdate, start };
}
