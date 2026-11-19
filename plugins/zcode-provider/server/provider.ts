import { access, constants } from "node:fs/promises";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderPermissionRequest,
  type ProviderPersistence,
  type ProviderRegistration,
  type ProviderSessionSummary,
  type ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { ZCODE_CAPABILITIES } from "./capabilities.js";
import {
  ZCODE_NOT_FOUND_DIAGNOSTIC,
  defaultDesktopRoots,
  listDesktopAppRoots,
  providerConfigEnv,
  resolveZCodeLaunch,
  type ZCodeLaunch,
} from "./internal/binary.js";
import { mapCatalog } from "./internal/catalog.js";
import { createLegacyTransport } from "./internal/legacy-transport.js";
import { startZCodeProcess, type ZCodeProcess } from "./internal/process.js";
import { ZCodeSession } from "./internal/session.js";
import { mapPermissionRequest, permissionResponseFor } from "./internal/signals.js";
import type { ZCodeTransport } from "./internal/transport.js";
import { ZCodeError } from "./internal/wire.js";

/** Whether the path names an existing file. */
async function isFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function createZCodeProvider(): ProviderRegistration {
  return {
    id: "zcode",
    label: "ZCode",
    description: "ZCode agent on your host, driven over its app-server protocol",
    icon: "icon.svg",
    async resolveCommand() {
      return resolveCommand();
    },
    async status({ launch }): Promise<ProviderStatus> {
      if (!launch) {
        return { available: false, diagnostic: ZCODE_NOT_FOUND_DIAGNOSTIC };
      }
      return { available: true, diagnostic: `ZCode resolved to ${launch.command}` };
    },
    async getCatalogCacheKey(options) {
      if (!options.launch) return undefined;
      // The catalog comes from a ZCode session, so it depends on the runtime
      // and on the workspace whose settings ZCode projects the options from.
      const cwd = options.scope === "workspace" ? options.cwd : "";
      return `${options.launch.command}${cwd}`;
    },
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new ZCodeError("Provider protocol version 1 is required");
      }
      if (!request.launch) {
        throw new ZCodeError("The daemon must supply the ZCode launch");
      }
      const negotiated = negotiateProviderCapabilities(request.capabilities, ZCODE_CAPABILITIES);
      return createConnection(request.launch, negotiated);
    },
  };
}

/**
 * The daemon probes availability whenever it lists providers and before every
 * connection. Resolution scans PATH and the desktop app roots, so the result is
 * memoized briefly instead of repeating the scan on every probe.
 */
const RESOLUTION_CACHE_MS = 5_000;
let cached: { at: number; value: ZCodeLaunch | undefined } | undefined;

async function resolveLaunch(): Promise<ZCodeLaunch | undefined> {
  const now = Date.now();
  if (cached && now - cached.at < RESOLUTION_CACHE_MS) return cached.value;
  const value = await resolveZCodeLaunch({
    pathEntries: (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":"),
    env: process.env,
    desktopRoots: await listDesktopAppRoots(defaultDesktopRoots()),
  });
  cached = { at: now, value };
  return value;
}

/**
 * The desktop app's bundled runtime needs two environment variables the daemon
 * does not know about: `ELECTRON_RUN_AS_NODE`, so the Electron binary runs the
 * bundle as plain Node, and the path of the built-in provider config, without
 * which the app-server exits before it answers anything.
 *
 * The `resolveCommand` hook carries the command and its arguments only, so the
 * launch environment is exposed here for the connection layer to merge into the
 * child process environment.
 */
export function zcodeLaunchEnv(): Readonly<Record<string, string>> {
  return cached?.value?.env ?? {};
}

async function resolveCommand(): Promise<readonly [string, ...string[]] | undefined> {
  const launch = await resolveLaunch();
  return launch ? ([launch.command, ...launch.args] as const) : undefined;
}

/**
 * The ZCode session id the persistence handle carries.
 */
function nativeSessionIdOf(persistence: ProviderPersistence): string {
  const data = persistence.data as { nativeSessionId?: string };
  if (!data?.nativeSessionId) {
    throw new ZCodeError("The persistence handle carries no ZCode session id");
  }
  return data.nativeSessionId;
}

/**
 * Converts a ZCode session entry into Paseo's session summary.
 *
 * ZCode nests the workspace and reports the update time as a millisecond
 * number, while the summary wants a path and a string.
 */
function toSessionSummary(entry: unknown): ProviderSessionSummary {
  const record = entry as {
    sessionId?: string;
    title?: string;
    workspace?: { workspacePath?: string; workspaceKey?: string };
    updatedAt?: number;
  };
  return {
    persistence: {
      version: 1,
      data: { nativeSessionId: record.sessionId ?? "" },
    },
    cwd: record.workspace?.workspacePath ?? "",
    ...(record.title ? { title: record.title } : {}),
    ...(record.updatedAt ? { updatedAt: new Date(record.updatedAt).toISOString() } : {}),
  };
}

