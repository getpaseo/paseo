import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderHistoryChild,
  type ProviderHistoryReadRequest,
  type ProviderHistoryReadResult,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderRegistration,
  type ProviderStatus,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { serveArgs } from "./options.js";
import { Usage } from "./usage.js";
import { execFile } from "node:child_process";
import { Catalog, launchKey } from "./catalog.js";
import { MspConnection } from "./connection.js";
import { MuseError, actionableError } from "./errors.js";
import { Sessions } from "./sessions.js";
import { Session } from "./session.js";
import {
  accountSchema,
  deltaSchema,
  itemNotificationSchema,
  pageSchema,
  persistenceSchema,
  childSessionSchema,
  sessionSchema,
  type WireItem,
} from "./wire.js";
import { Timeline } from "./timeline.js";

const capabilities = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.configure",
  "session.persistence",
  "permission",
  "session.list",
] as const;

interface HistoryChildReference {
  sessionId: string;
  toolCallId: string;
  description?: string;
}

interface HistoryReadNode {
  sessionId: string;
  parentSessionId: string | null;
  toolCallId?: string;
  title?: string;
  description?: string;
  cwd: string;
  items: ProviderHistoryReadResult["items"];
  children: HistoryReadNode[];
}

export function createMuseProvider(usage: Usage): ProviderRegistration {
  return {
    id: "muse",
    label: "Muse Code",
    icon: "icon.svg",
    command: ["muse"],
    async getCatalogCacheKey(options) {
      return launchKey(requireLaunch(options.launch));
    },
    async status({ launch }) {
      if (!launch)
        return { available: false, diagnostic: "Install Muse Code and ensure `muse` is on PATH." };
      usage.remember(launch);
      return status(launch);
    },
    async readSessionHistory(
      request: ProviderHistoryReadRequest,
    ): Promise<ProviderHistoryReadResult> {
      const saved = persistenceSchema.parse(request.persistence.data);
      const host = new MspConnection({
        launch: {
          ...requireLaunch(request.launch),
          env: { ...requireLaunch(request.launch).env, ...request.env },
        },
        cwd: request.cwd,
        serveArgs: [],
      });
      try {
        await host.initialize();
        const seen = new Set([saved.sessionId]);
        const root = await readHistoryNode(host, {
          sessionId: saved.sessionId,
          cwd: request.cwd,
          parentSessionId: null,
          seen,
          root: true,
        });
        const children = flattenHistoryChildren(root.children);
        return {
          items: root.items,
          ...(children.length > 0 ? { children } : {}),
          coverage: { kind: "complete" },
        };
      } finally {
        await host.close();
      }
    },
    async connect(request) {
      if (!request.versions.includes(1))
        throw new MuseError("protocol", "Provider protocol version 1 is required");
      usage.remember(requireLaunch(request.launch));
      return connect(
        requireLaunch(request.launch),
        negotiateProviderCapabilities(request.capabilities, capabilities),
        usage,
      );
    },
  };
}

