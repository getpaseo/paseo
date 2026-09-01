import type { ChildProcess } from "node:child_process";
import type pino from "pino";
import {
  createMessageConnection,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
  ShutdownRequest,
  StreamMessageReader,
  StreamMessageWriter,
  type InitializeResult,
  type LocationLink,
  type MessageConnection,
  type Position,
} from "vscode-languageserver-protocol/node";
import { URI } from "vscode-uri";
import { spawnProcess } from "../../utils/spawn.js";
import { terminateWithTreeKill } from "../../utils/tree-kill.js";
import { languageIdForFile, type ResolvedLanguageServer } from "./language-servers.js";

/**
 * How long to wait for the server's first diagnostics for a document before asking anyway.
 *
 * tsserver answers `textDocument/definition` from a partially loaded project: the reply is
 * well-formed and wrong, pointing back at the import statement instead of the declaration.
 * The first `publishDiagnostics` for the document is the boundary where its answers become
 * correct. Servers using pull diagnostics never send it, so the wait is bounded rather than
 * required.
 */
const PROJECT_READY_TIMEOUT_MS = 20_000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 2_000;

export interface LspSessionOptions {
  server: ResolvedLanguageServer;
  /** Workspace directory the server indexes; becomes the LSP root and the process cwd. */
  rootPath: string;
  logger: pino.Logger;
}

export interface DefinitionRequestInput {
  filePath: string;
  /** Identifies the file's content, so an unchanged file is neither re-read nor re-synced. */
  version: string;
  /** Called only when the server's copy is stale. */
  readText: () => Promise<string>;
  position: Position;
}

interface OpenDocument {
  version: string;
  /** LSP document version, which must increase on every change notification. */
  revision: number;
  /** Resolves on the document's first diagnostics, and stays resolved across edits. */
  ready: Promise<void>;
  markReady: () => void;
}

/**
 * One language server process, scoped to a workspace root. Owns the connection, the set of
 * synchronized documents, and the readiness gate. Requests are typed through the protocol
 * package's request descriptors, so params and results are checked against the spec.
 */
export class LspSession {
  private readonly server: ResolvedLanguageServer;
  private readonly rootPath: string;
  private readonly logger: pino.Logger;
  private readonly documents = new Map<string, OpenDocument>();

  private child: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private initializing: Promise<InitializeResult> | null = null;
  private disposed = false;

  constructor(options: LspSessionOptions) {
    this.server = options.server;
    this.rootPath = options.rootPath;
    this.logger = options.logger.child({ lsp: options.server.descriptor.id });
  }

