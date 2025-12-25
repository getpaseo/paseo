import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, URL } from "node:url";

import {
  query,
  type ModelInfo,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  AgentModelDefinition,
  AgentProvider,
} from "./agent-sdk-types.js";

type ProviderModelCatalogOptions = {
  cwd?: string;
};

type ClaudeModelInfo = ModelInfo;
type ClaudeOptions = Options;

export async function fetchProviderModelCatalog(
  provider: AgentProvider,
  options?: ProviderModelCatalogOptions
): Promise<AgentModelDefinition[]> {
  if (provider === "claude") {
    return fetchClaudeModelCatalog(options);
  }
  if (provider === "codex" || provider === "codex-mcp") {
    return fetchCodexModelCatalog();
  }
  throw new Error(`Unsupported provider '${provider}'`);
}

export async function fetchClaudeModelCatalog(
  options?: ProviderModelCatalogOptions
): Promise<AgentModelDefinition[]> {
  const prompt = emptySdkMessageStream();
  const claudeOptions: ClaudeOptions = {
    cwd: options?.cwd ?? process.cwd(),
    permissionMode: "plan",
    includePartialMessages: false,
  };

  const claudeQuery = query({ prompt, options: claudeOptions });
  try {
    const models: ClaudeModelInfo[] = await claudeQuery.supportedModels();
    return models.map((model) => ({
      provider: "claude",
      id: model.value,
      label: model.displayName,
      description: model.description,
      metadata: {
        description: model.description,
      },
    }));
  } finally {
    if (typeof claudeQuery.return === "function") {
      try {
        await claudeQuery.return();
      } catch {
        // ignore shutdown errors
      }
    }
  }
}

export async function fetchCodexModelCatalog(): Promise<AgentModelDefinition[]> {
  const binaryPath = resolveCodexBinary();
  const child = spawn(binaryPath, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  assertChildHasPipes(child);

  const client = new CodexAppServerClient(child);

  try {
    await client.request("initialize", {
      clientInfo: {
        name: "voice-dev",
        title: "Voice Dev",
        version: "0.0.0",
      },
    });

    const response = await client.request("model/list", {});
    if (!isCodexModelListResponse(response)) {
      throw new Error("Unexpected Codex model list response");
    }
    return response.data.map((model) => ({
      provider: "codex",
      id: model.id,
      label: model.displayName,
      description: model.description,
      isDefault: model.isDefault,
      metadata: {
        model: model.model,
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: model.supportedReasoningEfforts,
      },
    }));
  } finally {
    await client.dispose();
  }
}

function emptySdkMessageStream(): AsyncIterable<SDKUserMessage> {
  return (async function* empty() {})();
}

function resolveCodexBinary(): string {
  const repoRoot = path.resolve(
    fileURLToPath(new URL("../../../../..", import.meta.url))
  );
  const packageRoot = path.join(repoRoot, "node_modules", "@openai", "codex-sdk");
  const vendorDir = path.join(packageRoot, "vendor");

  const { platform, arch } = process;
  const triples: { [key: string]: string } = {
    "darwin:x64": "x86_64-apple-darwin",
    "darwin:arm64": "aarch64-apple-darwin",
    "linux:x64": "x86_64-unknown-linux-musl",
    "linux:arm64": "aarch64-unknown-linux-musl",
    "win32:x64": "x86_64-pc-windows-msvc",
    "win32:arm64": "aarch64-pc-windows-msvc",
  };
  const triple = triples[`${platform}:${arch}`];
  if (!triple) {
    throw new Error(`Unsupported Codex platform: ${platform} (${arch})`);
  }
  const binary = platform === "win32" ? "codex.exe" : "codex";
  return path.join(vendorDir, triple, "codex", binary);
}

type CodexModelListResponse = {
  data: CodexModelInfo[];
  nextCursor: string | null;
};

type CodexModelInfo = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  isDefault: boolean;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function assertChildHasPipes(
  child: ChildProcess
): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Codex app-server must be started with stdio pipes");
  }
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

function isCodexModelInfo(value: unknown): value is CodexModelInfo {
  if (!isObject(value)) {
    return false;
  }
  if (typeof value.id !== "string") {
    return false;
  }
  if (typeof value.model !== "string") {
    return false;
  }
  if (typeof value.displayName !== "string") {
    return false;
  }
  if (typeof value.description !== "string") {
    return false;
  }
  if (typeof value.defaultReasoningEffort !== "string") {
    return false;
  }
  if (typeof value.isDefault !== "boolean") {
    return false;
  }
  if (!Array.isArray(value.supportedReasoningEfforts)) {
    return false;
  }
  for (const entry of value.supportedReasoningEfforts) {
    if (!isObject(entry)) {
      return false;
    }
    if (typeof entry.reasoningEffort !== "string") {
      return false;
    }
    if (typeof entry.description !== "string") {
      return false;
    }
  }
  return true;
}

function isCodexModelListResponse(
  value: unknown
): value is CodexModelListResponse {
  if (!isObject(value)) {
    return false;
  }
  if (!Array.isArray(value.data)) {
    return false;
  }
  if (value.nextCursor !== null && typeof value.nextCursor !== "string") {
    return false;
  }
  return value.data.every((entry) => isCodexModelInfo(entry));
}

class CodexAppServerClient {
  private readonly rl: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stderrBuffer = "";
  private disposed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk;
    });

    child.on("exit", (code, signal) => {
      if (this.disposed) {
        return;
      }
      const message = code === 0
        ? "Codex app-server exited"
        : `Codex app-server exited with code ${code ?? "null"} and signal ${signal ?? "null"}`;
      const error = new Error(this.stderrBuffer || message);
      this.rejectAll(error);
    });
  }

  async request(
    method: string,
    params: { [key: string]: unknown }
  ): Promise<unknown> {
    if (this.disposed) {
      throw new Error("Codex app-server client is closed");
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    this.child.stdin.write(payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) {
          return;
        }
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for '${method}' response`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rl.close();
    if (this.child.stdin && !this.child.killed) {
      this.child.stdin.end();
      setTimeout(() => {
        if (this.child.exitCode === null && !this.child.killed) {
          this.child.kill("SIGINT");
        }
      }, 100);
    }
  }

  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.stderrBuffer += `\n[stdout] ${trimmed}`;
      return;
    }

    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? "Codex RPC error");
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    // ignore notifications
  }

  private rejectAll(error: Error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
