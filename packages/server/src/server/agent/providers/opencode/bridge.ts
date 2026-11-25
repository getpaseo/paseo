import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Logger } from "pino";

import { writeFileAtomic } from "../../../atomic-file.js";
import {
  addModelVisibleStructuredContent,
  serializePaseoToolInputParameters,
} from "../../tools/paseo-tool-serialization.js";
import {
  PaseoToolInputError,
  type PaseoToolCatalog,
  type PaseoToolResult,
} from "../../tools/types.js";
import type { McpClientTool } from "../../mcp-client-connection.js";

const INTERNAL_PREFIX = "/_internal/opencode";
const MAX_REQUEST_BYTES = 1024 * 1024;

class OpenCodeBridgeClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OpenCodeBridgeClientError";
  }
}

interface OpenCodeBridgeOptions {
  paseoHome: string;
  logger: Logger;
  port?: number;
}

export interface OpenCodeBridgeMcpTool {
  /** OpenCode's effective tool name, `<server>_<tool>`. */
  name: string;
  description: string;
  inputSchema: McpClientTool["inputSchema"];
}

/** MCP servers Paseo hosts for one session; the v2 plugin exposes them to that session only. */
export interface OpenCodeBridgeMcp {
  readonly tools: readonly OpenCodeBridgeMcpTool[];
  /** Server instructions for the model, which the plugin adds to each request of the session. */
  readonly instructions: string | undefined;
  execute(name: string, input: unknown, signal?: AbortSignal): Promise<PaseoToolResult>;
}

interface OpenCodeSessionBinding {
  env: Record<string, string>;
  tools?: PaseoToolCatalog;
  mcp?: OpenCodeBridgeMcp;
  /** Prepares a descendant session before its first model request. */
  adoptDescendant?: (sessionId: string) => Promise<void>;
}

interface BindOpenCodeSessionInput extends OpenCodeSessionBinding {
  sessionId: string;
}

interface OpenCodePluginOptions {
  baseUrl: string;
  token: string;
}

interface OpenCodeConfig {
  plugin?: Array<string | [string, Record<string, unknown>]>;
  [key: string]: unknown;
}

export class OpenCodeBridge {
  private readonly paseoHome: string;
  private readonly logger: Logger;
  private readonly port: number;
  private readonly token = randomBytes(32).toString("hex");
  private readonly sessions = new Map<string, OpenCodeSessionBinding>();
  private server: Server | null = null;
  private baseUrl: string | null = null;
  private pluginUrl: string | null = null;
  private v2PluginUrl: string | null = null;
  private manifestCatalog: Pick<PaseoToolCatalog, "tools"> | null = null;

