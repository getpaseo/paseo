import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import {
  findAgentEnvironmentPreset,
  type AgentEnvironmentEntry,
  type AgentEnvironmentFormat,
  type AgentEnvironmentPreset,
} from "@getpaseo/protocol/agent-environment";
import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { execCommand } from "../utils/spawn.js";
import { createExternalProcessEnv, type ProcessEnvRecord } from "./paseo-env.js";

export const DEFAULT_AGENT_ENVIRONMENT_TIMEOUT_MS = 30_000;

export interface AgentEnvironmentConfig {
  entries: readonly AgentEnvironmentEntry[];
  timeoutMs: number;
}

export interface AgentEnvironmentCommandResult {
  stdout: string;
  stderr: string;
}

export interface AgentEnvironmentCommandRunnerInput {
  command: string;
  args: string[];
  cwd: string;
  env: ProcessEnvRecord;
  timeoutMs: number;
}

export type AgentEnvironmentCommandRunner = (
  input: AgentEnvironmentCommandRunnerInput,
) => Promise<AgentEnvironmentCommandResult>;

export interface AgentEnvironmentResolverOptions {
  /** Read per launch so Settings edits apply without restarting the daemon. */
  getConfig: () => AgentEnvironmentConfig;
  logger: Logger;
  /** The environment agents would launch with if no entry ran. */
  baseEnv?: ProcessEnvRecord;
  run?: AgentEnvironmentCommandRunner;
  resolveBinary?: (name: string) => Promise<string | null>;
  fileExists?: (path: string) => boolean;
}

interface ResolvedStep {
  command: string[];
  format: AgentEnvironmentFormat;
  timeoutMs: number;
}

const EnvDiffSchema = z.record(z.string(), z.union([z.string(), z.null()]));

const ANSI_SGR_PATTERN = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

/**
 * Walks from `cwd` to the filesystem root looking for any of `markers`, matching
 * how the tools themselves find their config.
 */
export function hasMarkerAtOrAbove(
  cwd: string,
  markers: readonly string[],
  exists: (path: string) => boolean,
): boolean {
  let directory = resolve(cwd);
  for (;;) {
    if (markers.some((marker) => exists(join(directory, marker)))) {
      return true;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return false;
    }
    directory = parent;
  }
}

async function runAgentEnvironmentCommand(
  input: AgentEnvironmentCommandRunnerInput,
): Promise<AgentEnvironmentCommandResult> {
  return await execCommand(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    timeout: input.timeoutMs,
    shell: false,
  });
}

function firstMessageLine(stderr: string): string {
  const stripped = stderr.replace(ANSI_SGR_PATTERN, "");
  return (
    stripped
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function readStderr(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  return typeof stderr === "string" ? stderr : "";
}

export function parseEnvDiff(stdout: string): ProcessEnvRecord | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const parsed = EnvDiffSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }

  const diff: ProcessEnvRecord = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    diff[key] = value ?? undefined;
  }
  return diff;
}

export function parseEnvSnapshot(stdout: string): Record<string, string> | null {
  const snapshot: Record<string, string> = {};
  for (const record of stdout.split("\0")) {
    if (!record) {
      continue;
    }
    const separator = record.indexOf("=");
    if (separator <= 0) {
      return null;
    }
    snapshot[record.slice(0, separator)] = record.slice(separator + 1);
  }
  return snapshot;
}

/**
 * Turns a complete environment back into an overlay on `baseEnv`, so a snapshot
 * composes with the rest of the launch environment the same way a diff does.
 */
export function diffEnvSnapshot(
  baseEnv: ProcessEnvRecord,
  snapshot: Record<string, string>,
): ProcessEnvRecord {
  const diff: ProcessEnvRecord = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (baseEnv[key] !== value) {
      diff[key] = value;
    }
  }
  for (const key of Object.keys(baseEnv)) {
    if (!(key in snapshot)) {
      diff[key] = undefined;
    }
  }
  return diff;
}

/**
 * Builds the launch environment overlay for a directory by running the
 * configured entries there, in order, each seeing what the ones before it
 * produced.
 *
 * Never throws. A preset whose tool is absent is skipped silently — that is the
 * whole point of shipping direnv enabled by default. A configured command that
 * fails, times out, or prints the wrong shape is skipped with a warning. Either
 * way the agent still starts.
 */