async function readHistoryNode(
  host: MspConnection,
  options: {
    sessionId: string;
    cwd: string;
    parentSessionId: string | null;
    toolCallId?: string;
    description?: string;
    seen: Set<string>;
    root: boolean;
  },
): Promise<HistoryReadNode> {
  const response = options.root
    ? await host.request(
        "session/read",
        { sessionId: options.sessionId, excludeItems: false },
        sessionSchema,
      )
    : await host.request("session/read", { sessionId: options.sessionId }, childSessionSchema);
  const session = response.session;
  const sessionId = session.sessionId;
  options.seen.add(sessionId);
  const workspaceRoot = "workspaceRoot" in session ? session.workspaceRoot : null;
  const title = "title" in session ? session.title : undefined;
  const items: ProviderHistoryReadResult["items"] = [];
  const references = new Map<string, HistoryChildReference>();
  const timeline = new Timeline(host, sessionId, `history-read:${sessionId}`, (event) => {
    if (event.type !== "timeline.item") return;
    items.push({
      item: event.item,
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    });
    const reference = historyChildReference(event.item);
    if (reference && !options.seen.has(reference.sessionId)) {
      references.set(reference.sessionId, reference);
    }
  });
  const history = "history" in response ? response.history : undefined;
  await readHistoryItems(
    host,
    sessionId,
    timeline,
    options.root && history?.mode === "inline" ? history.items : undefined,
  );

  const children: HistoryReadNode[] = [];
  for (const reference of references.values()) {
    if (options.seen.has(reference.sessionId)) continue;
    options.seen.add(reference.sessionId);
    try {
      children.push(
        await readHistoryNode(host, {
          sessionId: reference.sessionId,
          cwd: workspaceRoot ?? options.cwd,
          parentSessionId: options.root ? null : sessionId,
          toolCallId: reference.toolCallId,
          description: reference.description,
          seen: options.seen,
          root: false,
        }),
      );
    } catch (error) {
      if (!isMissingSessionError(error)) throw error;
    }
  }
  return {
    sessionId,
    parentSessionId: options.parentSessionId,
    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
    ...(title ? { title } : {}),
    ...(options.description ? { description: options.description } : {}),
    cwd: workspaceRoot ?? options.cwd,
    items,
    children,
  };
}

async function readHistoryItems(
  host: MspConnection,
  sessionId: string,
  timeline: Timeline,
  inlineItems: readonly WireItem[] | null | undefined,
): Promise<void> {
  if (inlineItems) {
    for (const item of inlineItems) await timeline.fold(item);
    return;
  }
  let cursor: string | undefined;
  let nextCursor: string | null;
  do {
    const page = await host.request(
      "view/page",
      {
        sessionId,
        ...(cursor ? { cursor } : {}),
        direction: "forward",
        limit: 1000,
      },
      pageSchema,
    );
    await foldHistoryPage(timeline, page.events);
    nextCursor = page.nextCursor;
    cursor = nextCursor ?? undefined;
  } while (nextCursor !== null);
}

function flattenHistoryChildren(nodes: readonly HistoryReadNode[]): ProviderHistoryChild[] {
  return nodes.flatMap((node) => [
    {
      sessionId: node.sessionId,
      parentSessionId: node.parentSessionId,
      ...(node.toolCallId ? { toolCallId: node.toolCallId } : {}),
      ...(node.title ? { title: node.title } : {}),
      ...(node.description ? { description: node.description } : {}),
      cwd: node.cwd,
      items: node.items,
    },
    ...flattenHistoryChildren(node.children),
  ]);
}

function historyChildReference(item: ProviderTimelineItem): HistoryChildReference | undefined {
  if (item.type !== "tool_call" || item.detail.type !== "sub_agent") return undefined;
  const sessionId = item.detail.childSessionId;
  if (!sessionId) return undefined;
  return {
    sessionId,
    toolCallId: item.callId,
    ...(item.detail.description ? { description: item.detail.description } : {}),
  };
}

function isMissingSessionError(error: unknown): boolean {
  return error instanceof MuseError && error.kind === "sessionNotFound";
}

async function foldHistoryPage(
  timeline: Timeline,
  events: ReadonlyArray<{ method: string; params: Record<string, unknown> }>,
): Promise<void> {
  for (const event of events) {
    if (
      event.method === "item/started" ||
      event.method === "item/updated" ||
      event.method === "item/completed"
    ) {
      await timeline.fold(itemNotificationSchema.parse(event.params).item);
    } else if (event.method === "item/delta") {
      timeline.delta(deltaSchema.parse(event.params));
    }
  }
}

