import { resolve } from "path";
import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { ProjectRegistry } from "../../workspace-registry.js";
import {
  readPaseoConfigForEdit,
  resolveProjectConfigRoot,
  writePaseoConfigForEdit,
  type ProjectConfigRpcError,
} from "../../../utils/paseo-config-file.js";
import { hasUncommittedWorktreeSetupChanges } from "./worktree-setup-commit-status.js";

export interface ProjectConfigSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface ProjectConfigSessionOptions {
  host: ProjectConfigSessionHost;
  projectRegistry: Pick<ProjectRegistry, "list">;
  onProjectConfigWritten?: (projectId: string) => Promise<void>;
  logger: pino.Logger;
}

interface KnownProjectConfigTarget {
  projectId: string;
  repoRoot: string;
}

/**
 * A client's read/write surface for a project's on-disk paseo.json. Resolves the
 * request's repoRoot against the known (non-archived) project roots — accepting a
 * trailing slash or a symlink via realpath — then reads or writes the config
 * substrate and emits the matching response. Reaches no state beyond the injected
 * project registry and the outbound channel.
 */
export class ProjectConfigSession {
  private readonly host: ProjectConfigSessionHost;
  private readonly projectRegistry: Pick<ProjectRegistry, "list">;
  private readonly onProjectConfigWritten: ((projectId: string) => Promise<void>) | undefined;
  private readonly logger: pino.Logger;

  constructor(options: ProjectConfigSessionOptions) {
    this.host = options.host;
    this.projectRegistry = options.projectRegistry;
    this.onProjectConfigWritten = options.onProjectConfigWritten;
    this.logger = options.logger;
  }

  async handleReadProjectConfigRequest(
    msg: Extract<SessionInboundMessage, { type: "read_project_config_request" }>,
  ): Promise<void> {
    const target = await this.resolveKnownProjectConfigTarget(msg.repoRoot);
    if (!target) {
      this.emitProjectConfigReadFailure(msg, { code: "project_not_found" });
      return;
    }
    const { repoRoot } = target;

    const result = await readPaseoConfigForEdit(repoRoot);
    if (!result.ok) {
      this.logger.warn(
        { repoRoot, requestId: msg.requestId, outcome: result.error.code },
        "Failed to read project config",
      );
      this.emitProjectConfigReadFailure(msg, result.error, repoRoot);
      return;
    }

    if (result.config === null) {
      this.logger.debug(
        { repoRoot, requestId: msg.requestId, outcome: "missing_project_config" },
        "Project config missing",
      );
    }

    const setupCommitStatus = await this.readSetupCommitStatus(repoRoot, result.config);

    this.host.emit({
      type: "read_project_config_response",
      payload: {
        requestId: msg.requestId,
        repoRoot,
        ok: true,
        config: result.config,
        revision: result.revision,
        ...(setupCommitStatus === null
          ? {}
          : { hasUncommittedWorktreeSetupChanges: setupCommitStatus }),
      },
    });
  }

  async handleWriteProjectConfigRequest(
    msg: Extract<SessionInboundMessage, { type: "write_project_config_request" }>,
  ): Promise<void> {
    const target = await this.resolveKnownProjectConfigTarget(msg.repoRoot);
    if (!target) {
      this.emitProjectConfigWriteFailure(msg, { code: "project_not_found" });
      return;
    }
    const { repoRoot } = target;

    this.logger.debug(
      { repoRoot, requestId: msg.requestId, outcome: "write_attempt" },
      "Writing project config",
    );
    const result = await writePaseoConfigForEdit({
      repoRoot,
      config: msg.config,
      expectedRevision: msg.expectedRevision,
    });
    if (!result.ok) {
      this.logger.debug(
        { repoRoot, requestId: msg.requestId, outcome: result.error.code },
        "Project config write did not complete",
      );
      this.emitProjectConfigWriteFailure(msg, result.error, repoRoot);
      return;
    }

    this.logger.debug(
      { repoRoot, requestId: msg.requestId, outcome: "written" },
      "Project config written",
    );
    if (this.onProjectConfigWritten) {
      try {
        await this.onProjectConfigWritten(target.projectId);
      } catch (error) {
        // The config is already durable. A subscription refresh is best effort and
        // must not turn a successful write into a failed RPC.
        this.logger.warn(
          { err: error, projectId: target.projectId, repoRoot, requestId: msg.requestId },
          "Failed to refresh workspaces after project config write",
        );
      }
    }
    const setupCommitStatus = await this.readSetupCommitStatus(repoRoot, result.config);
    this.host.emit({
      type: "write_project_config_response",
      payload: {
        requestId: msg.requestId,
        repoRoot,
        ok: true,
        config: result.config,
        revision: result.revision,
        ...(setupCommitStatus === null
          ? {}
          : { hasUncommittedWorktreeSetupChanges: setupCommitStatus }),
      },
    });
  }

  private async readSetupCommitStatus(
    repoRoot: string,
    config: Parameters<typeof hasUncommittedWorktreeSetupChanges>[0]["currentConfig"],
  ): Promise<boolean | null> {
    try {
      return await hasUncommittedWorktreeSetupChanges({ repoRoot, currentConfig: config });
    } catch (error) {
      this.logger.debug({ repoRoot, error }, "Could not inspect committed worktree setup");
      return null;
    }
  }

  private emitProjectConfigReadFailure(
    msg: Extract<SessionInboundMessage, { type: "read_project_config_request" }>,
    error: ProjectConfigRpcError,
    repoRoot = msg.repoRoot,
  ): void {
    this.host.emit({
      type: "read_project_config_response",
      payload: {
        requestId: msg.requestId,
        repoRoot,
        ok: false,
        error,
      },
    });
  }

  private emitProjectConfigWriteFailure(
    msg: Extract<SessionInboundMessage, { type: "write_project_config_request" }>,
    error: ProjectConfigRpcError,
    repoRoot = msg.repoRoot,
  ): void {
    this.host.emit({
      type: "write_project_config_response",
      payload: {
        requestId: msg.requestId,
        repoRoot,
        ok: false,
        error,
      },
    });
  }

  private async resolveKnownProjectConfigTarget(
    repoRoot: string,
  ): Promise<KnownProjectConfigTarget | null> {
    const requestedRoot = resolve(repoRoot);
    const projects = await this.projectRegistry.list();
    const activeRoots = new Set(
      projects
        .filter((project) => project.archivedAt === null)
        .map((project) => resolve(project.rootPath)),
    );
    const root = await resolveProjectConfigRoot(requestedRoot, activeRoots);
    if (!root) return null;
    // Authorization follows live registry state after alias IO, including archive/removal.
    const current = await this.projectRegistry.list();
    const project = current.find(
      (candidate) => candidate.archivedAt === null && resolve(candidate.rootPath) === root,
    );
    return project ? { projectId: project.projectId, repoRoot: root } : null;
  }
}
