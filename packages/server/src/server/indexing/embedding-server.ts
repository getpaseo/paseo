import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";

/**
 * Loopback HTTP server that exposes a minimal OpenAI-compatible
 * `/v1/embeddings` endpoint backed by an injectable inference function.
 *
 * Hubcode's MCP-bridged crg subprocess receives `CRG_OPENAI_BASE_URL`
 * pointing at this server when the user picks the "Hubcode Local" embedding
 * provider, so semantic tools work without any cloud egress.
 *
 * Wire is intentionally minimal:
 *   - bind 127.0.0.1 only, ephemeral port (port 0)
 *   - require Bearer token (random 32 bytes hex per process)
 *   - accept POST /v1/embeddings with { model, input, dimensions? }
 *   - respond OpenAI-shaped: { data: [{ embedding, index, object }], model, object, usage }
 *
 * The `infer` function is injected so the inference engine can evolve
 * independently from this transport layer (and so tests can pass synthetic
 * vectors without spinning up a real model).
 */

export interface EmbeddingInferenceFn {
  (
    input: string[],
    hints?: { model?: string; dimensions?: number },
  ): Promise<{
    vectors: number[][];
    /** Reported back to the caller — must match what crg expects. */
    model: string;
    /** Dimension actually produced (set when reduction was requested). */
    dimension: number;
  }>;
}

export interface EmbeddingServerHandle {
  baseUrl: string;
  apiKey: string;
  port: number;
  close(): Promise<void>;
}

export interface EmbeddingServerDeps {
  logger: Logger;
  infer: EmbeddingInferenceFn;
  /** Override Bearer token; tests pin this for assertions. */
  apiKey?: string;
  /** Override port for tests; default 0 (ephemeral). */
  port?: number;
}

export async function startEmbeddingServer(
  deps: EmbeddingServerDeps,
): Promise<EmbeddingServerHandle> {
  const logger = deps.logger.child({ module: "embedding-server" });
  const apiKey = deps.apiKey ?? randomBytes(32).toString("hex");
  const server = createServer((req, res) => {
    handle(req, res, { logger, infer: deps.infer, apiKey }).catch((err) => {
      logger.error({ err }, "embedding server handler crashed");
      writeJson(res, 500, { error: { message: "internal error" } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(deps.port ?? 0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("embedding server: failed to bind ephemeral port");
  }
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  logger.info({ baseUrl }, "Embedding server listening");
  return {
    baseUrl,
    apiKey,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

interface HandleDeps {
  logger: Logger;
  infer: EmbeddingInferenceFn;
  apiKey: string;
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: HandleDeps): Promise<void> {
  if (req.method !== "POST" || req.url !== "/v1/embeddings") {
    writeJson(res, 404, { error: { message: "not found" } });
    return;
  }
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${deps.apiKey}`) {
    writeJson(res, 401, { error: { message: "invalid api key" } });
    return;
  }
  const body = await readBody(req).catch(() => null);
  if (!body) {
    writeJson(res, 400, { error: { message: "invalid JSON body" } });
    return;
  }
  const inputRaw = (body as { input?: unknown }).input;
  const inputs = Array.isArray(inputRaw)
    ? (inputRaw as unknown[]).map(String)
    : typeof inputRaw === "string"
      ? [inputRaw]
      : null;
  if (!inputs || inputs.length === 0) {
    writeJson(res, 400, { error: { message: "input must be a string or array of strings" } });
    return;
  }
  const model =
    typeof (body as { model?: unknown }).model === "string"
      ? (body as { model: string }).model
      : "hubcode-local";
  const dimensions =
    typeof (body as { dimensions?: unknown }).dimensions === "number"
      ? (body as { dimensions: number }).dimensions
      : undefined;
  try {
    const result = await deps.infer(inputs, { model, dimensions });
    writeJson(res, 200, {
      object: "list",
      model: result.model,
      data: result.vectors.map((vec, idx) => ({
        object: "embedding",
        index: idx,
        embedding: vec,
      })),
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    deps.logger.warn({ err }, "embedding inference failed");
    const message = err instanceof Error ? err.message : String(err);
    writeJson(res, 500, { error: { message } });
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total > 8 * 1024 * 1024) {
        req.destroy(new Error("payload too large"));
      }
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
