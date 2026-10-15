import type {
  PaseoConfigRaw,
  PaseoConfigRevision,
  PaseoScriptEntryRaw,
} from "@getpaseo/protocol/messages";
import {
  readPaseoConfigForEdit,
  resolvePaseoConfigPath,
  statPaseoConfigPath,
  writePaseoConfigForEdit,
} from "../../../utils/paseo-config-file.js";

export type WorkspaceScriptConfigurationRead =
  | {
      ok: true;
      projectConfig: PaseoConfigRaw | null;
      workspaceConfig: PaseoConfigRaw | null;
      projectRevision: PaseoConfigRevision | null;
      workspaceRevision: PaseoConfigRevision | null;
    }
  | { ok: false; error: "invalid_config" };

export function readWorkspaceScriptConfiguration(input: {
  projectDirectory: string;
  workspaceDirectory: string;
}): WorkspaceScriptConfigurationRead {
  const project = readPaseoConfigForEdit(input.projectDirectory);
  const workspace =
    resolvePaseoConfigPath(input.projectDirectory) ===
    resolvePaseoConfigPath(input.workspaceDirectory)
      ? project
      : readPaseoConfigForEdit(input.workspaceDirectory);
  if (!project.ok || !workspace.ok) return { ok: false, error: "invalid_config" };
  return {
    ok: true,
    projectConfig: project.config,
    workspaceConfig: workspace.config,
    projectRevision: project.revision,
    workspaceRevision: workspace.revision,
  };
}

export type WorkspaceScriptConfigurationWrite =
  | {
      ok: true;
      written: "both";
      projectRevision: PaseoConfigRevision;
      workspaceRevision: PaseoConfigRevision;
    }
  | {
      ok: false;
      error:
        | "invalid_config"
        | "stale_revision"
        | "collision"
        | "project_write_failed"
        | "workspace_write_failed";
      written: "none" | "project";
      projectRevision: PaseoConfigRevision | null;
      workspaceRevision: PaseoConfigRevision | null;
    };

export function writeWorkspaceScriptConfiguration(input: {
  projectDirectory: string;
  workspaceDirectory: string;
  scriptName: string;
  command: string;
  port: number | null;
  projectRevision: PaseoConfigRevision | null;
  workspaceRevision: PaseoConfigRevision | null;
}): WorkspaceScriptConfigurationWrite {
  const snapshot = readWorkspaceScriptConfiguration(input);
  if (!snapshot.ok)
    return {
      ok: false,
      error: "invalid_config",
      written: "none",
      projectRevision: null,
      workspaceRevision: null,
    };
  const sameFile =
    resolvePaseoConfigPath(input.projectDirectory) ===
    resolvePaseoConfigPath(input.workspaceDirectory);
  if (
    !sameRevision(snapshot.projectRevision, input.projectRevision) ||
    !sameRevision(snapshot.workspaceRevision, input.workspaceRevision)
  ) {
    return {
      ok: false,
      error: "stale_revision",
      written: "none",
      projectRevision: snapshot.projectRevision,
      workspaceRevision: snapshot.workspaceRevision,
    };
  }
  const existingProject = snapshot.projectConfig?.scripts?.[input.scriptName];
  const existingWorkspace = snapshot.workspaceConfig?.scripts?.[input.scriptName];
  if (isCollision(existingProject) || (!sameFile && isCollision(existingWorkspace))) {
    return {
      ok: false,
      error: "collision",
      written: "none",
      projectRevision: snapshot.projectRevision,
      workspaceRevision: snapshot.workspaceRevision,
    };
  }

  const service: PaseoScriptEntryRaw = {
    ...(existingProject ?? existingWorkspace),
    type: "service",
    command: input.command,
    ...(input.port === null ? { port: undefined } : { port: input.port }),
  };
  const projectConfig = mergeScript(snapshot.projectConfig, input.scriptName, service);
  const projectWrite = writePaseoConfigForEdit({
    repoRoot: input.projectDirectory,
    config: projectConfig,
    expectedRevision: input.projectRevision,
  });
  if (!projectWrite.ok) {
    return {
      ok: false,
      error: mapWriteError(projectWrite.error.code),
      written: "none",
      projectRevision: snapshot.projectRevision,
      workspaceRevision: snapshot.workspaceRevision,
    };
  }
  if (sameFile) {
    return {
      ok: true,
      written: "both",
      projectRevision: projectWrite.revision,
      workspaceRevision: projectWrite.revision,
    };
  }

  const workspaceConfig = mergeScript(snapshot.workspaceConfig, input.scriptName, service);
  const workspaceWrite = writePaseoConfigForEdit({
    repoRoot: input.workspaceDirectory,
    config: workspaceConfig,
    expectedRevision: input.workspaceRevision,
  });
  if (!workspaceWrite.ok) {
    return {
      ok: false,
      error:
        workspaceWrite.error.code === "stale_project_config"
          ? "stale_revision"
          : "workspace_write_failed",
      written: "project",
      projectRevision: projectWrite.revision,
      workspaceRevision: statPaseoConfigPath(input.workspaceDirectory),
    };
  }
  return {
    ok: true,
    written: "both",
    projectRevision: projectWrite.revision,
    workspaceRevision: workspaceWrite.revision,
  };
}

function mergeScript(
  config: PaseoConfigRaw | null,
  name: string,
  entry: PaseoScriptEntryRaw,
): PaseoConfigRaw {
  return { ...config, scripts: { ...config?.scripts, [name]: entry } };
}

function isCollision(entry: PaseoScriptEntryRaw | undefined): boolean {
  return entry !== undefined && entry.type !== "service";
}

function sameRevision(
  left: PaseoConfigRevision | null,
  right: PaseoConfigRevision | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function mapWriteError(
  code: string,
):
  | "invalid_config"
  | "stale_revision"
  | "collision"
  | "project_write_failed"
  | "workspace_write_failed" {
  if (code === "invalid_project_config") return "invalid_config";
  if (code === "stale_project_config") return "stale_revision";
  return "project_write_failed";
}
