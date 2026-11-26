import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessEnvRecord } from "./paseo-env.js";
import { runGitCommand, type RunGitCommand } from "../utils/run-git-command.js";

const HEADLESS_DBUS_SESSION_BUS_ADDRESS = "unix:path=/dev/null";
const GIT_FETCH_AUTH_ERROR_PATTERN =
  /\b(terminal prompts disabled|could not read (?:username|password)|authentication failed|invalid username or (?:password|token)|invalid credentials|bad credentials|logon failed|access denied|permission denied|host key verification failed|too many authentication failures|agent refused operation|returned error: (?:401|403)|http (?:401|403)|401 unauthorized|403 forbidden)\b/i;

function extractGitFetchErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    const stderr =
      "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";
    return stderr ? `${error.message}\n${stderr}` : error.message;
  }
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string") {
    return error.stderr;
  }
  return String(error);
}

/**
 * Classifies git fetch errors that will keep failing without user intervention
 * (missing credentials, disabled prompts, bad tokens, SSH key/host rejections).
 */
export function isGitFetchAuthError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }
  return GIT_FETCH_AUTH_ERROR_PATTERN.test(extractGitFetchErrorText(error));
}

export interface BackgroundFetchEnvOptions {
  platform?: NodeJS.Platform;
  env?: ProcessEnvRecord;
  uid?: number | null;
  socketExists?: (socketPath: string) => boolean | Promise<boolean>;
}

/**
 * Builds the non-interactive subprocess environment overlay for background `git fetch`.
 * Keeps `credential.helper` active so stored credentials work, while blocking terminal,
 * SSH, and GUI prompts as well as Linux D-Bus autolaunch when no session bus exists.
 */
export async function buildBackgroundFetchEnvOverlay(
  options: BackgroundFetchEnvOptions = {},
): Promise<ProcessEnvRecord> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const overlay: ProcessEnvRecord = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GCM_INTERACTIVE: "0",
    SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
  };
  if (platform !== "linux") {
    return overlay;
  }

  const dbusAddress = env.DBUS_SESSION_BUS_ADDRESS?.trim() ?? "";
  const needsDbusFallback = dbusAddress === "" || dbusAddress.startsWith("autolaunch:");
  if (!needsDbusFallback) {
    return overlay;
  }

  const uid = options.uid === undefined ? (process.getuid?.() ?? null) : options.uid;
  const socketExists = options.socketExists ?? pathExists;
  const runtimeBusSocket = await findLinuxSessionBusSocket(env, uid, socketExists);
  overlay.DBUS_SESSION_BUS_ADDRESS = runtimeBusSocket
    ? `unix:path=${runtimeBusSocket}`
    : HEADLESS_DBUS_SESSION_BUS_ADDRESS;
  return overlay;
}

async function pathExists(socketPath: string): Promise<boolean> {
  try {
    await access(socketPath);
    return true;
  } catch {
    return false;
  }
}

