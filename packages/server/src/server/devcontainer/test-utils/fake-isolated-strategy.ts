import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import type {
  LaunchSpawnOptions,
  ContainerExecSpec,
  ProcessLaunchStrategy,
  ResolvedCommand,
} from "../launch-strategy.js";

/**
 * An isolated launch strategy that runs its commands on the host.
 *
 * Container support is mostly a question of *which* environment a provider
 * addresses: where it spawns the agent, where it writes the files the agent
 * opens, where it looks for transcripts. That question is answerable without a
 * container — this strategy reports `isIsolated`, maps paths the way a real
 * container does, and executes the resulting POSIX commands locally. Tests get
 * the container code path, the real `sh` semantics behind it, and none of the
 * runtime.
 *
 * What it deliberately does not prove is that a real image behaves this way;
 * that belongs to the docker-gated tests in container-management.test.ts.
 */
export class FakeIsolatedLaunchStrategy implements ProcessLaunchStrategy {
  readonly isIsolated = true;
  /** Every command name asked for, in order — the pre-flight PATH checks. */
  readonly resolvedExecutables: string[] = [];
  /** Everything run through the strategy, to tell an exec from a node:fs call. */
  readonly recordedSpawns: Array<{ command: string; args: string[] }> = [];

  private readonly hostWorkspaceFolder: string;
  private readonly remoteWorkspaceFolder: string;
  private readonly missingExecutables: ReadonlySet<string>;
  private readonly environmentEnv: Record<string, string>;

  constructor(options: {
    hostWorkspaceFolder: string;
    remoteWorkspaceFolder: string;
    /** Commands the environment does not have, to exercise the failure path. */
    missingExecutables?: readonly string[];
    /** The environment's own variables — a HOME of its own, most usefully. */
    environmentEnv?: Record<string, string>;
  }) {
    this.hostWorkspaceFolder = options.hostWorkspaceFolder;
    this.remoteWorkspaceFolder = options.remoteWorkspaceFolder;
    this.missingExecutables = new Set(options.missingExecutables ?? []);
    this.environmentEnv = options.environmentEnv ?? {};
  }

  spawn(command: string, args: string[], options?: LaunchSpawnOptions): ChildProcess {
    this.recordedSpawns.push({ command, args });
    return spawn(command, args, {
      // Mapped paths are what `resolveCwd` reports to callers; the command
      // itself still has to run in a directory that exists on this machine.
      cwd: options?.cwd ?? this.hostWorkspaceFolder,
      env: {
        ...process.env,
        ...this.environmentEnv,
        ...stripUndefined(options?.envOverlay),
      },
      stdio: options?.stdio ?? ["pipe", "pipe", "pipe"],
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  wrapCommand(command: string, args: string[]): ResolvedCommand {
    // Nothing to wrap: the fake executes directly, and terminals are not what
    // it exists to exercise.
    return { command, args };
  }

  resolveCwd(hostCwd: string): string {
    const relative = path.relative(this.hostWorkspaceFolder, hostCwd);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return hostCwd;
    }
    return relative
      ? path.posix.join(this.remoteWorkspaceFolder, relative)
      : this.remoteWorkspaceFolder;
  }

  resolveDaemonUrl(url: string): string {
    return url;
  }

  async resolveExecutable(command: string): Promise<string> {
    this.resolvedExecutables.push(command);
    if (this.missingExecutables.has(command)) {
      throw new Error(`'${command}' is not installed in this environment`);
    }
    return command;
  }

  async resolveDefaultShell(): Promise<string | null> {
    return "/bin/sh";
  }

  serialize(): ContainerExecSpec | null {
    return null;
  }
}

function stripUndefined(
  overlay: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const entries = Object.entries(overlay ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return Object.fromEntries(entries);
}
