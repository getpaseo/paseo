import type { Logger } from "pino";
import { findExecutable } from "../../../utils/executable.js";
import { spawnProcess } from "../../../utils/spawn.js";

export interface JulesCliOptions {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  logger: Logger;
}

export interface JulesActivity {
  id: string;
  type: string;
  createdAt: string;
  payload: unknown;
}

export interface JulesSessionSnapshot {
  id: string;
  status: "QUEUED" | "RUNNING" | "AWAITING_INPUT" | "COMPLETED" | "FAILED" | string;
  repo: string;
  branch?: string;
  prUrl?: string;
  prTitle?: string;
  activities: JulesActivity[];
}

export class JulesCliFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JulesCliFormatError";
  }
}

interface JulesCommandResult {
  stdout: string;
  stderr: string;
}

function parseJulesTableRows(stdout: string): string[][] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("-"))
    .map((line) => line.replace(/\s{2,}/gu, "\t").split("\t").map((cell) => cell.trim()))
    .filter((row) => /^\d{8,}$/u.test(row[0] ?? ""));
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function mapActivity(value: unknown): JulesActivity | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = safeString(row.id) ?? safeString(row.activityId);
  if (!id) return null;
  return {
    id,
    type: safeString(row.type) ?? "unknown",
    createdAt: safeString(row.createdAt) ?? new Date(0).toISOString(),
    payload: row.payload ?? row,
  };
}

function mapSnapshot(value: unknown): JulesSessionSnapshot {
  if (!value || typeof value !== "object") {
    throw new JulesCliFormatError("Jules CLI returned non-object snapshot");
  }
  const row = value as Record<string, unknown>;
  const id = safeString(row.id) ?? safeString(row.sessionId);
  if (!id) {
    throw new JulesCliFormatError("Jules CLI snapshot missing session id");
  }
  const activitiesRaw = Array.isArray(row.activities) ? row.activities : [];
  return {
    id,
    status: safeString(row.status) ?? "RUNNING",
    repo: safeString(row.repo) ?? "",
    branch: safeString(row.branch),
    prUrl: safeString(row.prUrl),
    prTitle: safeString(row.prTitle),
    activities: activitiesRaw.map(mapActivity).filter((entry): entry is JulesActivity => entry !== null),
  };
}

export class JulesCli {
  private readonly binaryPath?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly logger: Logger;

  constructor(opts: JulesCliOptions) {
    this.binaryPath = opts.binaryPath;
    this.env = opts.env;
    this.logger = opts.logger.child({ module: "jules-cli" });
  }

  async authStatus(): Promise<{ loggedIn: boolean; account?: string; diagnostic?: string }> {
    const list = await this.execAllowFailure(["remote", "list", "--session"]);
    if (list.ok) {
      return { loggedIn: true };
    }
    return {
      loggedIn: false,
      diagnostic: [list.stderr, list.stdout].filter(Boolean).join("\n"),
    };
  }

  async version(): Promise<string> {
    const result = await this.exec(["version"]);
    return result.stdout.trim();
  }

  async remoteNew(args: { repo: string; prompt: string }): Promise<{ sessionId: string }> {
    const result = await this.exec([
      "remote",
      "new",
      "--repo",
      args.repo,
      "--session",
      args.prompt,
    ]);
    const sessionId = result.stdout.match(/\b\d{8,}\b/u)?.[0];
    if (!sessionId) {
      throw new JulesCliFormatError("Jules remote new response missing session id");
    }
    return { sessionId };
  }

  async remoteList(): Promise<JulesSessionSnapshot[]> {
    const result = await this.exec(["remote", "list", "--session"]);
    const rows = parseJulesTableRows(result.stdout);
    return rows.map((row) =>
      mapSnapshot({
        id: row[0],
        repo: row[2],
        status: row[4] || "RUNNING",
        activities: [],
      }),
    );
  }

  async remotePull(sessionId: string): Promise<JulesSessionSnapshot> {
    const result = await this.exec(["remote", "pull", "--session", sessionId]);
    const prUrl = result.stdout.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/u)?.[0];
    const branch = result.stdout.match(/branch:\s*([^\s]+)/iu)?.[1];
    const existing = await this.remoteList();
    const listSnapshot = existing.find((entry) => entry.id === sessionId);
    if (!listSnapshot) {
      return {
        id: sessionId,
        status: "RUNNING",
        repo: "",
        branch,
        prUrl,
        activities: [],
      };
    }
    return {
      ...listSnapshot,
      branch: branch ?? listSnapshot.branch,
      prUrl: prUrl ?? listSnapshot.prUrl,
    };
  }

  private async resolveBinaryPath(): Promise<string> {
    if (this.binaryPath) return this.binaryPath;
    const resolved = await findExecutable("jules");
    if (!resolved) {
      throw new Error("Jules CLI binary not found. Install Jules CLI and run `jules login`.");
    }
    return resolved;
  }

  private async exec(args: string[]): Promise<JulesCommandResult> {
    const result = await this.execAllowFailure(args);
    if (!result.ok) {
      throw new Error(result.stderr || `Jules command failed: ${args.join(" ")}`);
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  private async execAllowFailure(args: string[]): Promise<JulesCommandResult & { ok: boolean }> {
    const binary = await this.resolveBinaryPath();
    return new Promise((resolve, reject) => {
      const child = spawnProcess(binary, args, {
        env: { ...process.env, ...this.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        this.logger.trace({ args, code }, "jules command completed");
        resolve({ ok: code === 0, stdout, stderr });
      });
    });
  }
}
