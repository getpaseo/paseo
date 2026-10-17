import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "pino";

import { claudeConfigDir } from "./project-dir.js";

export interface ClaudeAuthRefreshSettings {
  awsAuthRefresh?: string;
  env?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readClaudeAuthRefreshSettingsSync(
  configDirOrEnv?: string | NodeJS.ProcessEnv,
  logger?: Logger,
): ClaudeAuthRefreshSettings {
  const configDir =
    typeof configDirOrEnv === "string"
      ? configDirOrEnv
      : claudeConfigDir(configDirOrEnv ?? process.env);
  const settingsPath = path.join(configDir, "settings.json");
  try {
    const rawSettings = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(rawSettings);
    if (!isRecord(parsed)) {
      return {};
    }
    const awsAuthRefresh =
      typeof parsed.awsAuthRefresh === "string" && parsed.awsAuthRefresh.trim().length > 0
        ? parsed.awsAuthRefresh.trim()
        : undefined;

    const env: Record<string, string> = {};
    if (isRecord(parsed.env)) {
      for (const [key, val] of Object.entries(parsed.env)) {
        if (typeof val === "string") {
          env[key] = val;
        }
      }
    }

    return {
      ...(awsAuthRefresh ? { awsAuthRefresh } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  } catch (error) {
    logger?.debug({ err: error, settingsPath }, "Failed to read Claude auth refresh settings");
    return {};
  }
}

const AWS_AUTH_EXPIRY_PATTERNS = [
  /AWS auth refresh timed out/i,
  /Error running awsAuthRefresh/i,
  /\bExpiredToken/i,
  /\bexpired token\b/i,
  /security token included in the request is expired/i,
];

export interface ClassifyAwsAuthRefreshFailureInput {
  message: string;
  recentStderr?: string;
  awsAuthRefresh?: string | null;
}

export function classifyAwsAuthRefreshFailure(input: ClassifyAwsAuthRefreshFailureInput): boolean {
  if (typeof input.awsAuthRefresh !== "string" || input.awsAuthRefresh.trim().length === 0) {
    return false;
  }
  const target = `${input.message}\n${input.recentStderr ?? ""}`;
  return AWS_AUTH_EXPIRY_PATTERNS.some((pattern) => pattern.test(target));
}
