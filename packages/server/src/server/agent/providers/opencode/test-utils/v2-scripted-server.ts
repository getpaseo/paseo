import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** A real OpenCode v2 binary; local end-to-end tests run against whatever this resolves to. */
export const OPENCODE_V2_COMMAND = process.env.PASEO_OPENCODE_V2_BIN ?? "opencode";
export const SCRIPTED_MODEL = "test/test-model";

export interface ScriptedTool {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ScriptedRequest {
  /** The first user message, which names the conversation. */
  prompt: string;
  /** Every message the model received, including OpenCode's system and harness context. */
  transcript: string;
  tools: ScriptedTool[];
}

/**
 * Asks the scripted model to call `tool` with `input`, then to report the tool output as
 * `RESULT <output>`. A child session started with this prompt follows the same script.
 */
export function scriptedCall(tool: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({ call: tool, input });
}

interface StartOptions {
  /** Installs Paseo's plugin before the service starts, as a user does for an explicit server. */
  beforeStart?: (paths: { configDirectory: string }) => Promise<void>;
  /** The user's own OpenCode MCP servers, in OpenCode's `mcp.servers` configuration shape. */
  mcpServers?: Record<string, unknown>;
}

/**
 * A detached OpenCode v2 service with isolated state, backed by a scripted model. It stands in
 * for the shared service a user runs, so it is never owned by the code under test.
 */
export class ScriptedOpenCodeService {
  private constructor(
    readonly requests: ScriptedRequest[],
    readonly root: string,
    readonly url: string,
    readonly password: string,
    private readonly process: ChildProcess,
    private readonly llm: Server,
  ) {}

  static async start(options: StartOptions = {}): Promise<ScriptedOpenCodeService> {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-v2-service-"));
    const configDirectory = path.join(root, "config");
    await mkdir(configDirectory, { recursive: true });
    const requests: ScriptedRequest[] = [];
    const llm = createServer((request, response) => {
      void (async () => {
        try {
          const body = await respond(request);
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(body);
        } catch (error) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: String(error) }));
        }
      })();
    });
    async function respond(request: IncomingMessage): Promise<string> {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
      const prompt = firstUserText(body.messages);
      requests.push({
        prompt,
        transcript: body.messages.map(messageText).join("\n"),
        tools: (body.tools ?? []).map((tool) => ({
          name: tool.function.name,
          description: tool.function.description ?? "",
          parameters: tool.function.parameters,
        })),
      });
      // OpenCode may add harness messages after a tool result, so answer the latest step.
      const step = body.messages.findLast(
        (message) =>
          message.role === "tool" ||
          (message.role === "user" && parseScript(messageText(message)) !== null),
      );
      if (step?.role === "tool") return textStream(`RESULT ${messageText(step)}`);
      const script = step && parseScript(messageText(step));
      if (!script) return textStream("OK");
      return toolCallStream(`call-${requests.length}`, script.call, script.input);
    }
    await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
    const llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
    await writeFile(
      path.join(configDirectory, "opencode.json"),
      JSON.stringify({
        ...config(llmUrl),
        ...(options.mcpServers ? { mcp: { servers: options.mcpServers } } : {}),
      }),
    );
    await options.beforeStart?.({ configDirectory });
    const child = spawn(
      OPENCODE_V2_COMMAND,
      ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0"],
      {
        cwd: root,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...isolatedEnvironment(root) },
      },
    );
    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", () => undefined);
    const registration = path.join(root, "state", "opencode", "service.json");
    const deadline = Date.now() + 30_000;
    while (true) {
      const content = await readFile(registration, "utf8").catch(() => "");
      const parsed = content ? (JSON.parse(content) as { url: string; password: string }) : null;
      // The service registers before it serves requests.
      if (parsed && (await isReady(parsed.url, parsed.password))) {
        return new ScriptedOpenCodeService(requests, root, parsed.url, parsed.password, child, llm);
      }
      if (child.exitCode !== null || Date.now() > deadline) {
        llm.close();
        await rm(root, { recursive: true, force: true });
        throw new Error(`OpenCode v2 service did not register (exit ${child.exitCode})`);
      }
      await delay(100);
    }
  }

  /** Provider environment that lets Paseo discover this service, as with the user's own. */
  get discoveryEnvironment(): Record<string, string> {
    return {
      XDG_STATE_HOME: path.join(this.root, "state"),
      XDG_CONFIG_HOME: path.join(this.root, "xdg-config"),
      OPENCODE_CONFIG_DIR: path.join(this.root, "config"),
    };
  }

  /**
   * Provider environment for a server Paseo starts itself with this service's model. It keeps the
   * service's state directory, so the service's registration is present but must not be used.
   */
  get ownedEnvironment(): Record<string, string> {
    return {
      ...isolatedEnvironment(this.root),
      XDG_DATA_HOME: path.join(this.root, "owned-data"),
    };
  }

  get configDirectory(): string {
    return path.join(this.root, "config");
  }

  /**
   * Agent requests the scripted model received for the conversation started with `prompt`.
   * OpenCode's title requests carry the same prompt but offer no tools, so they are left out.
   */
  requestsFor(prompt: string): ScriptedRequest[] {
    return this.agentRequests.filter((request) => request.prompt === prompt);
  }

  get agentRequests(): ScriptedRequest[] {
    return this.requests.filter((request) => request.tools.length > 0);
  }

  async stop(): Promise<void> {
    const exited = new Promise<void>((resolve) => {
      if (this.process.exitCode !== null) resolve();
      else this.process.once("exit", () => resolve());
    });
    if (this.process.pid && process.platform !== "win32") {
      try {
        process.kill(-this.process.pid, "SIGTERM");
      } catch {
        this.process.kill("SIGTERM");
      }
    } else this.process.kill("SIGTERM");
    await Promise.race([exited, delay(10_000)]);
    if (this.process.exitCode === null) this.process.kill("SIGKILL");
    await new Promise<void>((resolve) => this.llm.close(() => resolve()));
    await rm(this.root, { recursive: true, force: true });
  }
}