async function findLinuxSessionBusSocket(
  env: ProcessEnvRecord,
  uid: number | null,
  socketExists: (socketPath: string) => boolean | Promise<boolean>,
): Promise<string | null> {
  const candidates = new Set<string>();
  const xdgRuntimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (xdgRuntimeDir) {
    candidates.add(join(xdgRuntimeDir, "bus"));
  }
  if (uid !== null && uid >= 0) {
    candidates.add(`/run/user/${uid}/bus`);
  }
  for (const candidate of candidates) {
    if (await socketExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export interface WorkspaceGitFetchResult {
  changes: WorkspaceGitRemoteRefChange[] | null;
  nonRemoteRefsChanged?: boolean;
  remoteRefs?: ReadonlySet<string>;
  error: unknown | null;
}

export interface WorkspaceGitFetchObserver {
  onRefSnapshot(phase: "before" | "after"): void;
}

export type WorkspaceGitRemoteRefChange =
  | { kind: "moved"; ref: string; beforeOid: string; afterOid: string }
  | { kind: "added"; ref: string; afterOid: string }
  | { kind: "deleted"; ref: string; beforeOid: string };

export async function fetchWorkspaceGitRemote(
  cwd: string,
  observer: WorkspaceGitFetchObserver,
  run: RunGitCommand = runGitCommand,
  envOptions?: BackgroundFetchEnvOptions,
): Promise<WorkspaceGitFetchResult> {
  let before: Map<string, string> | null = null;
  let after: Map<string, string> | null = null;
  let error: unknown | null = null;
  try {
    before = await readWorkspaceGitRefs(cwd, run);
    observer.onRefSnapshot("before");
  } catch (caught) {
    error = caught;
  }
  try {
    await run(["fetch", "origin", "--prune"], {
      cwd,
      // Terminal prompting and graphical credential prompting have separate controls.
      // Keep cached credentials available, but never start a login or D-Bus autolaunch from a passive fetch.
      envOverlay: await buildBackgroundFetchEnvOverlay(envOptions),
      timeout: 120_000,
    });
  } catch (caught) {
    error ??= caught;
  }
  try {
    after = await readWorkspaceGitRefs(cwd, run);
  } catch (caught) {
    error ??= caught;
  }
  if (!before || !after) {
    return { changes: null, error };
  }
  const diff = diffWorkspaceGitRefs(before, after);
  const result = {
    changes: diff.remoteChanges,
    nonRemoteRefsChanged: diff.nonRemoteRefsChanged,
    remoteRefs: collectWorkspaceGitRemoteRefs(after),
    error,
  } satisfies WorkspaceGitFetchResult;
  observer.onRefSnapshot("after");
  return result;
}

function collectWorkspaceGitRemoteRefs(refs: ReadonlyMap<string, string>): Set<string> {
  const remotePrefix = "refs/remotes/";
  return new Set(
    [...refs.keys()]
      .filter((ref) => ref.startsWith(remotePrefix))
      .map((ref) => ref.slice(remotePrefix.length)),
  );
}

async function readWorkspaceGitRefs(cwd: string, run: RunGitCommand): Promise<Map<string, string>> {
  const { stdout } = await run(["for-each-ref", "--format=%(refname)%00%(objectname)"], {
    cwd,
  });
  return parseWorkspaceGitRefs(stdout);
}

export function parseWorkspaceGitRefs(stdout: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [ref, objectId] = line.split("\0");
    if (ref?.startsWith("refs/") && objectId) {
      refs.set(ref, objectId);
    }
  }
  return refs;
}

export interface WorkspaceGitRefDiff {
  remoteChanges: WorkspaceGitRemoteRefChange[];
  nonRemoteRefsChanged: boolean;
}

export function diffWorkspaceGitRefs(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): WorkspaceGitRefDiff {
  const remotePrefix = "refs/remotes/";
  const beforeRemote = new Map<string, string>();
  const afterRemote = new Map<string, string>();
  let nonRemoteRefsChanged = false;
  for (const [ref, objectId] of before) {
    if (ref.startsWith(remotePrefix)) {
      beforeRemote.set(ref.slice(remotePrefix.length), objectId);
    } else if (after.get(ref) !== objectId) {
      nonRemoteRefsChanged = true;
    }
  }
  for (const [ref, objectId] of after) {
    if (ref.startsWith(remotePrefix)) {
      afterRemote.set(ref.slice(remotePrefix.length), objectId);
    } else if (!before.has(ref)) {
      nonRemoteRefsChanged = true;
    }
  }
  return {
    remoteChanges: diffWorkspaceGitRemoteRefs(beforeRemote, afterRemote),
    nonRemoteRefsChanged,
  };
}

export function diffWorkspaceGitRemoteRefs(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): WorkspaceGitRemoteRefChange[] {
  const changes: WorkspaceGitRemoteRefChange[] = [];
  for (const [ref, objectId] of after) {
    const beforeOid = before.get(ref);
    if (beforeOid === undefined) {
      changes.push({ kind: "added", ref, afterOid: objectId });
    } else if (beforeOid !== objectId) {
      changes.push({ kind: "moved", ref, beforeOid, afterOid: objectId });
    }
  }
  for (const [ref, beforeOid] of before) {
    if (!after.has(ref)) {
      changes.push({ kind: "deleted", ref, beforeOid });
    }
  }
  return changes;
}