  constructor(options: OpenCodeBridgeOptions) {
    this.paseoHome = options.paseoHome;
    this.logger = options.logger.child({ module: "agent", component: "opencode-bridge" });
    this.port = options.port ?? 0;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.pluginUrl = await this.materializePlugin();
    const server = createServer((request, response) => {
      void this.route(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await closeServer(server);
      throw new Error("OpenCode bridge did not expose a TCP address");
    }
    this.server = server;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  setManifestCatalog(catalog: Pick<PaseoToolCatalog, "tools"> | null): void {
    this.manifestCatalog = catalog;
  }

  bindSession(input: BindOpenCodeSessionInput): () => void {
    if (this.sessions.has(input.sessionId))
      throw new Error(`OpenCode session ${input.sessionId} is already bound to a Paseo agent`);
    const binding: OpenCodeSessionBinding = {
      env: { ...input.env },
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.mcp ? { mcp: input.mcp } : {}),
      ...(input.adoptDescendant ? { adoptDescendant: input.adoptDescendant } : {}),
    };
    this.sessions.set(input.sessionId, binding);
    return () => {
      if (this.sessions.get(input.sessionId) === binding) {
        this.sessions.delete(input.sessionId);
      }
    };
  }

  /** Whether the session's bound MCP servers expose tools the v2 plugin must run. */
  hasMcpTools(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.mcp?.tools.length ?? 0) > 0;
  }

  decorateServerEnv(env: Record<string, string>): Record<string, string> {
    const pluginUrl = this.requirePluginUrl();
    const options: OpenCodePluginOptions = {
      baseUrl: this.requireBaseUrl(),
      token: this.token,
    };
    const config = parseOpenCodeConfig(env.OPENCODE_CONFIG_CONTENT);
    const plugins = config.plugin ?? [];
    const withoutBridge = plugins.filter((entry) => {
      const specifier = Array.isArray(entry) ? entry[0] : entry;
      return !specifier.includes("/paseo-") || !specifier.endsWith(".mjs");
    });
    return {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...config,
        plugin: [...withoutBridge, [pluginUrl, options]],
      }),
    };
  }

  async materializeV2Plugin(): Promise<string> {
    this.v2PluginUrl ??= await this.materializePlugin(2);
    return this.v2PluginUrl;
  }

  sharedV2Connection(baseUrl = this.requireBaseUrl()): OpenCodePluginOptions {
    return { baseUrl, token: this.token };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.baseUrl = null;
    this.sessions.clear();
    if (server) await closeServer(server);
  }

  private async materializePlugin(version: 1 | 2 = 1): Promise<string> {
    if (version === 2) return materializeOpenCodeV2Plugin(this.paseoHome);
    const artifact = await loadOpenCodeBridgePluginArtifact(import.meta.url);
    const digest = createHash("sha256").update(artifact).digest("hex");
    const destination = path.join(this.paseoHome, "runtime", "opencode", `paseo-${digest}.mjs`);
    await writeFileAtomic(destination, artifact);
    return pathToFileURL(destination).href;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.headers.authorization !== `Bearer ${this.token}`) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      await this.dispatch(request, response);
    } catch (error) {
      this.logger.warn({ err: error }, "OpenCode bridge request failed");
      sendFailure(response, error);
    }
  }

  private async dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.requireBaseUrl());
    if (request.method === "GET" && url.pathname === `${INTERNAL_PREFIX}/tools`) {
      sendJson(response, 200, this.manifest(url.searchParams.get("sessionID")));
      return;
    }

    const contextMatch = url.pathname.match(
      new RegExp(`^${INTERNAL_PREFIX}/sessions/([^/]+)/context$`),
    );
    if (request.method === "GET" && contextMatch) {
      const binding = this.requireBinding(decodeURIComponent(contextMatch[1]));
      sendJson(response, 200, sessionContext(binding, url.searchParams.has("tools")));
      return;
    }

    const mcpMatch = url.pathname.match(
      new RegExp(`^${INTERNAL_PREFIX}/sessions/([^/]+)/mcp-tools/([^/]+)$`),
    );
    if (request.method === "POST" && mcpMatch) {
      await this.executeMcpTool({
        sessionId: decodeURIComponent(mcpMatch[1]),
        toolName: decodeURIComponent(mcpMatch[2]),
        request,
        response,
      });
      return;
    }

    const descendantMatch = url.pathname.match(
      new RegExp(`^${INTERNAL_PREFIX}/sessions/([^/]+)/descendants/([^/]+)$`),
    );
    if (request.method === "POST" && descendantMatch) {
      const binding = this.requireBinding(decodeURIComponent(descendantMatch[1]));
      await binding.adoptDescendant?.(decodeURIComponent(descendantMatch[2]));
      sendJson(response, 200, {});
      return;
    }

    const toolMatch = url.pathname.match(
      new RegExp(`^${INTERNAL_PREFIX}/sessions/([^/]+)/tools/([^/]+)$`),
    );
    if (request.method === "POST" && toolMatch) {
      await this.executeTool({
        sessionId: decodeURIComponent(toolMatch[1]),
        toolName: decodeURIComponent(toolMatch[2]),
        request,
        response,
      });
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  }

  private manifest(sessionId: string | null) {
    return {
      tools: this.serializeManifest(sessionId),
      mcpTools: sessionId === null ? [] : (this.sessions.get(sessionId)?.mcp?.tools ?? []),
    };
  }

  private serializeManifest(sessionId: string | null): Array<Record<string, unknown>> {
    let catalog: Pick<PaseoToolCatalog, "tools"> | null | undefined = this.manifestCatalog;
    if (sessionId !== null) {
      const binding = this.sessions.get(sessionId);
      if (!binding) {
        throw new OpenCodeBridgeClientError(404, "OpenCode session is not bound to a Paseo agent");
      }
      catalog = binding.tools;
    }
    if (!catalog) return [];
    return [...catalog.tools.values()].map((tool) => {
      const definition: Record<string, unknown> = {
        name: tool.name,
        description: tool.description,
        inputSchema: serializePaseoToolInputParameters(tool),
      };
      if (tool.title) definition.title = tool.title;
      return definition;
    });
  }

  private async executeTool(input: {
    sessionId: string;
    toolName: string;
    request: IncomingMessage;
    response: ServerResponse;
  }): Promise<void> {
    const binding = this.sessions.get(input.sessionId);
    if (!binding) {
      sendJson(input.response, 404, { error: "OpenCode session is not bound to a Paseo agent" });
      return;
    }
    if (!binding.tools) {
      sendJson(input.response, 403, { error: "Paseo tools are disabled for this session" });
      return;
    }
    if (!binding.tools.getTool(input.toolName)) {
      throw new OpenCodeBridgeClientError(404, `Paseo tool not found: ${input.toolName}`);
    }
    const body = await readJsonBody(input.request);
    const result = await binding.tools.executeTool(input.toolName, body, {
      signal: abortOnDisconnect(input.response),
    });
    sendJson(input.response, 200, addModelVisibleStructuredContent(result));
  }

  private async executeMcpTool(input: {
    sessionId: string;
    toolName: string;
    request: IncomingMessage;
    response: ServerResponse;
  }): Promise<void> {
    const mcp = this.requireBinding(input.sessionId).mcp;
    if (!mcp?.tools.some((tool) => tool.name === input.toolName))
      throw new OpenCodeBridgeClientError(404, `MCP tool not found: ${input.toolName}`);
    const body = await readJsonBody(input.request);
    const result = await mcp.execute(input.toolName, body, abortOnDisconnect(input.response));
    sendJson(input.response, 200, addModelVisibleStructuredContent(result));
  }

  private requireBinding(sessionId: string): OpenCodeSessionBinding {
    const binding = this.sessions.get(sessionId);
    if (!binding)
      throw new OpenCodeBridgeClientError(404, "OpenCode session is not bound to a Paseo agent");
    return binding;
  }

  private requireBaseUrl(): string {
    if (!this.baseUrl) throw new Error("OpenCode bridge is not started");
    return this.baseUrl;
  }

  private requirePluginUrl(): string {
    if (!this.pluginUrl) throw new Error("OpenCode bridge plugin is not materialized");
    return this.pluginUrl;
  }
}

