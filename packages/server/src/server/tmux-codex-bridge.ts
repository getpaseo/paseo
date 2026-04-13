import { basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { v5 as uuidv5 } from "uuid";
import type { Logger } from "pino";

import type {
  AgentMetadata,
  AgentPersistenceHandle,
  AgentSessionConfig,
} from "./agent/agent-sdk-types.js";

const execFileAsync = promisify(execFile);

const TMUX_CODEX_AGENT_NAMESPACE = "f11f95f0-a9ab-4b85-a8b7-bfac26a3038e";
const TMUX_CODEX_SOURCE = "tmux_codex";

export interface UnixProcessRow {
  pid: number;
  ppid: number;
  args: string;
}

export interface TmuxPaneRow {
  paneId: string;
  sessionName: string;
  windowId: string;
  paneTitle: string;
  panePid: number;
  paneTty: string;
  cwd: string;
}

export interface TmuxCodexPaneDescriptor extends TmuxPaneRow {
  processPid: number;
  processArgs: string;
  codexSessionId: string | null;
}

export interface TmuxCodexPaneSnapshot extends TmuxCodexPaneDescriptor {
  agentId: string;
  title: string;
  config: AgentSessionConfig;
  persistenceHandle: AgentPersistenceHandle;
}

export function parseTmuxListPanesOutput(raw: string): TmuxPaneRow[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [paneId, sessionName, windowId, paneTitle, panePidRaw, paneTty, cwd] = line.split("\t");
      return {
        paneId,
        sessionName,
        windowId,
        paneTitle,
        panePid: Number(panePidRaw),
        paneTty,
        cwd,
      };
    })
    .filter((row) => row.paneId && Number.isInteger(row.panePid) && row.cwd);
}

export function parseUnixProcessTable(raw: string): UnixProcessRow[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        args: match[3],
      } satisfies UnixProcessRow;
    })
    .filter((row): row is UnixProcessRow => row !== null);
}

function isCodexCommand(args: string): boolean {
  return /\bcodex\b/.test(args) || /@openai\/codex/.test(args) || /\/codex\/codex(\s|$)/.test(args);
}

function extractCodexSessionId(args: string): string | null {
  const match = args.match(/\bresume\s+([0-9a-zA-Z-]{8,})\b/);
  return match ? match[1] : null;
}

