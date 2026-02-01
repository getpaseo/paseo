import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentSlashCommand,
  AgentCommandResult,
  AgentUsage,
  ListModelsOptions,
} from "../agent/agent-sdk-types.js";
import type { AgentPermissionRequest, AgentPermissionResponse } from "../agent/agent-sdk-types.js";

const TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

type UnixHttpResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

function parseSseDataFrames(body: string): string[] {
  const frames: string[] = [];
  const parts = body.split(/\n\n+/g);
  for (const part of parts) {
    const lines = part.split("\n");
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length > 0) {
      frames.push(dataLines.join("\n"));
    }
  }
  return frames;
}

function extractJsonRpcBody(res: UnixHttpResponse): unknown {
  const contentType = String(res.headers["content-type"] ?? "");
  if (contentType.includes("text/event-stream")) {
    const frames = parseSseDataFrames(res.body);
    if (frames.length === 0) {
      throw new Error("Empty SSE response from Self-ID MCP server");
    }
    return JSON.parse(frames[frames.length - 1]!);
  }
  return JSON.parse(res.body);
}

async function unixSocketJsonRpcRequest(params: {
  socketPath: string;
  path: string;
  headers?: Record<string, string>;
  body: unknown;
}): Promise<UnixHttpResponse> {
  const bodyText = JSON.stringify(params.body);
  return await new Promise<UnixHttpResponse>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: params.socketPath,
        path: params.path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyText),
          Accept: "application/json, text/event-stream",
          ...(params.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 500,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.write(bodyText);
    req.end();
  });
}