  async definition(input: DefinitionRequestInput): Promise<LocationLink[]> {
    const connection = await this.ensureInitialized();
    const uri = URI.file(input.filePath).toString();
    const document = await this.syncDocument({ connection, uri, input });

    await withTimeout(document.ready, PROJECT_READY_TIMEOUT_MS);
    // One wait is the bound. A server that never publishes diagnostics for this document —
    // pull diagnostics, or a file outside the project — would otherwise pay the full timeout
    // on every request rather than only the first.
    document.markReady();

    const result = await connection.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position: input.position,
    });
    return normalizeDefinition(result);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    const connection = this.connection;
    const child = this.child;
    this.connection = null;
    this.child = null;
    this.initializing = null;
    this.documents.clear();

    if (connection) {
      try {
        await withTimeout(
          connection.sendRequest(ShutdownRequest.type),
          GRACEFUL_SHUTDOWN_TIMEOUT_MS,
        );
        this.send(connection.sendNotification(ExitNotification.type));
      } catch (error) {
        this.logger.debug({ error }, "language server shutdown failed; killing process");
      }
      connection.dispose();
    }
    if (child) {
      // typescript-language-server forks tsserver and pyright-langserver is a shim, so killing
      // the parent alone orphans a process holding the whole project graph.
      await terminateWithTreeKill(child, {
        gracefulTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
        forceTimeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS,
      });
    }
  }

  /**
   * A notification is fire-and-forget, but the write behind it still rejects once the process
   * is gone. Unhandled, that rejection is a daemon crash under Node's default policy.
   */
  private send(notification: Promise<void>): void {
    notification.catch((error) => {
      this.logger.debug({ err: error }, "language server notification failed");
    });
  }

  /** Drop the connection state so the next request starts a fresh process. */
  private forget(): void {
    this.connection = null;
    this.initializing = null;
    this.documents.clear();
  }

  private async ensureInitialized(): Promise<MessageConnection> {
    if (this.disposed) {
      throw new Error("language server session is disposed");
    }
    if (!this.initializing) {
      const attempt = this.start();
      this.initializing = attempt;
      // A failed handshake must not poison the session for the whole idle window.
      attempt.catch(() => {
        if (this.initializing === attempt) {
          this.initializing = null;
        }
      });
    }
    await this.initializing;
    const connection = this.connection;
    if (!connection) {
      throw new Error("language server connection is unavailable");
    }
    return connection;
  }

  private async start(): Promise<InitializeResult> {
    const { descriptor, executablePath } = this.server;
    const child = spawnProcess(executablePath, descriptor.args, {
      cwd: this.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stderr?.on("data", (chunk: Buffer) => {
      if (this.logger.isLevelEnabled?.("debug")) {
        this.logger.debug({ output: chunk.toString().trimEnd() }, "language server stderr");
      }
    });
    child.on("exit", (code, signal) => {
      this.logger.info({ code, signal }, "language server exited");
      this.forget();
    });
    // A spawn failure — EAGAIN under load, or the binary removed while its resolution was
    // still cached — emits here. Without a listener Node rethrows it and takes the daemon
    // down with every agent it is running.
    child.on("error", (error) => {
      this.logger.warn({ err: error }, "language server process failed");
      this.forget();
    });
    // The writer keeps writing into stdin after the process is gone, which is an EPIPE the
    // stream throws rather than returns.
    child.stdin?.on("error", (error) => {
      this.logger.debug({ err: error }, "language server stdin failed");
    });

    if (!child.stdout || !child.stdin) {
      throw new Error("language server was spawned without stdio pipes");
    }
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      this.documents.get(params.uri)?.markReady();
    });
    connection.listen();
    this.connection = connection;

    const rootUri = URI.file(this.rootPath).toString();
    const result = await connection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: this.rootPath }],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          synchronization: {},
          definition: { linkSupport: true },
          publishDiagnostics: {},
        },
      },
    });
    const encoding = result.capabilities.positionEncoding;
    if (encoding && encoding !== "utf-16") {
      // Positions arrive as UTF-16 code units, which is what JavaScript strings index in, and
      // nothing converts them. A server insisting on UTF-8 is off on any line with astral
      // characters, so say so rather than returning quietly wrong ranges.
      this.logger.warn({ encoding }, "language server chose an unsupported position encoding");
    }
    this.send(connection.sendNotification(InitializedNotification.type, {}));
    return result;
  }

  /**
   * Open the document, or push a change when its content moved on. The version is compared
   * before the text is read, so an unchanged file costs neither a disk read nor a round trip,
   * and the readiness gate survives edits instead of restarting on every save.
   */
  private async syncDocument(params: {
    connection: MessageConnection;
    uri: string;
    input: DefinitionRequestInput;
  }): Promise<OpenDocument> {
    const { connection, uri, input } = params;
    const existing = this.documents.get(uri);
    if (existing?.version === input.version) {
      return existing;
    }

    const text = await input.readText();
    // Re-check after the read. Requests are dispatched concurrently, so two hovers on the same
    // file both get here; without this they each send `didOpen` and the loser's document is
    // orphaned in a `ready` state nothing ever resolves.
    const current = this.documents.get(uri);
    if (current?.version === input.version) {
      return current;
    }
    if (current) {
      current.version = input.version;
      current.revision += 1;
      this.send(
        connection.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri, version: current.revision },
          contentChanges: [{ text }],
        }),
      );
      return current;
    }

    const opened = createOpenDocument(input.version);
    this.documents.set(uri, opened);
    this.send(
      connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: {
          uri,
          languageId: languageIdForFile(this.server.descriptor, input.filePath),
          version: opened.revision,
          text,
        },
      }),
    );
    return opened;
  }
}

function createOpenDocument(version: string): OpenDocument {
  let markReady = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  return { version, revision: 1, ready, markReady };
}

/** LSP allows `Location`, `Location[]`, `LocationLink[]`, or null. Normalize to links. */
function normalizeDefinition(
  result: Awaited<ReturnType<MessageConnection["sendRequest"]>>,
): LocationLink[] {
  if (!result) {
    return [];
  }
  const entries = Array.isArray(result) ? result : [result];
  return entries.map((entry) =>
    "targetUri" in entry
      ? (entry as LocationLink)
      : { targetUri: entry.uri, targetRange: entry.range, targetSelectionRange: entry.range },
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