async function isReady(url: string, password: string): Promise<boolean> {
  const response = await fetch(new URL("/api/info", url), {
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    signal: AbortSignal.timeout(2_000),
  }).catch(() => null);
  return response?.ok === true;
}

function isolatedEnvironment(root: string): Record<string, string> {
  return {
    HOME: root,
    OPENCODE_CONFIG_DIR: path.join(root, "config"),
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    // The scripted model calls shell and subagent directly, which full Code Mode moves inside execute.
    OPENCODE_FLAGS: "-full_codemode",
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  };
}

function config(llmUrl: string) {
  return {
    update: "disable",
    model: SCRIPTED_MODEL,
    providers: {
      test: {
        name: "Test",
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { apiKey: "test-key", baseURL: llmUrl },
        models: {
          "test-model": {
            name: "Test Model",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            cost: { input: 0, output: 0 },
            limit: { context: 100_000, output: 10_000 },
          },
        },
      },
    },
  };
}

interface ChatMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }> | null;
}

interface ChatRequest {
  messages: ChatMessage[];
  tools?: Array<{ function: { name: string; description?: string; parameters: unknown } }>;
}

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).map((part) => part.text ?? "").join("");
}

function firstUserText(messages: ChatMessage[]): string {
  const user = messages.find((message) => message.role === "user");
  return user ? messageText(user).trim() : "";
}

function parseScript(prompt: string): { call: string; input: Record<string, unknown> } | null {
  const start = prompt.indexOf('{"call"');
  if (start === -1) return null;
  const end = prompt.lastIndexOf("}");
  return JSON.parse(prompt.slice(start, end + 1)) as {
    call: string;
    input: Record<string, unknown>;
  };
}

function textStream(text: string): string {
  return sse([
    { choices: [{ delta: { role: "assistant" }, finish_reason: null }], usage: null },
    { choices: [{ delta: { content: text }, finish_reason: null }], usage: null },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
  ]);
}

function toolCallStream(id: string, name: string, input: unknown): string {
  return sse([
    {
      choices: [
        {
          delta: {
            role: "assistant",
            tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }],
          },
          finish_reason: null,
        },
      ],
      usage: null,
    },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(input) } }] } },
      ],
      usage: null,
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
  ]);
}

function sse(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}