async function callSelfIdMcpTool(params: {
  socketPath: string;
  callerAgentId: string;
  toolName: "set_title";
  args: { title: string };
}): Promise<void> {
  // Minimal MCP-over-HTTP (Unix socket) client, modeled after packages/server/src/self-id-bridge.
  const urlPath = `/?callerAgentId=${encodeURIComponent(params.callerAgentId)}`;

  const initReq = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fake-agent", version: "0.0.0" },
    },
  };

  const initRes = await unixSocketJsonRpcRequest({
    socketPath: params.socketPath,
    path: urlPath,
    body: initReq,
  });
  const mcpSessionId = typeof initRes.headers["mcp-session-id"] === "string" ? initRes.headers["mcp-session-id"] : null;

  let protocolVersion: string | null = null;
  const initParsed = extractJsonRpcBody(initRes) as { result?: { protocolVersion?: string }; error?: { message?: string } };
  if (initParsed.error) {
    throw new Error(initParsed.error.message ?? "Self-ID MCP initialize failed");
  }
  protocolVersion = initParsed.result?.protocolVersion ?? null;

  const toolReq = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: params.toolName,
      arguments: params.args,
    },
  };

  const headers: Record<string, string> = {};
  if (mcpSessionId) headers["mcp-session-id"] = mcpSessionId;
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;

  const toolRes = await unixSocketJsonRpcRequest({
    socketPath: params.socketPath,
    path: urlPath,
    headers,
    body: toolReq,
  });

  const parsed = extractJsonRpcBody(toolRes) as { error?: { message?: string } };
  if (parsed.error) {
    throw new Error(parsed.error.message ?? "Self-ID MCP tool call failed");
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function isAskMode(config: AgentSessionConfig): boolean {
  const mode = (config.modeId ?? "").toLowerCase();
  const policy = (config.approvalPolicy ?? "").toLowerCase();

  // Default behavior for tests: ask unless explicitly bypassed.
  if (!mode && !policy) {
    return true;
  }

  if (policy === "never") {
    return false;
  }

  if (mode.includes("bypass") || mode.includes("full")) {
    return false;
  }

  if (mode.includes("read-only") || mode.includes("default") || mode.includes("plan") || mode.includes("ask")) {
    return true;
  }

  // "auto" behaves like "ask" for potentially-destructive actions; callers decide per-tool.
  if (mode.includes("auto")) {
    return true;
  }

  return policy === "on-request";
}

function buildPersistence(
  provider: string,
  sessionId: string,
  metadata?: Record<string, unknown>
): AgentPersistenceHandle {
  if (provider === "codex") {
    return { provider, sessionId, metadata: { conversationId: sessionId, ...(metadata ?? {}) } };
  }
  return { provider, sessionId, ...(metadata ? { metadata } : {}) };
}

function buildToolCallForPrompt(provider: string, prompt: string) {
  const text = prompt.toLowerCase();
  if (provider === "claude") {
    if (text.includes("read") && text.includes("/etc/hosts")) {
      return { name: "Read", input: { path: "/etc/hosts" }, output: { lines: 7 } };
    }
    if (text.includes("rm -f permission.txt")) {
      return { name: "Bash", input: { command: "rm -f permission.txt" }, output: { ok: true } };
    }
    if (text.includes("rm -f mcp-smoke.txt")) {
      return { name: "Bash", input: { command: "rm -f mcp-smoke.txt" }, output: { ok: true } };
    }
    if (text.includes("echo hello")) {
      return { name: "Bash", input: { command: "echo hello" }, output: { stdout: "hello\n" } };
    }
    if (text.includes("edit") && text.includes(".txt")) {
      return { name: "Edit", input: { file: "test.txt" }, output: { applied: true } };
    }
    if (text.includes("set_title") && text.includes("mcp")) {
      return { name: "mcp__paseo-self-id__set_title", input: { title: "Updated via MCP" }, output: { ok: true } };
    }
    return null;
  }

  if (provider === "codex") {
    if (text.includes("echo hello")) {
      return { name: "shell", input: { command: "echo hello" }, output: { stdout: "hello\n" } };
    }
    if (text.includes("read") && text.includes("/etc/hosts")) {
      return { name: "read_file", input: { path: "/etc/hosts" }, output: { lines: 7 } };
    }
    if (text.includes("edit") && text.includes(".txt")) {
      return { name: "apply_patch", input: { patch: "*** Begin Patch\n*** End Patch\n" }, output: { applied: true } };
    }
    const printfMatch =
      /printf\s+\"ok\"\s*>\s*([^\s`]+)/i.exec(text) ??
      /printf\s+ok\s*>\s*([^\s`]+)/i.exec(text);
    if (printfMatch) {
      const fileName = printfMatch[1] ?? "permission.txt";
      return { name: "shell", input: { command: `printf "ok" > ${fileName}` }, output: { ok: true } };
    }
    if (text.includes("sleep")) {
      // Long-running command to test cancellation/overlap.
      return { name: "shell", input: { command: "sleep 30" }, output: null };
    }
    return null;
  }

  // opencode: used by a small set of tests
  if (provider === "opencode") {
    if (text.includes("reason")) {
      return { name: "shell", input: { command: "echo reasoning" }, output: { stdout: "reasoning\n" } };
    }
    return null;
  }

  return null;
}

class FakeAgentSession implements AgentSession {
  readonly capabilities = TEST_CAPABILITIES;
  readonly id: string;
  private readonly providerName: string;
  private readonly config: AgentSessionConfig;
  private interruptSignal = createDeferred<void>();
  private memoryMarker: string | null = null;
  private pendingPermissions: AgentPermissionRequest[] = [];
  private permissionGate: Deferred<AgentPermissionResponse> | null = null;
  private readonly historyPath: string;

  constructor(
    providerName: string,
    config: AgentSessionConfig,
    sessionId?: string,
    memoryMarker?: string | null
  ) {
    this.providerName = providerName;
    this.config = config;
    this.id = sessionId ?? randomUUID();
    this.memoryMarker = memoryMarker ?? null;
    this.historyPath = path.join(
      tmpdir(),
      "paseo-fake-provider-history",
      this.providerName,
      `${this.id}.jsonl`
    );
  }

  get provider() {
    return this.providerName;
  }

  private async appendHistoryEvent(event: AgentStreamEvent): Promise<void> {
    const folder = path.dirname(this.historyPath);
    await mkdir(folder, { recursive: true });
    await appendFile(this.historyPath, JSON.stringify(event) + "\n", "utf8");
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const timeline: AgentRunResult["timeline"] = [];
    const textPrompt = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
    const resultText = this.buildAssistantText(textPrompt);
    timeline.push({ type: "assistant_message", text: resultText });
    const usage: AgentUsage | undefined = options ? { inputTokens: 1, outputTokens: 1 } : undefined;
    return { sessionId: this.id, finalText: resultText, timeline, usage };
  }

  async *stream(prompt: AgentPromptInput): AsyncGenerator<AgentStreamEvent> {
    // New run => reset interrupt gate.
    this.interruptSignal = createDeferred<void>();
    const textPrompt = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
    const markerMatch = /remember (?:this )?(?:marker|string|project name)[^"]*"([^"]+)"/i.exec(textPrompt);
    if (markerMatch) {
      this.memoryMarker = markerMatch[1] ?? null;
    }
    const threadStarted: AgentStreamEvent = { type: "thread_started", provider: this.providerName, sessionId: this.id };
    await this.appendHistoryEvent(threadStarted);
    yield threadStarted;

    const turnStarted: AgentStreamEvent = { type: "turn_started", provider: this.providerName };
    await this.appendHistoryEvent(turnStarted);
    yield turnStarted;

    const tool = buildToolCallForPrompt(this.providerName, textPrompt);
    if (tool) {
      const needsPermission = this.needsPermissionForTool(tool.name, tool.input ?? {});
      const callId = randomUUID();
      const toolRunning: AgentStreamEvent = {
        type: "timeline",
        provider: this.providerName,
        item: {
          type: "tool_call",
          name: tool.name,
          callId,
          status: "running",
          input: tool.input ?? undefined,
        },
      };
      await this.appendHistoryEvent(toolRunning);
      yield toolRunning;

      if (needsPermission) {
        const request: AgentPermissionRequest = {
          id: randomUUID(),
          provider: this.providerName,
          name: tool.name,
          kind: "tool",
          title: "Permission required",
          description: "Test permission request",
          input: tool.input ?? {},
        };
        this.pendingPermissions = [request];
        this.permissionGate = createDeferred<AgentPermissionResponse>();
        const permissionRequested: AgentStreamEvent = { type: "permission_requested", provider: this.providerName, request };
        await this.appendHistoryEvent(permissionRequested);
        yield permissionRequested;

        const response = await this.permissionGate.promise;
        this.pendingPermissions = [];
        const permissionResolved: AgentStreamEvent = {
          type: "permission_resolved",
          provider: this.providerName,
          requestId: request.id,
          resolution: response,
        };
        await this.appendHistoryEvent(permissionResolved);
        yield permissionResolved;

        if (response.behavior === "deny") {
          // Permission denied: do not execute the tool.
          if (response.interrupt) {
            const canceled: AgentStreamEvent = { type: "turn_canceled", provider: this.providerName, reason: "permission denied" };
            await this.appendHistoryEvent(canceled);
            yield canceled;
            return;
          }

          const deniedCompleted: AgentStreamEvent = {
            type: "turn_completed",
            provider: this.providerName,
            usage: { inputTokens: 1, outputTokens: 0 },
          };
          await this.appendHistoryEvent(deniedCompleted);
          yield deniedCompleted;
          return;
        }

      }

      await this.applyToolSideEffects(tool.name, tool.input ?? {}, textPrompt);

      const toolCompleted: AgentStreamEvent = {
        type: "timeline",
        provider: this.providerName,
        item: {
          type: "tool_call",
          name: tool.name,
          callId,
          status: "completed",
          input: tool.input ?? undefined,
          output: tool.output ?? { ok: true },
        },
      };
      await this.appendHistoryEvent(toolCompleted);
      yield toolCompleted;
    }

    const assistantText = this.buildAssistantText(textPrompt);
    // Stream in two chunks to exercise client chunk coalescing.
    const assistantChunkA: AgentStreamEvent = {
      type: "timeline",
      provider: this.providerName,
      item: { type: "assistant_message", text: assistantText.slice(0, 6) },
    };
    await this.appendHistoryEvent(assistantChunkA);
    yield assistantChunkA;

    const assistantChunkB: AgentStreamEvent = {
      type: "timeline",
      provider: this.providerName,
      item: { type: "assistant_message", text: assistantText.slice(6) },
    };
    await this.appendHistoryEvent(assistantChunkB);
    yield assistantChunkB;

    const completed: AgentStreamEvent = {
      type: "turn_completed",
      provider: this.providerName,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    await this.appendHistoryEvent(completed);
    yield completed;
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    let contents: string;
    try {
      contents = await readFile(this.historyPath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      yield JSON.parse(trimmed) as AgentStreamEvent;
    }
  }

  async getRuntimeInfo() {
    return {
      provider: this.providerName,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [
      { id: "bypassPermissions", label: "Bypass", description: "No permissions" },
      { id: "default", label: "Default", description: "Ask for permissions" },
      { id: "full-access", label: "Full access", description: "No prompts" },
      { id: "auto", label: "Auto", description: "Ask/allow based on policy" },
    ];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.config.modeId ?? null;
  }

  async setMode(modeId: string): Promise<void> {
    this.config.modeId = modeId;
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return this.pendingPermissions;
  }

  async respondToPermission(_requestId: string, response: AgentPermissionResponse): Promise<void> {
    if (!this.permissionGate) {
      return;
    }
    this.permissionGate.resolve(response);
    this.permissionGate = null;
  }

  describePersistence(): AgentPersistenceHandle | null {
    return buildPersistence(this.providerName, this.id, this.memoryMarker ? { marker: this.memoryMarker } : undefined);
  }

  async interrupt(): Promise<void> {
    this.interruptSignal.resolve();
  }

  async close(): Promise<void> {}

  async listCommands(): Promise<AgentSlashCommand[]> {
    if (this.providerName === "codex") {
      const codexHome =
        process.env.CODEX_HOME ??
        path.join(process.env.HOME ?? "/tmp", ".codex");

      const commands: AgentSlashCommand[] = [];

      const promptsDir = path.join(codexHome, "prompts");
      try {
        for (const entry of readdirSync(promptsDir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith(".md")) continue;
          const name = entry.name.slice(0, -".md".length);
          commands.push({
            name: `prompts:${name}`,
            description: "Prompt command",
            argumentHint: "",
          });
        }
      } catch {
        // ignore missing dirs
      }

      const skillsDir = path.join(codexHome, "skills");
      try {
        for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          commands.push({
            name: entry.name,
            description: "Skill command",
            argumentHint: "",
          });
        }
      } catch {
        // ignore
      }

      return commands;
    }

    // claude/opencode: keep stable/deterministic.
    return [
      { name: "help", description: "Help", argumentHint: "" },
      { name: "context", description: "Context", argumentHint: "" },
    ];
  }

  async executeCommand(commandName: string, args?: string): Promise<AgentCommandResult> {
    const fullName = commandName.trim();
    if (this.providerName === "codex" && fullName.startsWith("prompts:")) {
      const promptId = fullName.slice("prompts:".length);
      return {
        text: `PASEO_OK ${args ?? ""}`.trim(),
        timeline: [{ type: "assistant_message", text: `PASEO_OK ${promptId}` }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }

    return {
      text: "PASEO_SKILL_OK",
      timeline: [{ type: "assistant_message", text: "PASEO_SKILL_OK" }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  private buildAssistantText(prompt: string): string {
    const lower = prompt.toLowerCase();
    if (lower.includes("state saved")) return "state saved";
    if (lower.includes("timeline test")) return "timeline test";
    if (lower.includes("quick brown fox") && lower.includes("lazy dog")) {
      return "The quick brown fox jumps over the lazy dog. Then the fox ran away.";
    }
    if (lower.includes("what did i ask you to say earlier")) return "You asked me to say state saved.";
    if (lower.includes("say 'timeline test'")) return "timeline test";
    if (lower.includes("say 'state saved'")) return "state saved";
    if (lower.includes("return schema-valid json") || lower.includes("schema-valid json")) {
      return JSON.stringify({ ok: true });
    }
    if (lower.includes("what was the marker") || lower.includes("what was the project name")) {
      return this.memoryMarker ?? "unknown";
    }
    if (lower.includes("stop")) return "Stopped.";
    return "Hello world";
  }

  private async applyToolSideEffects(
    toolName: string,
    toolInput: Record<string, unknown>,
    prompt: string
  ): Promise<void> {
    const lower = prompt.toLowerCase();

    if (toolName === "Read" || toolName === "read_file") {
      const p = typeof toolInput.path === "string" ? toolInput.path : "/etc/hosts";
      try {
        readFileSync(p, "utf8");
      } catch {
        // ignore - tests only assert tool call presence
      }
      return;
    }

    if (toolName === "Bash" || toolName === "shell") {
      const command = typeof toolInput.command === "string" ? toolInput.command : "";
      if (lower.includes("rm -f permission.txt") || command.includes("rm -f permission.txt")) {
        const dest = path.join(this.config.cwd ?? process.cwd(), "permission.txt");
        try {
          rmSync(dest, { force: true });
        } catch {
          // ignore
        }
        return;
      }

      if (lower.includes("rm -f mcp-smoke.txt") || command.includes("rm -f mcp-smoke.txt")) {
        const dest = path.join(this.config.cwd ?? process.cwd(), "mcp-smoke.txt");
        try {
          rmSync(dest, { force: true });
        } catch {
          // ignore
        }
        return;
      }

      if (lower.includes("printf") && lower.includes("permission.txt")) {
        const dest = path.join(this.config.cwd ?? process.cwd(), "permission.txt");
        writeFileSync(dest, "ok");
        return;
      }

      if (command.includes("sleep")) {
        // Simulate a long-running operation that can be interrupted.
        // Keep the duration small so tests stay fast.
        const interrupt = this.interruptSignal.promise.then(() => "interrupted" as const);
        const completed = new Promise<"completed">((resolve) => setTimeout(() => resolve("completed"), 250));
        const outcome = await Promise.race([interrupt, completed]);
        if (outcome === "interrupted") {
          return;
        }
        // Continue after "sleep" completes.
      }

      if (lower.includes("abort-test-file.txt")) {
        const dest = path.join(this.config.cwd ?? process.cwd(), "abort-test-file.txt");
        // Simulate a delayed write that should be prevented by interrupt().
        let interrupted = false;
        const interrupt = this.interruptSignal.promise.then(() => {
          interrupted = true;
        });
        await Promise.race([interrupt, new Promise((r) => setTimeout(r, 500))]);
        if (!interrupted) {
          writeFileSync(dest, "ok");
        }
        return;
      }

      if (lower.includes("printf") && lower.includes(">") && lower.includes(".txt")) {
        const destMatch = />\s*([^\s`]+)\s*$/i.exec(command) ?? />\s*([^\s`]+)/i.exec(lower);
        const fileName = destMatch?.[1];
        if (fileName) {
          const dest = path.join(this.config.cwd ?? process.cwd(), fileName);
          writeFileSync(dest, "ok");
          return;
        }
      }

      return;
    }

    if (toolName === "mcp__paseo-self-id__set_title") {
      const title = typeof toolInput.title === "string" ? toolInput.title : null;
      const server = (this.config.mcpServers as Record<string, any> | undefined)?.["paseo-self-id"];
      const args = Array.isArray(server?.args) ? (server.args as string[]) : [];
      const socketIndex = args.indexOf("--socket");
      const agentIndex = args.indexOf("--agent-id");
      const socketPath = socketIndex >= 0 ? args[socketIndex + 1] : null;
      const callerAgentId = agentIndex >= 0 ? args[agentIndex + 1] : null;

      if (!title || !socketPath || !callerAgentId) {
        throw new Error("FakeAgentSession missing paseo-self-id MCP config");
      }

      await callSelfIdMcpTool({
        socketPath,
        callerAgentId,
        toolName: "set_title",
        args: { title },
      });
      return;
    }

    if (toolName === "Edit" || toolName === "apply_patch") {
      const match = /edit the file\s+([^\s]+)\s+and change/i.exec(prompt);
      const filePath = match?.[1];
      if (filePath) {
        try {
          const before = readFileSync(filePath, "utf8");
          const after = before.replace(/hello/g, "goodbye");
          writeFileSync(filePath, after);
        } catch {
          // ignore
        }
      }
      return;
    }
  }

  private needsPermissionForTool(toolName: string, toolInput: Record<string, unknown>): boolean {
    const mode = (this.config.modeId ?? "").toLowerCase();
    const policy = (this.config.approvalPolicy ?? "").toLowerCase();

    if (policy === "never" || mode.includes("bypass") || mode.includes("full")) {
      return false;
    }

    if (toolName.startsWith("mcp__")) {
      return true;
    }

    // In "auto" we only require permission for writes/edits; simple commands like sleep are allowed.
    if (mode.includes("auto")) {
      if (toolName === "Edit" || toolName === "apply_patch") {
        return true;
      }
      if (toolName === "Bash" || toolName === "shell") {
        const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
        const writes = cmd.includes(">") || cmd.includes("rm ") || cmd.includes("mv ") || cmd.includes("cp ");
        return writes;
      }
      return false;
    }

    // Default/read-only/etc: ask for everything.
    return isAskMode(this.config);
  }
}

class FakeAgentClient implements AgentClient {
  readonly capabilities = TEST_CAPABILITIES;
  constructor(public readonly provider: string) {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new FakeAgentSession(this.provider, { ...config });
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>
  ): Promise<AgentSession> {
    const cfg: AgentSessionConfig = {
      provider: this.provider,
      cwd: overrides?.cwd ?? process.cwd(),
      ...overrides,
    };
    const marker =
      (handle.metadata as Record<string, unknown> | undefined)?.marker ??
      (handle.metadata as Record<string, unknown> | undefined)?.conversationId ??
      null;
    return new FakeAgentSession(
      this.provider,
      cfg,
      handle.sessionId,
      typeof marker === "string" ? marker : null
    );
  }

  async listModels(_options?: ListModelsOptions): Promise<AgentModelDefinition[]> {
    return [
      { provider: this.provider, id: "test-model", label: "Test Model", isDefault: true },
    ];
  }
}

export function createTestAgentClients(): Record<string, AgentClient> {
  return {
    claude: new FakeAgentClient("claude"),
    codex: new FakeAgentClient("codex"),
    opencode: new FakeAgentClient("opencode"),
  };
}