export async function materializeOpenCodeV2Plugin(paseoHome: string): Promise<string> {
  const artifact = await loadOpenCodeBridgePluginArtifact(import.meta.url, undefined, 2);
  const digest = createHash("sha256").update(artifact).digest("hex");
  // V2 ignores configured file paths; it loads a package directory's server entry point.
  const directory = path.join(paseoHome, "runtime", "opencode", `paseo-v2-${digest}`);
  await writeFileAtomic(path.join(directory, "server.js"), artifact);
  const state = await readFile(new URL("./v2/state.mjs", import.meta.url));
  await writeFileAtomic(path.join(directory, "state.mjs"), state);
  await writeFileAtomic(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "paseo-opencode-bridge",
      private: true,
      type: "module",
      exports: { "./server": "./server.js" },
    }),
  );
  return pathToFileURL(directory).href;
}

export function decorateOpenCodeV2Env(
  env: Record<string, string>,
  pluginUrl: string,
  options: Record<string, string> = {},
): Record<string, string> {
  const config = parseOpenCodeConfig(env.OPENCODE_CONFIG_CONTENT);
  const plugins = config.plugins;
  if (plugins !== undefined && !Array.isArray(plugins))
    throw new Error("OpenCode v2 plugins must be an array");
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      plugins: [
        ...(plugins ?? []).filter(
          (plugin: unknown) =>
            plugin !== pluginUrl &&
            !(
              typeof plugin === "object" &&
              plugin !== null &&
              "package" in plugin &&
              plugin.package === pluginUrl
            ),
        ),
        { package: pluginUrl, options },
      ],
    }),
  };
}