function createConnection(
  launch: ProviderLaunch,
  negotiated: readonly string[],
): ProviderConnection {
  const sessions = new Map<string, ZCodeSession>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  let closed = false;
  let pending = Promise.resolve();
  let transport: ZCodeTransport | undefined;
  let child: ZCodeProcess | undefined;

  /**
   * ZCode's session id to the Paseo session id it belongs to. The index
   * outlives a closed session, because an agent is closed before it is
   * archived and the archive input carries only the ZCode id.
   */
  const nativeIndex = new Map<string, string>();

  /**
   * ZCode asks the host for permission with a reverse request and waits for
   * that request's answer. The answer comes from the user, so the request is
   * held here until the daemon sends the decision back.
   */
  const pendingPermissions = new Map<
    string,
    { request: ProviderPermissionRequest; resolve: (value: unknown) => void }
  >();

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }

  function session(id: string): ZCodeSession {
    const found = sessions.get(id);
    if (!found) throw new ZCodeError(`Unknown ZCode session: ${id}`);
    return found;
  }

  function paseoIdForNative(nativeId: string): string {
    const paseoId = nativeIndex.get(nativeId);
    if (!paseoId) throw new ZCodeError(`Unknown ZCode session: ${nativeId}`);
    return paseoId;
  }

  /**
   * The environment the child process runs with.
   *
   * The daemon owns the environment and replaces the one the discovery
   * found, so the values the bundled runtime needs are restored here: the
   * Electron runtime flag and the path of the built-in provider config.
   *
   * Both come from the runtime in the launch's own arguments. The daemon
   * builds the launch from the plugin's resolution, so the bundle is still
   * the first argument, and a user command override points at a different
   * runtime that needs neither.
   */
  async function childEnv(): Promise<Record<string, string>> {
    const env = { ...launch.env };
    const runtime = launch.args[0];
    if (!runtime?.endsWith(".cjs") && !runtime?.endsWith(".js")) return env;
    env["ELECTRON_RUN_AS_NODE"] = "1";
    Object.assign(env, await providerConfigEnv(runtime, isFile));
    return env;
  }

  async function ensureTransportProcess(): Promise<ZCodeProcess> {
    if (!child) {
      child = startZCodeProcess({
        command: launch.command,
        args: launch.args,
        env: await childEnv(),
      });
      transport = createLegacyTransport(child);
      transport.onRequest(async (request) => {
        if (request.method !== "interaction/requestPermission") {
          throw new Error(`Unsupported ZCode request: ${request.method}`);
        }
        const params = (request.params ?? {}) as Record<string, unknown>;
        const permission = mapPermissionRequest(params);
        const nativeSessionId = typeof params.sessionId === "string" ? params.sessionId : "";
        const answer = new Promise<unknown>((resolve) => {
          pendingPermissions.set(permission.id, { request: permission, resolve });
        });
        emit({
          type: "session.permission",
          sessionId: nativeIndex.get(nativeSessionId) ?? nativeSessionId,
          request: permission,
        });
        return answer;
      });
      // The child reports its own death through the ready promise while it
      // starts up. Once it is ready that promise stays resolved, so a later
      // crash has to be watched on its own: every session the child hosted has
      // to learn about it, or the daemon waits for a reply that never arrives.
      void child.ready.catch((error) => {
        onProcessExit(error instanceof Error ? error : new Error(String(error)));
      });
      void child.exited.catch((error: unknown) => {
        onProcessExit(error instanceof Error ? error : new Error(String(error)));
      });
    }
    return child;
  }

  async function ensureTransport(): Promise<ZCodeTransport> {
    await ensureTransportProcess();
    return transport!;
  }

  /**
   * Every session the dead child hosted reports the failure and closes.
   */
  function onProcessExit(error: Error): void {
    for (const opened of sessions.values()) {
      emit({
        type: "session.runtime_failed",
        sessionId: opened.id,
        error: { message: error.message, code: "ZCODE_EXITED" },
      });
      emit({ type: "session.closed", sessionId: opened.id, error: { message: error.message } });
    }
    sessions.clear();
  }

  /**
   * ZCode projects its model, mode and thought-level options from session
   * settings, and `session/read` requires a session id. The provider opens a
   * session for the request, reads the snapshot, and closes it again.
   */
  async function readCatalog(cwd: string | undefined): Promise<ProviderCatalog> {
    const workspacePath = cwd ?? process.cwd();
    const handle = await (
      await ensureTransport()
    ).createSession({
      workspace: { workspacePath, workspaceKey: workspacePath },
    });
    try {
      const snapshot = await (
        await ensureTransport()
      ).readSnapshot({ sessionId: handle.sessionId });
      return mapCatalog(snapshot);
    } finally {
      await (await ensureTransport()).archive({ sessionId: handle.sessionId });
    }
  }

  /**
   * Opens a session, restoring it when the host carries a persistence handle.
   */
  async function openSession(
    input: Extract<ProviderInput, { type: "session.open" }>,
  ): Promise<void> {
    if (sessions.has(input.sessionId)) {
      throw new ZCodeError(`Session already exists: ${input.sessionId}`);
    }
    const opened = new ZCodeSession({
      id: input.sessionId,
      transport: await ensureTransport(),
      emit,
    });
    sessions.set(input.sessionId, opened);
    try {
      const settings = {
        ...(input.config.model ? { model: input.config.model } : {}),
        ...(input.config.mode ? { mode: input.config.mode } : {}),
        ...(input.config.thinkingOption ? { thinkingOption: input.config.thinkingOption } : {}),
      };
      const native = input.persistence
        ? await opened.resume({
            cwd: input.config.cwd,
            nativeSessionId: nativeSessionIdOf(input.persistence),
            settings,
          })
        : await opened.open({ cwd: input.config.cwd, settings });
      nativeIndex.set(native, input.sessionId);
    } catch (error) {
      sessions.delete(input.sessionId);
      throw error;
    }
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog": {
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: await readCatalog(input.cwd),
        });
        return;
      }
      case "sessions": {
        const list = await (
          await ensureTransport()
        ).listSessions({
          ...(input.cwd
            ? { workspace: { workspacePath: input.cwd, workspaceKey: input.cwd } }
            : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        });
        emit({
          type: "sessions",
          requestId: input.requestId,
          sessions: list.map((entry) => toSessionSummary(entry)),
        });
        return;
      }
      case "session.open": {
        await openSession(input);
        return;
      }
      case "session.prompt": {
        await session(input.sessionId).prompt(input.prompt);
        return;
      }
      case "session.configure": {
        await session(input.sessionId).configure(input.changes);
        break;
      }
      case "session.interrupt": {
        await session(input.sessionId).interrupt();
        break;
      }
      case "session.permission": {
        const request = pendingPermissions.get(input.permissionId);
        if (!request) throw new ZCodeError(`Unknown permission request: ${input.permissionId}`);
        pendingPermissions.delete(input.permissionId);
        request.resolve(permissionResponseFor(request.request, input.response));
        emit({
          type: "session.permission_resolved",
          sessionId: input.sessionId,
          permissionId: input.permissionId,
        });
        return;
      }
      case "session.archive": {
        const nativeId = nativeSessionIdOf(input.persistence);
        await (await ensureTransport()).archive({ sessionId: nativeId });
        emit({
          type: "session.persistence",
          sessionId: paseoIdForNative(nativeId),
          persistence: input.persistence,
        });
        break;
      }
      case "session.unarchive": {
        const nativeId = nativeSessionIdOf(input.persistence);
        await (await ensureTransport()).resumeSession({ sessionId: nativeId });
        break;
      }
      case "session.can_stop_runtime": {
        // The daemon already refuses the probe while a turn is active or a
        // prompt is pending. The legacy transport has no background work of
        // its own: it runs no subagents and no background commands, so
        // releasing the runtime loses nothing.
        emit({
          type: "session.can_stop_runtime",
          requestId: input.requestId,
          sessionId: input.sessionId,
          canStop: true,
        });
        return;
      }
      case "session.close": {
        await session(input.sessionId).close();
        sessions.delete(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        break;
      }
      default:
        throw new ZCodeError(`Unsupported ZCode operation: ${input.type}`);
    }
    // The host waits for this reply before it treats the request as done.
    emit({ type: "request.completed", requestId: input.requestId });
  }

  function failed(input: ProviderInput, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ZCodeError ? error.code : "ZCODE_ERROR";
    if (input.type === "session.prompt") {
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message, code } },
      });
      return;
    }
    if ("requestId" in input) {
      emit({ type: "request.failed", requestId: input.requestId, error: { message, code } });
    }
  }

  return {
    version: 1,
    capabilities: negotiated,
    async send(input) {
      if (closed) throw new ZCodeError("ZCode connection is closed");
      requireProviderCapabilities(negotiated, input);
      pending = pending
        .then(async () => {
          if (!closed) await dispatch(input);
          return undefined;
        })
        .catch((error) => failed(input, error));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      await pending;
      await Promise.all([...sessions.values()].map((opened) => opened.close()));
      sessions.clear();
      listeners.clear();
      await transport?.close();
      await child?.exit();
    },
  };
}
