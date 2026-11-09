import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderRegistration,
  type ProviderSessionSummary,
} from "@getpaseo/plugin/server/provider";
import { getCatalog, getStatus } from "./internal/catalog.js";
import { probe } from "./internal/process.js";
import { Session } from "./internal/session.js";
import { AntigravityError } from "./internal/wire.js";

interface SessionListOptions {
  homeDir: string;
  cwd?: string;
  query?: string;
  limit?: number;
}

const sessionSummaryRowSchema = z.array(
  z.object({
    conversationId: z.string(),
    cwd: z.string(),
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  }),
);

const capabilities = [
  "prompt.message",
  "prompt.image",
  "prompt.command",
  "prompt.steer",
  "session.configure",
  "session.persistence",
  "session.list",
] as const;

async function listAntigravitySessions(
  input: SessionListOptions,
): Promise<ProviderSessionSummary[]> {
  const dbPath = path.join(
    input.homeDir,
    ".gemini",
    "antigravity-cli",
    "conversation_summaries.db",
  );
  if (!fs.existsSync(dbPath)) return [];
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const script = `
import json, os, sqlite3, sys
db_path, cwd_filter, query_filter, limit_str = sys.argv[1], sys.argv[2], sys.argv[3].lower(), int(sys.argv[4])
conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
rows = conn.execute(
    "SELECT conversation_id, title, preview, last_modified_time, workspace_uris "
    "FROM conversation_summaries WHERE parent_conversation_id = '' "
    "ORDER BY last_modified_time DESC LIMIT 500"
).fetchall()
out = []
for cid, title, preview, updated, uris_json in rows:
    try:
        uris = json.loads(uris_json) if uris_json else []
    except Exception:
        uris = []
    cwd = ""
    for u in uris:
        if isinstance(u, str) and u.startswith("file://"):
            cwd = u[len("file://"):]
            break
    if not cwd:
        cwd = os.path.expanduser("~")
    if cwd_filter and cwd != cwd_filter:
        continue
    display_title = (title or preview or cid).strip().splitlines()[0][:120]
    if query_filter and query_filter not in display_title.lower() and query_filter not in (preview or "").lower():
        continue
    out.append({
        "conversationId": cid,
        "cwd": cwd,
        "title": display_title,
        "description": (preview or "").strip()[:200] or None,
        "updatedAt": updated.replace(" ", "T") if updated else None,
    })
    if len(out) >= limit_str:
        break
print(json.dumps(out))
`;
  try {
    const stdout = await probe({
      launch: {
        command: "python3",
        args: ["-c", script, dbPath, input.cwd ?? "", input.query ?? "", String(limit)],
        env: {},
      },
    });
    const parsed = sessionSummaryRowSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) return [];
    return parsed.data.map((item) => ({
      persistence: {
        version: 1,
        data: { conversationId: item.conversationId },
      },
      cwd: item.cwd,
      title: item.title || undefined,
      description: item.description || undefined,
      updatedAt: item.updatedAt || undefined,
    }));
  } catch {
    return [];
  }
}

export function createAntigravityProvider(): ProviderRegistration {
  return {
    id: "antigravity",
    label: "Antigravity",
    icon: "icon.svg",
    command: ["agy"],
    description: "Antigravity CLI on your host",
    async status({ launch }) {
      if (!launch)
        return {
          available: false,
          diagnostic: "agy not found on PATH. Install Antigravity, then run `agy` and sign in.",
        };
      return getStatus(launch);
    },
    async getCatalogCacheKey({ launch }) {
      if (!launch) return undefined;
      const env = Object.entries(launch.env).sort(([left], [right]) => left.localeCompare(right));
      return createHash("sha256")
        .update(JSON.stringify([launch.command, launch.args, env]))
        .digest("hex");
    },
    async connect(request) {
      if (!request.versions.includes(1))
        throw new AntigravityError("Provider protocol version 1 is required");
      if (!request.launch)
        throw new AntigravityError("The daemon must supply the Antigravity launch");
      const negotiated = negotiateProviderCapabilities(request.capabilities, capabilities);
      return createConnection(request.launch, negotiated);
    },
  };
}

function createConnection(
  launch: ProviderLaunch,
  negotiated: readonly string[],
): ProviderConnection {
  const sessions = new Map<string, Session>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  let discovered: ProviderCatalog | null = null;
  let closed = false;
  let pending = Promise.resolve();

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }
  function catalog(): ProviderCatalog {
    if (discovered === null)
      throw new AntigravityError("Antigravity catalog has not been discovered");
    return discovered;
  }
  function session(id: string): Session {
    const found = sessions.get(id);
    if (!found) throw new AntigravityError(`Unknown Antigravity session: ${id}`);
    return found;
  }
  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        discovered = await getCatalog(launch, input.cwd);
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: catalog(),
        });
        return;
      case "sessions": {
        const homeDir = launch.env.HOME ?? process.env.HOME ?? os.homedir();
        const list = await listAntigravitySessions({
          homeDir,
          cwd: input.cwd,
          query: input.query,
          limit: input.limit,
        });
        emit({
          type: "sessions",
          requestId: input.requestId,
          sessions: list,
        });
        return;
      }
      case "session.open": {
        if (sessions.has(input.sessionId))
          throw new AntigravityError(`Session already exists: ${input.sessionId}`);
        if (discovered === null) discovered = await getCatalog(launch, input.config.cwd);
        const opened = new Session({
          id: input.sessionId,
          config: input.config,
          persistence: input.persistence,
          history: input.history,
          catalog,
          launch,
          emit,
        });
        sessions.set(input.sessionId, opened);
        try {
          await opened.open(input.requestId, negotiated);
        } catch (error) {
          sessions.delete(input.sessionId);
          await opened.close();
          throw error;
        }
        return;
      }
      case "session.prompt":
        await session(input.sessionId).prompt(input.prompt);
        return;
      case "session.configure":
        session(input.sessionId).configure(input.changes);
        break;
      case "session.interrupt":
        await session(input.sessionId).interrupt();
        break;
      case "session.close": {
        await session(input.sessionId).close();
        sessions.delete(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        break;
      }
      default:
        throw new AntigravityError(`Unsupported Antigravity operation: ${input.type}`);
    }
    emit({ type: "request.completed", requestId: input.requestId });
  }
  function failed(input: ProviderInput, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof AntigravityError ? error.code : "ANTIGRAVITY_ERROR";
    if (input.type === "session.prompt")
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message, code } },
      });
    else if ("requestId" in input)
      emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message, code },
      });
  }
  return {
    version: 1,
    capabilities: negotiated,
    async send(input) {
      if (closed) throw new AntigravityError("Antigravity connection is closed");
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
    },
  };
}