function requireLaunch(launch: ProviderLaunch | undefined): ProviderLaunch {
  if (!launch) throw new MuseError("missingLaunch", "Muse requires a daemon-resolved executable");
  return launch;
}
async function status(launch: ProviderLaunch): Promise<ProviderStatus> {
  let host: MspConnection | undefined;
  try {
    const versionText = await new Promise<string>((resolve, reject) => {
      execFile(
        launch.command,
        [...launch.args, "--version"],
        { env: launch.env, timeout: 3000, maxBuffer: 8192 },
        (error, stdout) => {
          if (error) reject(new MuseError("version", error.message));
          else resolve(stdout);
        },
      );
    });
    const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(versionText);
    if (!match) return { available: false, diagnostic: "Muse returned an unrecognized version." };
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major < 1 || (major === 1 && minor < 3))
      return { available: false, diagnostic: `Update Muse Code: found ${match[0]}, need ≥1.3.0` };
    host = new MspConnection({ launch, timeoutMs: 3000 });
    await host.initialize();
    const account = await host.request("account/read", {}, accountSchema);
    if (account.state === "loggedOut")
      return { available: false, diagnostic: "Run `muse login` or set META_API_KEY" };
    return { available: true };
  } catch (error) {
    return { available: false, diagnostic: actionableError(error, launch).message };
  } finally {
    await host?.close();
  }
}
function connect(
  launch: ProviderLaunch,
  negotiated: readonly string[],
  usage: Usage,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  const catalog = new Catalog();
  const imports = new Sessions();
  let closed = false;
  function emit(event: ProviderEvent): void {
    if (!closed) for (const listener of listeners) listener(event);
  }
  async function dispatch(input: ProviderInput): Promise<void> {
    if (input.type === "sessions") {
      emit({
        type: "sessions",
        requestId: input.requestId,
        sessions: await imports.list(launch, input),
      });
      return;
    }
    if (input.type === "catalog") {
      emit({ type: "catalog", requestId: input.requestId, catalog: await catalog.read(launch) });
      return;
    }
    if (input.type === "session.open") {
      if (sessions.has(input.sessionId))
        throw new MuseError("duplicateSession", "Muse session is already open");
      const session = new Session({
        id: input.sessionId,
        config: input.config,
        launch,
        emit,
        capabilities: negotiated,
        serveArgs: serveArgs(input.config.providerOptions),
      });
      sessions.set(input.sessionId, session);
      try {
        await session.open(input);
        usage.attach(
          input.sessionId,
          { ...launch, env: { ...launch.env, ...input.config.env } },
          () => session.readUsage(),
        );
      } catch (error) {
        sessions.delete(input.sessionId);
        await session.close();
        throw error;
      }
      return;
    }
    if (!("sessionId" in input))
      throw new MuseError("unsupported", `Muse does not support ${input.type}`);
    const session = sessions.get(input.sessionId);
    if (!session) throw new MuseError("unknownSession", "Muse session is not open");
    switch (input.type) {
      case "session.prompt":
        await session.prompt(input.prompt);
        return;
      case "session.configure":
        await session.configure(input.changes);
        break;
      case "session.permission":
        await session.answer(input.permissionId, input.response);
        return;
      case "session.interrupt":
        await session.interrupt();
        break;
      case "session.close":
        await session.close();
        sessions.delete(input.sessionId);
        usage.detach(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        break;
      default:
        throw new MuseError("unsupported", `Muse does not support ${input.type}`);
    }
    if ("requestId" in input) emit({ type: "request.completed", requestId: input.requestId });
  }
  function failed(input: ProviderInput, failure: unknown): void {
    const error = actionableError(failure, launch);
    if (input.type === "session.prompt")
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error },
      });
    else if ("requestId" in input)
      emit({ type: "request.failed", requestId: input.requestId, error });
    else if ("sessionId" in input)
      emit({ type: "session.runtime_failed", sessionId: input.sessionId, error });
  }
  return {
    version: 1,
    capabilities: negotiated,
    async send(input) {
      if (closed) throw new MuseError("closed", "Muse connection is closed");
      requireProviderCapabilities(negotiated, input);
      queueMicrotask(() => {
        if (!closed) void dispatch(input).catch((error: unknown) => failed(input, error));
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([
        catalog.close(),
        imports.close(),
        ...[...sessions.values()].map((session) => session.close()),
      ]);
      for (const id of sessions.keys()) usage.detach(id);
      sessions.clear();
      listeners.clear();
    },
  };
}
