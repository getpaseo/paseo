import { describe, it, expect, afterEach } from "vitest";
import pino from "pino";

import {
  startEmbeddingServer,
  type EmbeddingInferenceFn,
  type EmbeddingServerHandle,
} from "./embedding-server.js";

const FIXED_KEY = "test-key-123";

const fakeInfer: EmbeddingInferenceFn = async (input, hints) => ({
  vectors: input.map((_, i) => [i + 0.1, i + 0.2, i + 0.3]),
  model: hints?.model ?? "fake-model",
  dimension: 3,
});

// Each test gets its own server. `beforeAll` + module-scoped state was
// flaky under vitest's parallel pool — different files sharing the worker
// caused shutdowns mid-test. Per-test isolation is slower (~5ms each) but
// deterministic.
let handles: EmbeddingServerHandle[] = [];

async function spawn(
  opts: { infer?: EmbeddingInferenceFn; apiKey?: string } = {},
): Promise<EmbeddingServerHandle> {
  const handle = await startEmbeddingServer({
    logger: pino({ enabled: false }),
    infer: opts.infer ?? fakeInfer,
    apiKey: opts.apiKey ?? FIXED_KEY,
  });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(handles.map((h) => h.close().catch(() => undefined)));
  handles = [];
});

async function callEmbeddings(
  handle: EmbeddingServerHandle,
  body: unknown,
  opts: { auth?: string; method?: string; path?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const method = opts.method ?? "POST";
  const init: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      authorization: opts.auth ?? `Bearer ${FIXED_KEY}`,
    },
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${handle.port}${opts.path ?? "/v1/embeddings"}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("startEmbeddingServer", () => {
  it("listens on loopback with an ephemeral port", async () => {
    const handle = await spawn();
    expect(handle.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.apiKey).toBe(FIXED_KEY);
  });

  it("rejects unauthenticated requests", async () => {
    const handle = await spawn();
    const result = await callEmbeddings(
      handle,
      { input: "hi", model: "x" },
      { auth: "Bearer wrong" },
    );
    expect(result.status).toBe(401);
  });

  it("rejects non-POST and other paths", async () => {
    const handle = await spawn();
    const r1 = await callEmbeddings(handle, {}, { method: "GET" });
    const r2 = await callEmbeddings(handle, { input: "hi" }, { path: "/v1/chat" });
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
  });

  it("returns OpenAI-shaped response for a string input", async () => {
    const handle = await spawn();
    const result = await callEmbeddings(handle, { input: "hello world", model: "bge-small" });
    expect(result.status).toBe(200);
    const body = result.body as {
      object: string;
      model: string;
      data: Array<{ object: string; index: number; embedding: number[] }>;
      usage: { prompt_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe("list");
    expect(body.model).toBe("bge-small");
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      object: "embedding",
      index: 0,
      embedding: [0.1, 0.2, 0.3],
    });
    expect(body.usage).toEqual({ prompt_tokens: 0, total_tokens: 0 });
  });

  it("supports an array of inputs and indexes them in order", async () => {
    const handle = await spawn();
    const result = await callEmbeddings(handle, {
      input: ["a", "b", "c"],
      model: "bge-small",
    });
    const body = result.body as { data: Array<{ index: number; embedding: number[] }> };
    expect(body.data).toHaveLength(3);
    expect(body.data.map((d) => d.index)).toEqual([0, 1, 2]);
    expect(body.data[1]?.embedding).toEqual([1.1, 1.2, 1.3]);
  });

  it("400s when input is missing", async () => {
    const handle = await spawn();
    const result = await callEmbeddings(handle, { model: "x" });
    expect(result.status).toBe(400);
  });

  it("400s on invalid JSON body", async () => {
    const handle = await spawn();
    const result = await callEmbeddings(handle, "not json", { method: "POST" });
    expect(result.status).toBe(400);
  });

  it("500s and surfaces the message when infer throws", async () => {
    const handle = await spawn({
      infer: async () => {
        throw new Error("model OOM");
      },
      apiKey: "k",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ input: "x", model: "y" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe("model OOM");
  });
});
