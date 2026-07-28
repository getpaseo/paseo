import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 1;

export interface MetadataOpenAIModel {
  id: string;
  name?: string;
}

export interface MetadataOpenAIError {
  code: string;
  message: string;
}

export function joinOpenAICompatibleUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, "");
  const trimmedPath = path.trim().replace(/^\/+/, "");
  if (!trimmedBase) {
    throw new Error("baseUrl is required");
  }
  if (!trimmedPath) {
    return trimmedBase;
  }
  return `${trimmedBase}/${trimmedPath}`;
}

export function isMetadataCustomEndpointReady(
  endpoint:
    | {
        enabled?: boolean;
        baseUrl?: string;
        model?: string;
      }
    | null
    | undefined,
): boolean {
  if (!endpoint || endpoint.enabled !== true) {
    return false;
  }
  return trimNonEmpty(endpoint.baseUrl) !== null && trimNonEmpty(endpoint.model) !== null;
}

export async function listMetadataOpenAIModels(input: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<
  { models: MetadataOpenAIModel[]; error: null } | { models: []; error: MetadataOpenAIError }
> {
  const baseUrl = trimNonEmpty(input.baseUrl);
  if (!baseUrl) {
    return {
      models: [],
      error: { code: "missing_base_url", message: "Base URL is required" },
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = joinOpenAICompatibleUrl(baseUrl, "models");

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: buildHeaders(input.apiKey),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        models: [],
        error: {
          code: `http_${response.status}`,
          message: await readErrorMessage(response),
        },
      };
    }
    const payload = (await response.json()) as unknown;
    return { models: normalizeModelsPayload(payload), error: null };
  } catch (error) {
    return {
      models: [],
      error: {
        code: "request_failed",
        message: errorMessage(error),
      },
    };
  }
}

export async function generateMetadataOpenAIStructured<T>(input: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<T> {
  const baseUrl = trimNonEmpty(input.baseUrl);
  const model = trimNonEmpty(input.model);
  if (!baseUrl) {
    throw new Error("baseUrl is required");
  }
  if (!model) {
    throw new Error("model is required");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;
  const url = joinOpenAICompatibleUrl(baseUrl, "chat/completions");
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const includeResponseFormat = attempt === 0;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: buildHeaders(input.apiKey),
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(
          buildChatCompletionsBody({
            model,
            prompt: input.prompt,
            schemaName: input.schemaName,
            includeResponseFormat,
          }),
        ),
      });

      if (!response.ok) {
        // Some local servers reject response_format; retry once without it.
        if (includeResponseFormat && response.status === 400 && maxRetries > 0) {
          lastError = new Error(await readErrorMessage(response));
          continue;
        }
        throw new Error(await readErrorMessage(response));
      }

      const payload = (await response.json()) as unknown;
      const content = extractMessageContent(payload);
      const parsedJson = parseJsonContent(content);
      return input.schema.parse(parsedJson);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(errorMessage(error));
    }
  }

  throw lastError ?? new Error("Metadata OpenAI generation failed");
}

function buildChatCompletionsBody(input: {
  model: string;
  prompt: string;
  schemaName: string;
  includeResponseFormat: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    temperature: 0,
    max_tokens: 1024,
    messages: [
      {
        role: "system",
        content:
          "You generate structured metadata for a developer tool. Reply with a single JSON object only. No markdown, no commentary.",
      },
      {
        role: "user",
        content: `${input.prompt}\n\nReturn JSON for schema "${input.schemaName}" only.`,
      },
    ],
  };
  if (input.includeResponseFormat) {
    body.response_format = { type: "json_object" };
  }
  return body;
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const trimmedKey = trimNonEmpty(apiKey);
  if (trimmedKey) {
    headers.Authorization = `Bearer ${trimmedKey}`;
  }
  return headers;
}

function normalizeModelsPayload(payload: unknown): MetadataOpenAIModel[] {
  if (!isRecord(payload)) {
    return [];
  }
  const data = payload["data"];
  if (!Array.isArray(data)) {
    return [];
  }
  const models: MetadataOpenAIModel[] = [];
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || entry["id"].trim() === "") {
      continue;
    }
    const id = entry["id"].trim();
    const name =
      typeof entry["name"] === "string" && entry["name"].trim() !== ""
        ? entry["name"].trim()
        : undefined;
    models.push(name ? { id, name } : { id });
  }
  return models;
}

function extractMessageContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload["choices"]) || payload["choices"].length === 0) {
    throw new Error("Chat completion response missing choices");
  }
  const first = payload["choices"][0];
  if (!isRecord(first) || !isRecord(first["message"])) {
    throw new Error("Chat completion response missing message");
  }
  const content = first["message"]["content"];
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("Chat completion response missing message content");
  }
  return content;
}

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  const unfenced = stripMarkdownFence(trimmed);
  try {
    return JSON.parse(unfenced);
  } catch {
    throw new Error("Chat completion content is not valid JSON");
  }
}

function stripMarkdownFence(content: string): string {
  const match = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? content;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.trim().length > 0) {
      return `HTTP ${response.status}: ${text.slice(0, 300)}`;
    }
  } catch {
    // ignore body read errors
  }
  return `HTTP ${response.status}`;
}

function trimNonEmpty(value: string | undefined | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
