import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  HubcodeConfigRawSchema,
  type HubcodeConfigRaw,
  type HubcodeConfigRevision,
  type ProjectConfigRpcError,
} from "./hubcode-config-schema.js";
export {
  HubcodeConfigRevisionSchema,
  ProjectConfigRpcErrorSchema,
  type HubcodeConfigRevision,
  type ProjectConfigRpcError,
} from "./hubcode-config-schema.js";

export const HUBCODE_CONFIG_FILE_NAME = "hubcode.json";

export type ReadHubcodeConfigForEditResult =
  | { ok: true; config: HubcodeConfigRaw | null; revision: HubcodeConfigRevision | null }
  | { ok: false; error: ProjectConfigRpcError };

export type WriteHubcodeConfigForEditResult =
  | { ok: true; config: HubcodeConfigRaw; revision: HubcodeConfigRevision }
  | { ok: false; error: ProjectConfigRpcError };

export interface WriteHubcodeConfigForEditInput {
  repoRoot: string;
  config: HubcodeConfigRaw;
  expectedRevision: HubcodeConfigRevision | null;
}

export function resolveHubcodeConfigPath(repoRoot: string): string {
  return join(repoRoot, HUBCODE_CONFIG_FILE_NAME);
}

export function statHubcodeConfigPath(repoRoot: string): HubcodeConfigRevision | null {
  const configPath = resolveHubcodeConfigPath(repoRoot);
  if (!existsSync(configPath)) {
    return null;
  }
  const stats = statSync(configPath);
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

export function readHubcodeConfigJson(repoRoot: string): unknown | null {
  const configPath = resolveHubcodeConfigPath(repoRoot);
  if (!existsSync(configPath)) {
    return null;
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

export function readHubcodeConfigForEdit(repoRoot: string): ReadHubcodeConfigForEditResult {
  try {
    const json = readHubcodeConfigJson(repoRoot);
    if (json === null) {
      return { ok: true, config: null, revision: null };
    }
    return {
      ok: true,
      config: HubcodeConfigRawSchema.parse(json),
      revision: statHubcodeConfigPath(repoRoot),
    };
  } catch {
    return {
      ok: false,
      error: { code: "invalid_project_config" },
    };
  }
}

export function writeHubcodeConfigForEdit(
  input: WriteHubcodeConfigForEditInput,
): WriteHubcodeConfigForEditResult {
  const parsed = HubcodeConfigRawSchema.safeParse(input.config);
  if (!parsed.success) {
    return { ok: false, error: { code: "invalid_project_config" } };
  }

  const configPath = resolveHubcodeConfigPath(input.repoRoot);
  const tempPath = join(
    input.repoRoot,
    `.${HUBCODE_CONFIG_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    writeFileSync(tempPath, `${JSON.stringify(parsed.data, null, 2)}\n`);
    const currentRevision = statHubcodeConfigPath(input.repoRoot);
    if (!hubcodeConfigRevisionsEqual(currentRevision, input.expectedRevision)) {
      removeTempHubcodeConfig(tempPath);
      return {
        ok: false,
        error: { code: "stale_project_config", currentRevision },
      };
    }

    renameSync(tempPath, configPath);
    const revision = statHubcodeConfigPath(input.repoRoot);
    if (!revision) {
      return { ok: false, error: { code: "write_failed" } };
    }
    return { ok: true, config: parsed.data, revision };
  } catch {
    removeTempHubcodeConfig(tempPath);
    return { ok: false, error: { code: "write_failed" } };
  }
}

function hubcodeConfigRevisionsEqual(
  left: HubcodeConfigRevision | null,
  right: HubcodeConfigRevision | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function removeTempHubcodeConfig(tempPath: string): void {
  try {
    rmSync(tempPath, { force: true });
  } catch {
    // Best-effort cleanup only; callers need the original write outcome.
  }
}
