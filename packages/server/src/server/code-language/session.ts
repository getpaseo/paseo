import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CancellationTokenSource, type CancellationToken } from "vscode-languageserver-protocol";
import {
  isTypeScriptFile,
  type CodeDocument,
  type CodeQuery,
  type CodeQueryResult,
  type CodeLocation,
} from "@getpaseo/protocol/code-language";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { TypeScriptProcess } from "./process.js";
import { contentIdentity, languageText } from "./content.js";

interface LanguageResponse {
  generation: string;
  result: CodeQueryResult;
}
interface Document {
  content: string;
  version: number;
}
type LanguageProcess = Pick<TypeScriptProcess, "ready" | "sync" | "close" | "query" | "stop">;
interface LanguageRuntime {
  createProcess(cwd: string, logger: Logger, onExit: () => void): LanguageProcess;
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
const defaultRuntime: LanguageRuntime = {
  createProcess: (cwd, logger, onExit) => new TypeScriptProcess(cwd, logger, onExit),
  now: Date.now,
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
const FAILURE_RETRY_MS = 5000;

interface Workspace {
  cwd: string;
  generation: string;
  documents: Map<string, Document>;
  process: LanguageProcess | null;
  starting: Promise<LanguageProcess> | null;
  retryAt: number;
  idle: ReturnType<typeof setTimeout> | null;
  sequence: number;
  revision: number;
  readers: Map<string, number>;
}
type LanguageRequest = Extract<SessionInboundMessage, { type: `code.language.${string}` }>;

export class CodeLanguageSession {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly pending = new Map<string, CancellationTokenSource>();
  private disposed = false;
  constructor(
    private readonly logger: Logger,
    private readonly runtime: LanguageRuntime = defaultRuntime,
  ) {}

  async handle(
    request: LanguageRequest,
    emit: (message: SessionOutboundMessage) => void,
  ): Promise<void> {
    const { requestId } = request;
    if (request.type === "code.language.cancel.request") {
      this.pending.get(request.queryId)?.cancel();
      emit({ type: "code.language.cancel.response", payload: { requestId } });
    } else if (request.type === "code.language.sync.request") {
      let error: string | null = null;
      try {
        await this.sync(request);
      } catch (cause) {
        error = String(cause);
      }
      emit({ type: "code.language.sync.response", payload: { requestId, error } });
    } else if (request.type === "code.language.snippets.request") {
      const snippets = await this.snippets(request.cwd, request.locations);
      emit({ type: "code.language.snippets.response", payload: { requestId, snippets } });
    } else {
      const response = await this.query(request, requestId);
      emit({
        type: "code.language.query.response",
        payload: { requestId, version: request.version, ...response },
      });
    }
  }

  private workspace(cwd: string): Workspace {
    if (this.disposed) throw new Error("Language session closed");
    const key = resolve(cwd);
    let workspace = this.workspaces.get(key);
    if (!workspace) {
      workspace = {
        cwd: key,
        generation: randomUUID(),
        documents: new Map(),
        process: null,
        starting: null,
        retryAt: 0,
        idle: null,
        sequence: 0,
        revision: 0,
        readers: new Map(),
      };
      this.workspaces.set(key, workspace);
    }
    if (workspace.idle) clearTimeout(workspace.idle);
    workspace.idle = null;
    return workspace;
  }

  async sync(input: CodeDocument): Promise<void> {
    const workspace = this.workspace(input.cwd);
    const path = resolve(input.cwd, input.path);
    if (!isTypeScriptFile(path)) throw new Error("Unsupported language");
    const current = workspace.documents.get(path);
    if (current && input.version < current.version) return;
    workspace.revision++;
    if (input.content === null) {
      workspace.documents.delete(path);
      await workspace.process?.close(path);
      this.idle(workspace);
      return;
    }
    const document = { content: languageText(input.content), version: input.version };
    workspace.documents.set(path, document);
    // Editor versions are client-owned; LSP versions also cover temporary disk documents.
    await workspace.process?.sync(path, document.content, ++workspace.sequence);
  }

  async query(query: CodeQuery, requestId: string = randomUUID()): Promise<LanguageResponse> {
    let workspace: Workspace;
    try {
      workspace = this.workspace(query.cwd);
    } catch (error) {
      return { generation: "", result: { kind: "error", message: String(error) } };
    }
    const cancellation = new CancellationTokenSource();
    this.pending.set(requestId, cancellation);
    const path = resolve(query.cwd, query.path);
    workspace.readers.set(path, (workspace.readers.get(path) ?? 0) + 1);
    const attempt: { process: LanguageProcess | null } = { process: null };
    let timedOut = false;
    let cancelDeadline = () => {};
    const deadline = new Promise<LanguageResponse>((_, reject) => {
      cancelDeadline = this.runtime.schedule(() => {
        timedOut = true;
        reject(new Error("Language query timed out"));
        cancellation.cancel();
        if (attempt.process && workspace.process === attempt.process) {
          this.failProcess(workspace, attempt.process);
          attempt.process.stop();
        }
      }, 30000);
    });
    let abortSubscription: { dispose(): void } | undefined;
    const aborted = new Promise<LanguageResponse>((complete) => {
      abortSubscription = cancellation.token.onCancellationRequested(() =>
        complete({
          generation: workspace.generation,
          result: timedOut
            ? { kind: "error", message: "Language query timed out" }
            : { kind: "stale" },
        }),
      );
    });
    // Keep the deadline on abandoned work: LSP cancellation is only advisory.
    const execution = Promise.race([
      this.executeQuery(workspace, { ...query, path }, cancellation.token, attempt),
      deadline,
    ]).finally(() => cancelDeadline());
    try {
      return await Promise.race([execution, aborted]);
    } catch (error) {
      this.logger.debug({ err: error }, "Language query failed");
      return {
        generation: workspace.generation,
        result: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      };
    } finally {
      abortSubscription?.dispose();
      cancellation.dispose();
      this.pending.delete(requestId);
      this.releaseReader(workspace, path);
      this.idle(workspace);
    }
  }

  private async executeQuery(
    workspace: Workspace,
    query: CodeQuery,
    token: CancellationToken,
    attempt: { process: LanguageProcess | null },
  ): Promise<LanguageResponse> {
    const revision = workspace.revision;
    const stale = (): LanguageResponse => ({
      generation: workspace.generation,
      result: { kind: "stale" },
    });
    const content = await this.queryContent(workspace, query);
    if (content === null || token.isCancellationRequested) return stale();
    const starting = this.start(workspace);
    attempt.process = workspace.process;
    const generation = workspace.generation;
    const process = await starting;
    if (
      revision !== workspace.revision ||
      generation !== workspace.generation ||
      token.isCancellationRequested
    )
      return stale();
    await process.sync(query.path, content, ++workspace.sequence);
    if (token.isCancellationRequested || generation !== workspace.generation) return stale();
    const result = await process.query(query, token);
    const changedDisk =
      query.targetContentId &&
      contentIdentity(await readFile(query.path, "utf8")) !== query.targetContentId;
    const changedSession = revision !== workspace.revision || generation !== workspace.generation;
    if (changedDisk || changedSession || token.isCancellationRequested) return stale();
    return { generation, result };
  }

  private async queryContent(workspace: Workspace, query: CodeQuery): Promise<string | null> {
    if (!isTypeScriptFile(query.path)) throw new Error("Unsupported language");
    await realpath(workspace.cwd);
    const document = workspace.documents.get(query.path);
    if (query.version !== null && document?.version !== query.version) return null;
    const source = document ? document.content : await readFile(query.path, "utf8");
    const content = languageText(source);
    if (query.targetContentId) {
      if (contentIdentity(content) !== query.targetContentId) return null;
      if (contentIdentity(await readFile(query.path, "utf8")) !== query.targetContentId)
        return null;
    }
    return content;
  }

  private releaseReader(workspace: Workspace, path: string): void {
    const readers = (workspace.readers.get(path) ?? 1) - 1;
    if (readers) workspace.readers.set(path, readers);
    else workspace.readers.delete(path);
    if (!readers && !workspace.documents.has(path))
      void workspace.process?.close(path).catch(() => {});
  }

  private async start(workspace: Workspace): Promise<LanguageProcess> {
    if (workspace.starting) return workspace.starting;
    if (workspace.process) return workspace.process;
    if (this.runtime.now() < workspace.retryAt)
      throw new Error("Language server is restarting; retry shortly");
    workspace.starting = this.initializeWorkspace(workspace);
    const starting = workspace.starting;
    try {
      return await starting;
    } finally {
      if (workspace.starting === starting) workspace.starting = null;
    }
  }

  private failProcess(workspace: Workspace, process: LanguageProcess): void {
    if (workspace.process !== process) return;
    workspace.process = null;
    workspace.starting = null;
    workspace.generation = randomUUID();
    workspace.retryAt = this.runtime.now() + FAILURE_RETRY_MS;
  }

  private async initializeWorkspace(workspace: Workspace): Promise<LanguageProcess> {
    workspace.generation = randomUUID();
    let process: LanguageProcess | null = null;
    try {
      process = this.runtime.createProcess(workspace.cwd, this.logger, () => {
        if (process) this.failProcess(workspace, process);
      });
      workspace.process = process;
      await process.ready;
      if (workspace.process !== process || this.workspaces.get(workspace.cwd) !== workspace)
        throw new Error("Language workspace closed");
      for (const [path, document] of workspace.documents) {
        if (workspace.process !== process) throw new Error("Language server stopped");
        await process.sync(path, document.content, ++workspace.sequence);
      }
      return process;
    } catch (error) {
      if (process && workspace.process === process) {
        this.failProcess(workspace, process);
        process.stop();
      } else if (!process) workspace.retryAt = this.runtime.now() + FAILURE_RETRY_MS;
      throw error;
    }
  }

  async snippets(cwd: string, locations: CodeLocation[]): Promise<string[]> {
    return Promise.all(
      locations.map(async (location) => {
        try {
          const path = resolve(cwd, location.path);
          const document = this.workspaces.get(resolve(cwd))?.documents.get(path);
          const content = document?.content ?? (await readFile(path, "utf8"));
          return languageText(content).split("\n")[location.range.start.line]?.slice(0, 500) ?? "";
        } catch {
          return "";
        }
      }),
    );
  }

  private idle(workspace: Workspace): void {
    if (
      this.workspaces.get(workspace.cwd) !== workspace ||
      workspace.documents.size ||
      workspace.readers.size ||
      workspace.idle
    )
      return;
    workspace.idle = setTimeout(() => this.closeWorkspace(workspace.cwd), 5 * 60_000);
    workspace.idle.unref();
  }
  retainWorkspaces(roots: ReadonlySet<string>): void {
    const normalized = new Set([...roots].map((root) => resolve(root)));
    for (const cwd of this.workspaces.keys()) if (!normalized.has(cwd)) this.closeWorkspace(cwd);
  }
  closeWorkspace(cwd: string): void {
    const workspace = this.workspaces.get(resolve(cwd));
    if (!workspace) return;
    this.workspaces.delete(workspace.cwd);
    if (workspace.idle) clearTimeout(workspace.idle);
    workspace.generation = randomUUID();
    const process = workspace.process;
    workspace.process = null;
    workspace.starting = null;
    process?.stop();
  }
  dispose(): void {
    this.disposed = true;
    for (const pending of this.pending.values()) pending.cancel();
    for (const cwd of this.workspaces.keys()) this.closeWorkspace(cwd);
  }
}