function normalizeTmuxPaneTitle(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function collectDescendantProcesses(input: {
  rootPid: number;
  childrenByParentPid: Map<number, UnixProcessRow[]>;
}): UnixProcessRow[] {
  const queue = [input.rootPid];
  const descendants: UnixProcessRow[] = [];

  while (queue.length > 0) {
    const pid = queue.shift()!;
    const children = input.childrenByParentPid.get(pid) ?? [];
    for (const child of children) {
      descendants.push(child);
      queue.push(child.pid);
    }
  }

  return descendants;
}

export function resolveTmuxCodexPaneDescriptors(input: {
  panes: TmuxPaneRow[];
  processes: UnixProcessRow[];
}): TmuxCodexPaneDescriptor[] {
  const childrenByParentPid = new Map<number, UnixProcessRow[]>();
  for (const process of input.processes) {
    const children = childrenByParentPid.get(process.ppid) ?? [];
    children.push(process);
    childrenByParentPid.set(process.ppid, children);
  }

  return input.panes.flatMap((pane) => {
    const descendants = collectDescendantProcesses({
      rootPid: pane.panePid,
      childrenByParentPid,
    });
    const codexProcess = descendants.find((process) => isCodexCommand(process.args));
    if (!codexProcess) {
      return [];
    }

    return [
      {
        ...pane,
        processPid: codexProcess.pid,
        processArgs: codexProcess.args,
        codexSessionId: extractCodexSessionId(codexProcess.args),
      } satisfies TmuxCodexPaneDescriptor,
    ];
  });
}

function buildTmuxCodexMetadata(descriptor: TmuxCodexPaneDescriptor): AgentMetadata {
  return {
    externalSessionSource: TMUX_CODEX_SOURCE,
    paneId: descriptor.paneId,
    sessionName: descriptor.sessionName,
    windowId: descriptor.windowId,
    paneTitle: descriptor.paneTitle,
    panePid: descriptor.panePid,
    paneTty: descriptor.paneTty,
    cwd: descriptor.cwd,
    processPid: descriptor.processPid,
    processArgs: descriptor.processArgs,
    codexSessionId: descriptor.codexSessionId,
  };
}

export function buildTmuxCodexPaneSnapshot(
  descriptor: TmuxCodexPaneDescriptor,
): TmuxCodexPaneSnapshot {
  const paneKey = `${descriptor.sessionName}:${descriptor.windowId}:${descriptor.paneId}`;
  const agentId = uuidv5(paneKey, TMUX_CODEX_AGENT_NAMESPACE);
  const repoName = basename(descriptor.cwd);
  const title =
    normalizeTmuxPaneTitle(descriptor.paneTitle) ?? `${repoName} [tmux:${descriptor.paneId}]`;
  const metadata = buildTmuxCodexMetadata(descriptor);

  return {
    ...descriptor,
    agentId,
    title,
    config: {
      provider: "codex",
      cwd: descriptor.cwd,
      modeId: "auto",
      title,
      extra: {
        codex: {
          externalSessionSource: TMUX_CODEX_SOURCE,
          paneId: descriptor.paneId,
        },
      },
    },
    persistenceHandle: {
      provider: "codex",
      sessionId: descriptor.codexSessionId ?? descriptor.paneId,
      metadata,
    },
  };
}

export interface TmuxCodexCommandRunner {
  execFile(file: string, args: string[]): Promise<string>;
}

export function createTmuxCodexCommandRunner(): TmuxCodexCommandRunner {
  return {
    async execFile(file: string, args: string[]): Promise<string> {
      const { stdout } = await execFileAsync(file, args, { encoding: "utf8" });
      return stdout;
    },
  };
}

export async function discoverTmuxCodexPaneSnapshots(input?: {
  runner?: TmuxCodexCommandRunner;
}): Promise<TmuxCodexPaneSnapshot[]> {
  const runner = input?.runner ?? createTmuxCodexCommandRunner();
  const [tmuxRaw, psRaw] = await Promise.all([
    runner.execFile("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{session_name}\t#{window_id}\t#{pane_title}\t#{pane_pid}\t#{pane_tty}\t#{pane_current_path}",
    ]),
    runner.execFile("ps", ["-eo", "pid=,ppid=,args="]),
  ]);

  const descriptors = resolveTmuxCodexPaneDescriptors({
    panes: parseTmuxListPanesOutput(tmuxRaw),
    processes: parseUnixProcessTable(psRaw),
  });

  return descriptors.map((descriptor) => buildTmuxCodexPaneSnapshot(descriptor));
}

export function isTmuxCodexHandle(handle: AgentPersistenceHandle | null | undefined): boolean {
  return handle?.metadata?.externalSessionSource === TMUX_CODEX_SOURCE;
}

export function readTmuxCodexPaneId(handle: AgentPersistenceHandle): string {
  const paneId = typeof handle.metadata?.paneId === "string" ? handle.metadata.paneId : null;
  if (!paneId) {
    throw new Error("tmux codex handle missing paneId");
  }
  return paneId;
}

export class TmuxCodexBridge {
  private readonly logger: Logger;
  private readonly runner: TmuxCodexCommandRunner;

  constructor(input: { logger: Logger; runner?: TmuxCodexCommandRunner }) {
    this.logger = input.logger.child({ module: "tmux-codex-bridge" });
    this.runner = input.runner ?? createTmuxCodexCommandRunner();
  }

  async discover(): Promise<TmuxCodexPaneSnapshot[]> {
    try {
      return await discoverTmuxCodexPaneSnapshots({ runner: this.runner });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to discover tmux codex panes");
      return [];
    }
  }
}
