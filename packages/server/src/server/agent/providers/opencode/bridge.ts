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
import type { PaseoToolCatalog } from "../../tools/types.js";

const INTERNAL_PREFIX = "/_internal/opencode";
const MAX_REQUEST_BYTES = 1024 * 1024;

interface OpenCodeBridgeOptions {
  paseoHome: string;
  logger: Logger;
}

interface OpenCodeSessionBinding {
  env: Record<string, string>;
  tools?: PaseoToolCatalog;
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
  private readonly token = randomBytes(32).toString("hex");
  private readonly sessions = new Map<string, OpenCodeSessionBinding>();
  private server: Server | null = null;
  private baseUrl: string | null = null;
  private pluginUrl: string | null = null;
  private manifestCatalog: PaseoToolCatalog | null = null;

  constructor(options: OpenCodeBridgeOptions) {
    this.paseoHome = options.paseoHome;
    this.logger = options.logger.child({ module: "agent", component: "opencode-bridge" });
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.pluginUrl = await this.materializePlugin();
    const server = createServer((request, response) => {
      void this.route(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
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

  setManifestCatalog(catalog: PaseoToolCatalog | null): void {
    this.manifestCatalog = catalog;
  }

  bindSession(input: BindOpenCodeSessionInput): () => void {
    const binding: OpenCodeSessionBinding = {
      env: { ...input.env },
      ...(input.tools ? { tools: input.tools } : {}),
    };
    this.sessions.set(input.sessionId, binding);
    return () => {
      if (this.sessions.get(input.sessionId) === binding) {
        this.sessions.delete(input.sessionId);
      }
    };
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

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.baseUrl = null;
    this.sessions.clear();
    if (server) await closeServer(server);
  }

  private async materializePlugin(): Promise<string> {
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
      const url = new URL(request.url ?? "/", this.requireBaseUrl());
      if (request.method === "GET" && url.pathname === `${INTERNAL_PREFIX}/tools`) {
        sendJson(response, 200, { tools: this.serializeManifest() });
        return;
      }

      const contextMatch = url.pathname.match(
        new RegExp(`^${INTERNAL_PREFIX}/sessions/([^/]+)/context$`),
      );
      if (request.method === "GET" && contextMatch) {
        const binding = this.sessions.get(decodeURIComponent(contextMatch[1]));
        if (!binding) {
          sendJson(response, 404, { error: "OpenCode session is not bound to a Paseo agent" });
          return;
        }
        sendJson(response, 200, { env: binding.env });
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
    } catch (error) {
      this.logger.warn({ err: error }, "OpenCode bridge request failed");
      if (!response.headersSent) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private serializeManifest(): Array<Record<string, unknown>> {
    const catalog = this.manifestCatalog;
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
    const body = await readJsonBody(input.request);
    const controller = new AbortController();
    input.request.once("aborted", () =>
      controller.abort(new Error("OpenCode tool request was aborted")),
    );
    const result = await binding.tools.executeTool(input.toolName, body, {
      signal: controller.signal,
    });
    sendJson(input.response, 200, addModelVisibleStructuredContent(result));
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

type CompileOpenCodeBridgePlugin = (sourcePath: string) => Promise<Uint8Array>;

export async function loadOpenCodeBridgePluginArtifact(
  moduleUrl: string,
  compileSource: CompileOpenCodeBridgePlugin = compileOpenCodeBridgePlugin,
): Promise<Uint8Array> {
  const bundleUrl = new URL("./bridge-plugin.bundle.mjs", moduleUrl);
  try {
    return await readFile(bundleUrl);
  } catch (error) {
    if (!fileURLToPath(moduleUrl).endsWith(`${path.sep}bridge.ts`)) {
      throw new Error("Bundled OpenCode bridge plugin artifact is missing", { cause: error });
    }
  }
  return compileSource(fileURLToPath(new URL("./bridge-plugin.mjs", moduleUrl)));
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
    if (size > MAX_REQUEST_BYTES) throw new Error("OpenCode bridge request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
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
