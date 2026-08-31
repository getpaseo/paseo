import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type pino from "pino";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  DefinitionRequest,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
  ShutdownRequest,
  type InitializeResult,
  type LocationLink,
  type Position,
  type PositionEncodingKind,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { languageIdForFile, type ResolvedLanguageServer } from "./language-servers.js";

/**
 * How long to wait for the server's first diagnostics for a document before asking anyway.
 *
 * tsserver answers `textDocument/definition` from a partially loaded project: the reply is
 * well-formed and wrong, pointing back at the import statement instead of the declaration.
 * The first `publishDiagnostics` for the document is the boundary — every request before it
 * was wrong and the first one after it was right. Servers that publish no diagnostics (or
 * use pull diagnostics) never send it, so the wait is bounded rather than required.
 */
const PROJECT_READY_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;

export interface LspSessionOptions {
  server: ResolvedLanguageServer;
  /** Workspace directory the server indexes; becomes the LSP root and the process cwd. */
  rootPath: string;
  logger: pino.Logger;
  spawnProcess?: typeof spawn;
}

interface OpenDocument {
  document: TextDocument;
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
  private readonly spawnProcess: typeof spawn;
  private readonly documents = new Map<string, OpenDocument>();

  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: MessageConnection | null = null;
  private initializing: Promise<InitializeResult> | null = null;
  private positionEncoding: PositionEncodingKind = "utf-16";
  private disposed = false;

  constructor(options: LspSessionOptions) {
    this.server = options.server;
    this.rootPath = options.rootPath;
    this.logger = options.logger.child({ lsp: options.server.descriptor.id });
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  /**
   * Position encoding negotiated at initialize. JavaScript strings are UTF-16, so the app's
   * character offsets match the default; a server that picks UTF-8 needs conversion before
   * its positions can be trusted.
   */
  get negotiatedPositionEncoding(): PositionEncodingKind {
    return this.positionEncoding;
  }

  async definition(input: {
    filePath: string;
    text: string;
    position: Position;
  }): Promise<LocationLink[]> {
    const connection = await this.ensureInitialized();
    const uri = URI.file(input.filePath).toString();
    const document = this.syncDocument(uri, input.filePath, input.text);

    await withTimeout(document.ready, PROJECT_READY_TIMEOUT_MS);

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
        await withTimeout(connection.sendRequest(ShutdownRequest.type), SHUTDOWN_TIMEOUT_MS);
        connection.sendNotification(ExitNotification.type);
      } catch (error) {
        this.logger.debug({ error }, "language server shutdown failed; killing process");
      }
      connection.dispose();
    }
    child?.kill();
  }

  private async ensureInitialized(): Promise<MessageConnection> {
    if (this.disposed) {
      throw new Error("language server session is disposed");
    }
    if (!this.initializing) {
      this.initializing = this.start();
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
    const child = this.spawnProcess(executablePath, descriptor.args, {
      cwd: this.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stderr.on("data", (chunk: Buffer) => {
      this.logger.debug({ output: chunk.toString().trimEnd() }, "language server stderr");
    });
    child.on("exit", (code, signal) => {
      this.logger.info({ code, signal }, "language server exited");
      this.connection = null;
      this.initializing = null;
    });

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
    this.positionEncoding = result.capabilities.positionEncoding ?? "utf-16";
    connection.sendNotification(InitializedNotification.type, {});
    return result;
  }

  /**
   * Open the document, or push a new version when its text changed. Full-text sync keeps the
   * server's copy identical to what the client rendered, which is what the position refers to.
   */
  private syncDocument(uri: string, filePath: string, text: string): OpenDocument {
    const connection = this.connection;
    if (!connection) {
      throw new Error("language server connection is unavailable");
    }

    const existing = this.documents.get(uri);
    if (existing) {
      if (existing.document.getText() === text) {
        return existing;
      }
      connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      });
      this.documents.delete(uri);
    }

    const languageId = languageIdForFile(this.server.descriptor, filePath);
    const document = TextDocument.create(uri, languageId, 1, text);
    const opened = createOpenDocument(document);
    this.documents.set(uri, opened);

    connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId, version: 1, text },
    });
    return opened;
  }
}

function createOpenDocument(document: TextDocument): OpenDocument {
  let markReady = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  return { document, ready, markReady };
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
