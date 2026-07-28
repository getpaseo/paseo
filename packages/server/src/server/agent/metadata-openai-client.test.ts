import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import {
  generateMetadataOpenAIStructured,
  isMetadataCustomEndpointReady,
  joinOpenAICompatibleUrl,
  listMetadataOpenAIModels,
} from "./metadata-openai-client.js";

describe("joinOpenAICompatibleUrl", () => {
  test("joins baseUrl ending with /v1 and models path", () => {
    expect(joinOpenAICompatibleUrl("http://127.0.0.1:11434/v1", "models")).toBe(
      "http://127.0.0.1:11434/v1/models",
    );
  });

  test("handles trailing slash on baseUrl", () => {
    expect(joinOpenAICompatibleUrl("http://127.0.0.1:11434/v1/", "chat/completions")).toBe(
      "http://127.0.0.1:11434/v1/chat/completions",
    );
  });
});

describe("isMetadataCustomEndpointReady", () => {
  test("is false when disabled or incomplete", () => {
    expect(isMetadataCustomEndpointReady(undefined)).toBe(false);
    expect(
      isMetadataCustomEndpointReady({
        enabled: false,
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "llama3",
      }),
    ).toBe(false);
    expect(
      isMetadataCustomEndpointReady({
        enabled: true,
        baseUrl: "",
        model: "llama3",
      }),
    ).toBe(false);
    expect(
      isMetadataCustomEndpointReady({
        enabled: true,
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "  ",
      }),
    ).toBe(false);
  });

  test("is true when enabled with baseUrl and model", () => {
    expect(
      isMetadataCustomEndpointReady({
        enabled: true,
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "llama3",
      }),
    ).toBe(true);
  });
});

describe("listMetadataOpenAIModels", () => {
  test("maps OpenAI-style models payload", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ id: "llama3" }, { id: "mistral", name: "Mistral" }, { id: "  " }],
        }),
        { status: 200 },
      );
    });

    const result = await listMetadataOpenAIModels({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({
      models: [{ id: "llama3" }, { id: "mistral", name: "Mistral" }],
      error: null,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
        }),
      }),
    );
  });

  test("returns error object on non-2xx without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const result = await listMetadataOpenAIModels({
      baseUrl: "http://127.0.0.1:11434/v1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.models).toEqual([]);
    expect(result.error?.code).toBe("http_401");
  });
});

describe("generateMetadataOpenAIStructured", () => {
  const schema = z.object({ message: z.string().min(1) });

  test("posts chat completions with bearer and validates JSON", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(body.model).toBe("llama3");
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer sk-test",
          "Content-Type": "application/json",
        }),
      );
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ message: "Update files" }) } }],
        }),
        { status: 200 },
      );
    });

    const result = await generateMetadataOpenAIStructured({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "sk-test",
      model: "llama3",
      prompt: "Write a commit message",
      schema,
      schemaName: "CommitMessage",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ message: "Update files" });
  });

  test("omits Authorization when apiKey empty", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"message":"ok"}' } }],
        }),
        { status: 200 },
      );
    });

    await generateMetadataOpenAIStructured({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "",
      model: "llama3",
      prompt: "prompt",
      schema,
      schemaName: "CommitMessage",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  });

  test("strips markdown fences around JSON", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '```json\n{"message":"Fenced"}\n```',
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await generateMetadataOpenAIStructured({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3",
      prompt: "prompt",
      schema,
      schemaName: "CommitMessage",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ message: "Fenced" });
  });

  test("retries without response_format after 400", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (body.response_format) {
        return new Response("response_format unsupported", { status: 400 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"message":"retried"}' } }],
        }),
        { status: 200 },
      );
    });

    const result = await generateMetadataOpenAIStructured({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3",
      prompt: "prompt",
      schema,
      schemaName: "CommitMessage",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 1,
    });
    expect(result).toEqual({ message: "retried" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("throws after invalid JSON exhausts retries", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "not-json" } }],
        }),
        { status: 200 },
      );
    });

    await expect(
      generateMetadataOpenAIStructured({
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "llama3",
        prompt: "prompt",
        schema,
        schemaName: "CommitMessage",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        maxRetries: 1,
      }),
    ).rejects.toThrow(/valid JSON|not valid JSON/i);
  });
});
