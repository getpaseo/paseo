import { terminateWithTreeKill } from "../../utils/tree-kill.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type ProtocolConnection,
  type CancellationToken,
} from "vscode-languageserver-protocol/node.js";
import {
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  HoverRequest,
  type TextDocumentPositionParams,
  DefinitionRequest,
  ReferencesRequest,
} from "vscode-languageserver-protocol";
import type { CodeQuery, CodeQueryResult, CodeLocation } from "@getpaseo/protocol/code-language";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";

const require = createRequire(import.meta.url);
export class TypeScriptProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly connection: ProtocolConnection;
  private readonly opened = new Map<string, number>();
  private stopped = false;
  readonly ready: Promise<void>;

  constructor(cwd: string, logger: Logger, onExit: () => void) {
    const entry = unpackLanguageRuntimePath(
      join(dirname(require.resolve("typescript-language-server/package.json")), "lib/cli.mjs"),
    );
    let tsserver: string;
    try {
      tsserver = createRequire(join(cwd, "package.json")).resolve("typescript/lib/tsserver.js");
    } catch {
      tsserver = require.resolve("typescript/lib/tsserver.js");
    }
    tsserver = unpackLanguageRuntimePath(tsserver);
    this.child = spawn(process.execPath, [entry, "--stdio"], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "pipe",
    });
    this.child.stderr.on("data", (chunk: Buffer) =>
      logger.debug({ stderr: chunk.toString() }, "TypeScript language server"),
    );
    this.connection = createProtocolConnection(
      new StreamMessageReader(this.child.stdout),
      new StreamMessageWriter(this.child.stdin),
    );
    this.connection.onRequest("workspace/configuration", () => []);
    this.connection.onRequest("client/registerCapability", () => null);
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onRequest("workspace/applyEdit", () => ({ applied: false }));
    this.child.on("error", (error) => {
      logger.warn({ err: error }, "Language server failed");
      this.stop();
    });
    this.child.on("exit", () => {
      this.connection.dispose();
      onExit();
    });
    this.connection.listen();
    this.ready = this.initialize(cwd, tsserver);
    const startupDeadline = setTimeout(() => this.stop(), 30000);
    startupDeadline.unref();
    void this.ready.finally(() => clearTimeout(startupDeadline)).catch(() => {});
    logger.debug({ cwd, pid: this.child.pid, tsserver }, "Language server started");
  }

  private async initialize(cwd: string, tsserver: string): Promise<void> {
    await this.connection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToFileURL(cwd).href,
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          hover: { contentFormat: ["plaintext"] },
          definition: { linkSupport: true },
        },
      },
      initializationOptions: {
        disableAutomaticTypingAcquisition: true,
        tsserver: { path: tsserver, useSyntaxServer: "never" },
        preferences: { disableSuggestions: true },
      },
    });
    await this.connection.sendNotification(InitializedNotification.type, {});
  }

  async sync(path: string, content: string, version: number): Promise<void> {
    await this.ready;
    const uri = pathToFileURL(path).href;
    if (!this.opened.has(path)) {
      await this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: {
          uri,
          languageId: path.endsWith(".tsx") ? "typescriptreact" : "typescript",
          version,
          text: content,
        },
      });
    } else if (this.opened.get(path) !== version) {
      await this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    }
    this.opened.set(path, version);
  }

  async close(path: string): Promise<void> {
    await this.ready;
    if (!this.opened.delete(path)) return;
    await this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
      textDocument: { uri: pathToFileURL(path).href },
    });
  }

  async query(query: CodeQuery, token: CancellationToken): Promise<CodeQueryResult> {
    await this.ready;
    const params = {
      textDocument: { uri: pathToFileURL(query.path).href },
      position: query.position,
    };
    if (query.operation === "hover") {
      const hover = await this.connection.sendRequest(HoverRequest.type, params, token);
      if (!hover) return { kind: "hover", text: "", range: null };
      const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
      return {
        kind: "hover",
        text: contents
          .map((part) => (typeof part === "string" ? part : part.value))
          .join("\n\n")
          .replace(/^```[^\n]*\n/gm, "")
          .trim(),
        range: hover.range ?? null,
      };
    }
    const locations: CodeLocation[] = [];
    if (query.operation === "references") {
      const result = await this.connection.sendRequest(
        ReferencesRequest.type,
        { ...params, context: { includeDeclaration: false } },
        token,
      );
      for (const location of result ?? []) {
        if (location.uri.startsWith("file:"))
          locations.push({ path: fileURLToPath(location.uri), range: location.range });
      }
      // Alias references can report the original declaration as a non-definition.
      const definitions = await this.definitions(params, token);
      const usages = locations.filter(
        (location) =>
          !definitions.some(
            (definition) =>
              definition.path === location.path &&
              definition.range.start.line === location.range.start.line &&
              definition.range.start.character === location.range.start.character,
          ),
      );
      return { kind: "locations", locations: usages };
    }
    return { kind: "locations", locations: await this.definitions(params, token) };
  }

  private async definitions(
    params: TextDocumentPositionParams,
    token: CancellationToken,
  ): Promise<CodeLocation[]> {
    const result = await this.connection.sendRequest(DefinitionRequest.type, params, token);
    const entries = result === null ? [] : [result].flat();
    const locations: CodeLocation[] = [];
    for (const location of entries) {
      const uri = "targetUri" in location ? location.targetUri : location.uri;
      const range =
        "targetSelectionRange" in location ? location.targetSelectionRange : location.range;
      if (uri.startsWith("file:")) locations.push({ path: fileURLToPath(uri), range });
    }
    return locations;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const deadline = setTimeout(() => {
      void terminateWithTreeKill(this.child, { gracefulTimeoutMs: 1000, forceTimeoutMs: 1000 });
    }, 2000);
    deadline.unref();
    this.child.once("exit", () => clearTimeout(deadline));
    void this.connection
      .sendRequest("shutdown")
      .catch(() => null)
      .then(async () => {
        await this.connection.sendNotification("exit").catch(() => {});
        this.child.stdin.end();
        this.connection.dispose();
        return undefined;
      });
  }
}

// Child entrypoints must be real files; the packaged desktop unpacks both runtimes.
export function unpackLanguageRuntimePath(path: string): string {
  return path.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
}
