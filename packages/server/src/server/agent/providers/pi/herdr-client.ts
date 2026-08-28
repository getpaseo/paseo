import { spawn } from "node:child_process";

export interface HerdrAgent {
  target: string;
  id?: string;
  name?: string;
  kind: string | null;
  status: string | null;
  cwd: string | null;
  paneId?: string;
  nativeSessionId: string | null;
  nativeSessionFile: string | null;
  lastActivityAt: Date | null;
}

export interface HerdrClient {
  listAgents(): Promise<HerdrAgent[]>;
  getAgent(target: string): Promise<HerdrAgent>;
  prompt(target: string, text: string): Promise<void>;
  interrupt(target: string): Promise<void>;
  read(target: string, options?: { lines?: number }): Promise<string>;
}

interface HerdrCliClientOptions {
  command?: [string, ...string[]];
  session?: string;
  timeoutMs?: number;
  interruptKeys?: string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INTERRUPT_KEYS = ["ctrl+c"];

export class HerdrCliClient implements HerdrClient {
  private readonly command: [string, ...string[]];
  private readonly session?: string;
  private readonly timeoutMs: number;
  private readonly interruptKeys: string[];

  constructor(options: HerdrCliClientOptions = {}) {
    this.command = options.command ?? ["herdr"];
    this.session = options.session?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.interruptKeys = options.interruptKeys?.length
      ? options.interruptKeys
      : DEFAULT_INTERRUPT_KEYS;
  }

  async listAgents(): Promise<HerdrAgent[]> {
    const result = await this.run(["agent", "list"]);
    return parseHerdrAgentListPayload(parseJsonOutput(result.stdout));
  }

  async getAgent(target: string): Promise<HerdrAgent> {
    const result = await this.run(["agent", "get", target]);
    return parseHerdrAgentPayload(parseJsonOutput(result.stdout));
  }

  async prompt(target: string, text: string): Promise<void> {
    await this.run(["agent", "prompt", target, text]);
  }

  async interrupt(target: string): Promise<void> {
    await this.run(["agent", "send-keys", target, ...this.interruptKeys]);
  }

  async read(target: string, options: { lines?: number } = {}): Promise<string> {
    const lines = options.lines ?? 80;
    const result = await this.run([
      "agent",
      "read",
      target,
      "--source",
      "recent-unwrapped",
      "--lines",
      String(lines),
      "--format",
      "text",
    ]);
    return result.stdout;
  }

  private async run(args: string[]): Promise<CommandResult> {
    const fullArgs = [...this.command.slice(1), ...args];
    if (this.session) {
      fullArgs.push("--session", this.session);
    }

    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(this.command[0], fullArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Herdr command timed out after ${this.timeoutMs}ms: ${args.join(" ")}`));
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(
          new Error(
            `Herdr command failed (${signal ?? code ?? "unknown"}): ${args.join(" ")}${stderr ? `\n${stderr.trim()}` : ""}`,
          ),
        );
      });
    });
  }
}

export function parseHerdrAgentListPayload(payload: unknown): HerdrAgent[] {
  const root = unwrapHerdrResult(payload);
  const agentField = readField(root, "agents");
  const agents = Array.isArray(agentField) ? agentField : root;
  if (!Array.isArray(agents)) {
    return [];
  }
  return agents.flatMap((agent) => {
    const parsed = parseHerdrAgentRecord(agent);
    return parsed ? [parsed] : [];
  });
}

export function parseHerdrAgentPayload(payload: unknown): HerdrAgent {
  const root = unwrapHerdrResult(payload);
  const agent = readRecordField(root, "agent") ?? root;
  const parsed = parseHerdrAgentRecord(agent);
  if (!parsed) {
    throw new Error("Herdr agent payload did not contain an agent");
  }
  return parsed;
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Herdr command returned no output");
  }
  return JSON.parse(trimmed) as unknown;
}

function parseHerdrAgentRecord(value: unknown): HerdrAgent | null {
  if (!isRecord(value)) {
    return null;
  }

  const agentSession =
    readRecordField(value, "agent_session") ??
    readRecordField(value, "agentSession") ??
    readRecordField(value, "session");
  const target = readFirstString(value, ["target", "name", "alias", "id", "pane_id", "paneId"]);
  if (!target) {
    return null;
  }

  const id = readString(value, "id");
  const name = readString(value, "name");
  const paneId = readFirstString(value, ["paneId", "pane_id"]);
  return {
    target,
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    kind: readFirstString(value, ["kind", "agent_kind", "provider", "type"]),
    status: readFirstString(value, ["status", "lifecycle", "state"]),
    cwd: readFirstString(value, ["cwd", "working_directory", "workingDirectory"], agentSession, [
      "cwd",
    ]),
    ...(paneId ? { paneId } : {}),
    nativeSessionId: readFirstString(
      value,
      ["nativeSessionId", "native_session_id", "session_id"],
      agentSession,
      ["id", "sessionId", "session_id"],
    ),
    nativeSessionFile: readFirstString(
      value,
      ["nativeSessionFile", "native_session_file", "session_file", "sessionFile"],
      agentSession,
      ["file", "path", "sessionFile", "session_file"],
    ),
    lastActivityAt: readDate(value, "lastActivityAt") ?? readDate(value, "last_activity_at"),
  };
}

function unwrapHerdrResult(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  return readRecordField(payload, "result") ?? payload;
}

function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readRecordField(value: unknown, key: string): Record<string, unknown> | null {
  const field = readField(value, key);
  return isRecord(field) ? field : null;
}

function readFirstString(
  primary: unknown,
  primaryKeys: readonly string[],
  secondary?: unknown,
  secondaryKeys: readonly string[] = [],
): string | null {
  for (const key of primaryKeys) {
    const value = readString(primary, key);
    if (value) {
      return value;
    }
  }
  for (const key of secondaryKeys) {
    const value = readString(secondary, key);
    if (value) {
      return value;
    }
  }
  return null;
}

function readString(value: unknown, key: string): string | null {
  const field = readField(value, key);
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function readDate(value: unknown, key: string): Date | null {
  const field = readField(value, key);
  if (typeof field !== "string" && typeof field !== "number") {
    return null;
  }
  const date = new Date(field);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
