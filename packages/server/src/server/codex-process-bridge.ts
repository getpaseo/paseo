import { readlink } from "node:fs/promises";
import { basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { v5 as uuidv5 } from "uuid";
import type { Logger } from "pino";
import stripAnsi from "strip-ansi";

import type { AgentPersistenceHandle, AgentSessionConfig } from "./agent/agent-sdk-types.js";

const execFileAsync = promisify(execFile);

const CODEX_PROCESS_AGENT_NAMESPACE = "5310b8dd-2603-47c7-97ef-a59e51b59871";
const CODEX_PROCESS_SOURCE = "codex_process";
const MAX_CAPTURE_BYTES = "262144";

export interface UnixProcessWithTty {
  pid: number;
  ppid: number;
  tty: string | null;
  args: string;
}

export interface CodexProcessDescriptor {
  agentId: string;
  tty: string;
  cwd: string;
  leaderPid: number;
  sessionId: string | null;
  logPath: string | null;
  processArgs: string;
  title: string;
  config: AgentSessionConfig;
  persistenceHandle: AgentPersistenceHandle;
}

export interface CodexProcessRunner {
  execFile(file: string, args: string[]): Promise<string>;
}

export function parseUnixProcessTableWithTty(raw: string): UnixProcessWithTty[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        tty: match[3] === "?" ? null : `/dev/${match[3]}`,
        args: match[4],
      } satisfies UnixProcessWithTty;
    })
    .filter((row): row is UnixProcessWithTty => row !== null);
}

function isCodexProcess(args: string): boolean {
  const trimmed = args.trim();
  if (/^script\s+-qefc\b/.test(trimmed)) {
    return false;
  }
  return (
    /^node(?:js)?\s+(?:\S*\/)?codex(?:\s|$)/.test(trimmed) ||
    /^(?:\S*\/)?codex(?:\s|$)/.test(trimmed)
  );
}

function extractSessionId(args: string): string | null {
  const match = args.match(/\bresume\s+([0-9a-zA-Z-]{8,})\b/);
  return match ? match[1] : null;
}

function findCodexScriptAncestor(input: {
  process: UnixProcessWithTty;
  processByPid: Map<number, UnixProcessWithTty>;
}): { process: UnixProcessWithTty; logPath: string } | null {
  let current: UnixProcessWithTty | undefined = input.process;
  while (current) {
    const match = current.args.match(/script -qefc .*? (\/tmp\/codex-429-retry\.[^ ]+\.log)\b/);
    if (match?.[1]) {
      return {
        process: current,
        logPath: match[1],
      };
    }
    current = input.processByPid.get(current.ppid);
  }
  return null;
}

export function readCodexProcessLogPath(input: {
  process: UnixProcessWithTty;
  processByPid: Map<number, UnixProcessWithTty>;
}): string | null {
  return findCodexScriptAncestor(input)?.logPath ?? null;
}

function buildAgentId(input: { tty: string; sessionId: string | null; leaderPid: number }): string {
  const stableKey = input.sessionId
    ? `${input.tty}:${input.sessionId}`
    : `${input.tty}:pid:${input.leaderPid}`;
  return uuidv5(stableKey, CODEX_PROCESS_AGENT_NAMESPACE);
}

function isDeletedCwd(cwd: string): boolean {
  return /\s+\(deleted\)$/.test(cwd.trim());
}

