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
interface Workspace {
  cwd: string;
  generation: string;
  documents: Map<string, Document>;
  process: TypeScriptProcess | null;
  starting: Promise<TypeScriptProcess> | null;
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
  constructor(private readonly logger: Logger) {}

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
    const workspace = this.workspace(query.cwd);
    const cancellation = new CancellationTokenSource();
    this.pending.set(requestId, cancellation);
    const timeout = setTimeout(() => cancellation.cancel(), 30000);
    const path = resolve(query.cwd, query.path);
    workspace.readers.set(path, (workspace.readers.get(path) ?? 0) + 1);
    try {
      return await this.executeQuery(workspace, { ...query, path }, cancellation.token);
    } catch (error) {
      this.logger.debug({ err: error }, "Language query failed");
      return {
        generation: workspace.generation,
        result: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      };
    } finally {
      clearTimeout(timeout);
      cancellation.dispose();
      this.pending.delete(requestId);
      await this.releaseReader(workspace, path);
      this.idle(workspace);
    }
  }

  private async executeQuery(
    workspace: Workspace,
    query: CodeQuery,
    token: CancellationToken,
  ): Promise<LanguageResponse> {
    const revision = workspace.revision;
    const stale = (): LanguageResponse => ({
      generation: workspace.generation,
      result: { kind: "stale" },
    });
    const content = await this.queryContent(workspace, query);
    if (content === null || token.isCancellationRequested) return stale();
    const process = await this.start(workspace);
    const generation = workspace.generation;
    if (revision !== workspace.revision || token.isCancellationRequested) return stale();
    await process.sync(query.path, content, ++workspace.sequence);
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

  private async releaseReader(workspace: Workspace, path: string): Promise<void> {
    const readers = (workspace.readers.get(path) ?? 1) - 1;
    if (readers) workspace.readers.set(path, readers);
    else workspace.readers.delete(path);
    if (!readers && !workspace.documents.has(path))
      await workspace.process?.close(path).catch(() => {});
  }

  private async start(workspace: Workspace): Promise<TypeScriptProcess> {
    if (workspace.starting) return workspace.starting;
    if (workspace.process) return workspace.process;
    workspace.starting = this.initializeWorkspace(workspace);
    try {
      return await workspace.starting;
    } finally {
      workspace.starting = null;
    }
  }

  private async initializeWorkspace(workspace: Workspace): Promise<TypeScriptProcess> {
    workspace.generation = randomUUID();
    const process = new TypeScriptProcess(workspace.cwd, this.logger, () => {
      if (workspace.process === process) {
        workspace.process = null;
        workspace.generation = randomUUID();
      }
    });
    workspace.process = process;
    try {
      await process.ready;
      for (const [path, document] of workspace.documents)
        await process.sync(path, document.content, ++workspace.sequence);
      return process;
    } catch (error) {
      process.stop();
      workspace.process = null;
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
    if (workspace.documents.size || workspace.readers.size || workspace.idle) return;
    workspace.idle = setTimeout(() => this.closeWorkspace(workspace.cwd), 5 * 60_000);
    workspace.idle.unref();
  }
  retainWorkspaces(roots: ReadonlySet<string>): void {
    for (const cwd of this.workspaces.keys()) if (!roots.has(cwd)) this.closeWorkspace(cwd);
  }
  closeWorkspace(cwd: string): void {
    const workspace = this.workspaces.get(resolve(cwd));
    if (!workspace) return;
    this.workspaces.delete(workspace.cwd);
    if (workspace.idle) clearTimeout(workspace.idle);
    workspace.generation = randomUUID();
    workspace.process?.stop();
  }
  dispose(): void {
    this.disposed = true;
    for (const pending of this.pending.values()) pending.cancel();
    for (const cwd of this.workspaces.keys()) this.closeWorkspace(cwd);
  }
}
