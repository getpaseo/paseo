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
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import type {
  SpawnWorkspaceScriptOptions,
  WorktreeScriptResult,
} from "../../worktree-bootstrap.js";
import {
  buildWorkspaceScriptPayloads,
  readPaseoConfigForProjection,
} from "../../script-status-projection.js";
import { deriveProjectSlug } from "../../workspace-git-metadata.js";

type WorkspaceScriptsPayload = WorkspaceDescriptorPayload["scripts"];

interface WorkspaceScriptGitMetadata {
  projectSlug: string;
  currentBranch: string | null;
}

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
  buildSnapshot(workspaceId: string, workspaceDirectory: string): WorkspaceScriptsPayload;
  emitStatusUpdate(workspaceId: string, workspaceDirectory: string): void;
  start(request: StartWorkspaceScriptRequest): Promise<void>;
}

type WorkspaceScriptsGitSource = Pick<
  WorkspaceGitService,
  "peekSnapshot" | "getWorkspaceGitMetadata"
>;

export function createWorkspaceScriptsService(deps: {
  serviceProxy: ServiceProxySubsystem | null;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore | null;
  terminalManager: TerminalManager | null;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
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
    workspaceGitService,
    getDaemonTcpPort,
    getDaemonTcpHost,
    serviceProxyPublicBaseUrl,
    resolveScriptHealth,
    logger,
    emit,
    spawnWorkspaceScript,
  } = deps;

  function resolveGitMetadata(workspaceDirectory: string): WorkspaceScriptGitMetadata | undefined {
    const snapshot = workspaceGitService.peekSnapshot(workspaceDirectory);
    if (!snapshot) {
      return undefined;
    }
    return {
      projectSlug: deriveProjectSlug(
        workspaceDirectory,
        snapshot.git.isGit ? snapshot.git.remoteUrl : null,
      ),
      currentBranch: snapshot.git.currentBranch,
    };
  }

  function buildSnapshot(workspaceId: string, workspaceDirectory: string): WorkspaceScriptsPayload {
    if (!serviceProxy || !scriptRuntimeStore) {
      return [];
    }
    return buildWorkspaceScriptPayloads({
      workspaceId,
      workspaceDirectory,
      paseoConfig: readPaseoConfigForProjection(workspaceDirectory, logger),
      serviceProxy,
      runtimeStore: scriptRuntimeStore,
      daemonPort: getDaemonTcpPort?.() ?? null,
      serviceProxyPublicBaseUrl,
      gitMetadata: resolveGitMetadata(workspaceDirectory),
      resolveHealth: resolveScriptHealth ?? undefined,
    });
  }

  function emitStatusUpdate(workspaceId: string, workspaceDirectory: string): void {
    emit({
      type: "script_status_update",
      payload: {
        workspaceId,
        scripts: buildSnapshot(workspaceId, workspaceDirectory),
      },
    });
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
      const gitMetadata = await workspaceGitService.getWorkspaceGitMetadata(workspace.cwd);

      const serviceResult = await spawnWorkspaceScript({
        repoRoot: workspace.cwd,
        workspaceId: workspace.workspaceId,
        projectSlug: gitMetadata.projectSlug,
        branchName: gitMetadata.currentBranch,
        scriptName: request.scriptName,
        daemonPort: getDaemonTcpPort?.() ?? null,
        daemonListenHost: getDaemonTcpHost?.() ?? null,
        serviceProxyPublicBaseUrl,
        serviceProxy,
        runtimeStore: scriptRuntimeStore,
        terminalManager,
        logger,
        onLifecycleChanged: () => {
          emitStatusUpdate(workspace.workspaceId, workspace.cwd);
        },
      });

      emitStatusUpdate(workspace.workspaceId, workspace.cwd);
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