export function createAgentEnvironmentResolver(
  options: AgentEnvironmentResolverOptions,
): (cwd: string) => Promise<ProcessEnvRecord> {
  const logger = options.logger.child({ module: "agent-environment" });
  const baseEnv = options.baseEnv ?? process.env;
  const run = options.run ?? runAgentEnvironmentCommand;
  const resolveBinary = options.resolveBinary ?? ((name) => findExecutable(name));
  const fileExists = options.fileExists ?? existsSync;

  // PATH does not change under a running daemon, so a preset's binary is looked
  // up once. Marker files are checked per launch: a directory can gain an
  // .envrc while the daemon is up.
  const binaryLookups = new Map<string, Promise<string | null>>();
  const announced = new Set<string>();

  async function lookupBinary(name: string): Promise<string | null> {
    let lookup = binaryLookups.get(name);
    if (!lookup) {
      // Evict a failed lookup rather than caching it: a cached rejection would
      // make one transient PATH error skip this preset for the daemon's life.
      lookup = resolveBinary(name).catch((error) => {
        binaryLookups.delete(name);
        throw error;
      });
      binaryLookups.set(name, lookup);
    }
    return await lookup;
  }

  async function presetApplies(preset: AgentEnvironmentPreset, cwd: string): Promise<boolean> {
    if (!(await lookupBinary(preset.binary))) {
      return false;
    }
    return hasMarkerAtOrAbove(cwd, preset.markers, fileExists);
  }

  async function resolveStep(
    entry: AgentEnvironmentEntry,
    cwd: string,
    defaultTimeoutMs: number,
  ): Promise<ResolvedStep | null> {
    const timeoutMs = entry.timeoutMs ?? defaultTimeoutMs;

    if (entry.kind === "command") {
      return { command: entry.command, format: entry.format ?? "json", timeoutMs };
    }

    const preset = findAgentEnvironmentPreset(entry.preset);
    if (!preset) {
      logger.warn({ preset: entry.preset }, "Unknown agent environment preset; skipping it");
      return null;
    }
    if (!(await presetApplies(preset, cwd))) {
      return null;
    }

    const key = `${preset.id}:${cwd}`;
    if (!announced.has(key)) {
      announced.add(key);
      logger.info({ cwd, preset: preset.id }, "Building agent environment with a preset");
    }
    return { command: preset.command, format: preset.format, timeoutMs };
  }

  return async function resolveAgentEnvironment(cwd: string): Promise<ProcessEnvRecord> {
    const { entries, timeoutMs: defaultTimeoutMs } = options.getConfig();
    let overlay: ProcessEnvRecord = {};

    for (const entry of entries) {
      // Detection and execution share one recovery boundary. A PATH lookup or a
      // stat that throws must skip the entry like any other failure, never
      // reject: this runs on create, resume, restart, and reload, so an escaping
      // error would stop the agent from launching at all.
      let command = entry.kind === "command" ? entry.command[0] : entry.preset;
      try {
        const step = await resolveStep(entry, cwd, defaultTimeoutMs);
        if (!step) {
          continue;
        }

        const [stepCommand, ...args] = step.command;
        command = stepCommand;
        const result = await run({
          command: stepCommand,
          args,
          cwd,
          env: createExternalProcessEnv(baseEnv, overlay),
          timeoutMs: step.timeoutMs,
        });

        if (step.format === "json") {
          const diff = parseEnvDiff(result.stdout);
          if (!diff) {
            logger.warn(
              { cwd, command: stepCommand },
              "Agent environment command did not print a JSON env diff",
            );
            continue;
          }
          Object.assign(overlay, diff);
        } else {
          const snapshot = parseEnvSnapshot(result.stdout);
          if (!snapshot) {
            logger.warn(
              { cwd, command: stepCommand },
              "Agent environment command did not print NUL-separated KEY=VALUE records",
            );
            continue;
          }
          overlay = diffEnvSnapshot(baseEnv, snapshot);
        }
      } catch (error) {
        logger.warn(
          { cwd, command, stderr: firstMessageLine(readStderr(error)) || undefined, err: error },
          "Agent environment entry failed; skipping it",
        );
      }
    }

    if (Object.keys(overlay).length > 0) {
      logger.debug({ cwd, keys: Object.keys(overlay).sort() }, "Resolved agent environment");
    }
    return overlay;
  };
}