export async function discoverCodexProcessDescriptors(input: {
  processes: UnixProcessWithTty[];
  resolveCwd: (pid: number) => Promise<string>;
}): Promise<CodexProcessDescriptor[]> {
  const processByPid = new Map(input.processes.map((process) => [process.pid, process]));
  const codexProcesses = input.processes.filter(
    (process) => process.tty && isCodexProcess(process.args),
  );
  const chosenByTty = new Map<string, UnixProcessWithTty>();

  for (const process of codexProcesses) {
    const tty = process.tty!;
    const existing = chosenByTty.get(tty);
    if (!existing || process.pid > existing.pid) {
      chosenByTty.set(tty, process);
    }
  }

  const descriptors: CodexProcessDescriptor[] = [];
  for (const process of chosenByTty.values()) {
    const tty = process.tty!;
    const sessionId = extractSessionId(process.args);
    let cwd: string;
    try {
      cwd = await input.resolveCwd(process.pid);
    } catch {
      continue;
    }
    if (!cwd.trim() || isDeletedCwd(cwd)) {
      continue;
    }
    const scriptAncestor = findCodexScriptAncestor({ process, processByPid });
    if (scriptAncestor?.process.tty && scriptAncestor.process.tty !== tty) {
      continue;
    }
    const logPath = scriptAncestor?.logPath ?? null;
    const title = `${basename(cwd)} [${tty.replace("/dev/", "")}]`;
    const metadata = {
      externalSessionSource: CODEX_PROCESS_SOURCE,
      tty,
      cwd,
      leaderPid: process.pid,
      processArgs: process.args,
      sessionId,
      logPath,
    };

    descriptors.push({
      agentId: buildAgentId({ tty, sessionId, leaderPid: process.pid }),
      tty,
      cwd,
      leaderPid: process.pid,
      sessionId,
      logPath,
      processArgs: process.args,
      title,
      config: {
        provider: "codex",
        cwd,
        modeId: "auto",
        title,
        extra: {
          codex: {
            externalSessionSource: CODEX_PROCESS_SOURCE,
            tty,
          },
        },
      },
      persistenceHandle: {
        provider: "codex",
        sessionId: sessionId ?? tty,
        metadata,
      },
    });
  }

  return descriptors;
}

export function isCodexProcessHandle(handle: AgentPersistenceHandle | null | undefined): boolean {
  return handle?.metadata?.externalSessionSource === CODEX_PROCESS_SOURCE;
}

export function createCodexProcessRunner(): CodexProcessRunner {
  return {
    async execFile(file: string, args: string[]): Promise<string> {
      const { stdout } = await execFileAsync(file, args, { encoding: "utf8" });
      return stdout;
    },
  };
}

export function sanitizeCodexProcessCapture(text: string): string {
  return stripAnsi(text).replace(/\r\n/g, "\n");
}

export class CodexProcessBridge {
  private readonly logger: Logger;
  private readonly runner: CodexProcessRunner;

  constructor(input: { logger: Logger; runner?: CodexProcessRunner }) {
    this.logger = input.logger.child({ module: "codex-process-bridge" });
    this.runner = input.runner ?? createCodexProcessRunner();
  }

  async discover(): Promise<CodexProcessDescriptor[]> {
    try {
      const processRaw = await this.runner.execFile("ps", ["-eo", "pid=,ppid=,tty=,args="]);
      return await discoverCodexProcessDescriptors({
        processes: parseUnixProcessTableWithTty(processRaw),
        resolveCwd: async (pid) => readlink(`/proc/${pid}/cwd`),
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to discover codex processes");
      return [];
    }
  }

  async capture(logPath: string | null): Promise<string> {
    if (!logPath) {
      return "";
    }
    try {
      return sanitizeCodexProcessCapture(
        await this.runner.execFile("tail", ["-c", MAX_CAPTURE_BYTES, logPath]),
      );
    } catch {
      return "";
    }
  }

  async sendInput(tty: string, text: string): Promise<void> {
    await this.runner.execFile("python3", [
      "-c",
      "from pathlib import Path; import sys; Path(sys.argv[1]).write_text(sys.argv[2], encoding='utf-8')",
      tty,
      text,
    ]);
  }

  async isAlive(pid: number): Promise<boolean> {
    try {
      const stdout = await this.runner.execFile("ps", ["-p", String(pid), "-o", "pid="]);
      return stdout.trim() === String(pid);
    } catch {
      return false;
    }
  }
}
