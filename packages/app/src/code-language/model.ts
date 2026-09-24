import type {
  CodeDocument,
  CodeQuery,
  CodeQueryResult,
  CodeLocation,
} from "@getpaseo/protocol/code-language";

export interface LanguageTransport {
  readonly isConnected: boolean;
  syncCodeDocument(document: CodeDocument): Promise<void>;
  queryCode(
    query: CodeQuery,
    requestId: string,
  ): Promise<{ result: CodeQueryResult; generation: string; version: number | null }>;
  cancelCodeQuery(requestId: string): Promise<void>;
  getCodeSnippets(cwd: string, locations: CodeLocation[]): Promise<string[]>;
  subscribeConnectionStatus(listener: (status: { status: string }) => void): () => void;
}
interface BufferDocument {
  content: string;
  version: number;
  sent: number;
  leases: number;
}

export class WorkspaceLanguage {
  readonly id = crypto.randomUUID();
  private readonly documents = new Map<string, BufferDocument>();
  private revision = 0;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private syncError: unknown = null;
  private readonly unsubscribe: () => void;

  constructor(
    readonly transport: LanguageTransport,
    readonly cwd: string,
  ) {
    this.unsubscribe = transport.subscribeConnectionStatus(() => {
      this.epoch++;
      for (const document of this.documents.values()) document.sent = -1;
    });
  }

  retain(path: string, content: string): { update(content: string): void; release(): void } {
    let document = this.documents.get(path);
    if (document) document.leases++;
    else {
      document = { content, version: ++this.revision, sent: -1, leases: 1 };
      this.documents.set(path, document);
    }
    const owned = document;
    const update = (nextContent: string) => {
      if (nextContent !== owned.content) {
        owned.content = nextContent;
        owned.version = ++this.revision;
      }
      this.schedule();
    };
    update(content);
    return {
      update,
      release: () => {
        if (--owned.leases) return;
        this.documents.delete(path);
        const version = ++this.revision;
        this.enqueue(async () => {
          if (this.transport.isConnected)
            await this.transport.syncCodeDocument({ cwd: this.cwd, path, version, content: null });
        });
      },
    };
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => {});
    }, 150);
  }
  private enqueue(write: () => Promise<void>): Promise<void> {
    this.writes = this.writes.then(write).catch((error: unknown) => {
      this.syncError = error;
    });
    return this.writes;
  }
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.enqueue(async () => {
      if (!this.transport.isConnected) throw new Error("Language host disconnected");
      this.syncError = null;
      for (const [path, document] of this.documents) {
        if (document.sent === document.version) continue;
        const version = document.version;
        const epoch = this.epoch;
        await this.transport.syncCodeDocument({
          cwd: this.cwd,
          path,
          version,
          content: document.content,
        });
        if (epoch === this.epoch) document.sent = version;
      }
    });
    if (this.syncError) throw this.syncError;
  }

  async query(
    input: Omit<CodeQuery, "cwd" | "version">,
    signal: AbortSignal,
  ): Promise<CodeQueryResult> {
    const epoch = this.epoch;
    const revision = this.revision;
    await this.flush();
    if (signal.aborted || epoch !== this.epoch || revision !== this.revision)
      return { kind: "stale" };
    const requestId = crypto.randomUUID();
    const cancel = () => {
      void this.transport.cancelCodeQuery(requestId).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const version = this.documents.get(input.path)?.version ?? null;
      const response = await this.transport.queryCode(
        { ...input, cwd: this.cwd, version },
        requestId,
      );
      if (
        signal.aborted ||
        epoch !== this.epoch ||
        revision !== this.revision ||
        response.version !== version
      )
        return { kind: "stale" };
      return response.result;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  snippets(locations: CodeLocation[]): Promise<string[]> {
    return this.transport.getCodeSnippets(this.cwd, locations);
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribe();
    this.epoch++;
  }
}
const workspaces = new WeakMap<LanguageTransport, Map<string, WorkspaceLanguage>>();
export function workspaceLanguage(transport: LanguageTransport, cwd: string): WorkspaceLanguage {
  let scopes = workspaces.get(transport);
  if (!scopes) {
    scopes = new Map();
    workspaces.set(transport, scopes);
  }
  let scope = scopes.get(cwd);
  if (!scope) {
    scope = new WorkspaceLanguage(transport, cwd);
    scopes.set(cwd, scope);
  }
  return scope;
}