type CompileOpenCodeBridgePlugin = (sourcePath: string) => Promise<Uint8Array>;

export async function loadOpenCodeBridgePluginArtifact(
  moduleUrl: string,
  compileSource: CompileOpenCodeBridgePlugin = compileOpenCodeBridgePlugin,
  version: 1 | 2 = 1,
): Promise<Uint8Array> {
  const directory = version === 2 ? "./v2/" : "./";
  const bundleUrl = new URL(`${directory}bridge-plugin.bundle.mjs`, moduleUrl);
  try {
    return await readFile(bundleUrl);
  } catch (error) {
    if (!fileURLToPath(moduleUrl).endsWith(`${path.sep}bridge.ts`)) {
      throw new Error("Bundled OpenCode bridge plugin artifact is missing", { cause: error });
    }
  }
  return compileSource(fileURLToPath(new URL(`${directory}bridge-plugin.mjs`, moduleUrl)));
}

async function compileOpenCodeBridgePlugin(sourcePath: string): Promise<Uint8Array> {
  const source = await readFile(sourcePath, "utf8");
  const { build } = await import("esbuild");
  const bundled = await build({
    stdin: {
      contents: source,
      resolveDir: path.dirname(sourcePath),
      sourcefile: path.basename(sourcePath),
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
    write: false,
  });
  const artifact = bundled.outputFiles[0]?.contents;
  if (!artifact) throw new Error("Failed to bundle the OpenCode bridge plugin");
  return artifact;
}

function parseOpenCodeConfig(value: string | undefined): OpenCodeConfig {
  if (!value?.trim()) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENCODE_CONFIG_CONTENT must contain a JSON object");
  }
  return parsed as OpenCodeConfig;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      throw new OpenCodeBridgeClientError(413, "OpenCode bridge request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new OpenCodeBridgeClientError(400, "Malformed JSON request body");
  }
}

function sessionContext(binding: OpenCodeSessionBinding, withTools: boolean) {
  if (!withTools) return { env: binding.env };
  return {
    env: binding.env,
    tools: [...(binding.tools?.tools.keys() ?? [])],
    mcpTools: binding.mcp?.tools ?? [],
    mcpInstructions: binding.mcp?.instructions,
  };
}

/**
 * Aborts when OpenCode stops waiting for the response, for example when the user stops the turn.
 * The request has ended by then, so only the response reports the disconnect.
 */
function abortOnDisconnect(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.once("close", () => {
    if (!response.writableFinished)
      controller.abort(new Error("OpenCode tool request was aborted"));
  });
  return controller.signal;
}

function sendFailure(response: ServerResponse, error: unknown): void {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (response.headersSent) {
    response.destroy(failure);
    return;
  }
  if (error instanceof OpenCodeBridgeClientError) {
    sendJson(response, error.status, {
      error: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  } else if (error instanceof PaseoToolInputError) {
    sendJson(
      response,
      error.status,
      error.issues
        ? { error: "Invalid tool input", issues: error.issues }
        : { error: error.message },
    );
  } else {
    sendJson(response, 500, { error: failure.message });
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
