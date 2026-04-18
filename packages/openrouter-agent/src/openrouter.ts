export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type StreamDelta = {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

export type StreamChunk = {
  id: string;
  choices: Array<{
    index: number;
    delta: StreamDelta;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type CompletionParams = {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  stream: true;
  temperature?: number;
};

const FETCH_CONNECT_TIMEOUT_MS = 30_000; // connect + headers
const STREAM_IDLE_TIMEOUT_MS = 60_000; // max gap between SSE chunks
const MAX_PARSE_ERRORS = 5;

export async function* streamCompletion(
  apiKey: string,
  params: CompletionParams,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  // Combine external abort signal with our own timeouts
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort(signal?.reason ?? new Error("aborted"));
  if (signal?.aborted) {
    ctrl.abort(signal.reason);
  } else {
    signal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  const connectTimer = setTimeout(
    () => ctrl.abort(new Error("OpenRouter connect timeout")),
    FETCH_CONNECT_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/getpaseo/paseo",
        "X-Title": "Paseo OpenRouter Agent",
      },
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(connectTimer);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${body}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let parseErrors = 0;

  const tryYield = function* (data: string): Generator<StreamChunk> {
    try {
      yield JSON.parse(data) as StreamChunk;
    } catch (err) {
      parseErrors++;
      process.stderr.write(
        `[openrouter] SSE parse error #${parseErrors}: ${(err as Error).message} ` +
          `| data: ${data.slice(0, 200)}\n`,
      );
      if (parseErrors > MAX_PARSE_ERRORS) {
        throw new Error(`Too many malformed SSE chunks (${parseErrors})`);
      }
    }
  };

  try {
    while (true) {
      // Per-chunk idle timeout: if no data arrives within the window, abort.
      const idleTimer = setTimeout(
        () => ctrl.abort(new Error("OpenRouter stream idle timeout")),
        STREAM_IDLE_TIMEOUT_MS,
      );

      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw new Error(`Stream read failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(idleTimer);
      }

      if (chunk.done) {
        // Flush residual buffer — don't silently lose a final partial line.
        const tail = buffer.trim();
        if (tail.startsWith("data: ")) {
          const data = tail.slice(6);
          if (data && data !== "[DONE]") {
            yield* tryYield(data);
          }
        }
        return;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith(":")) continue; // SSE heartbeat/comment
        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        yield* tryYield(data);
      }
    }
  } finally {
    signal?.removeEventListener("abort", onExternalAbort);
    try {
      reader.releaseLock();
    } catch {
      // reader may already be released
    }
  }
}
