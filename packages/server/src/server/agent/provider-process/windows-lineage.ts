import { z } from "zod";
import { execCommand } from "../../../utils/spawn.js";
import { windowsPowerShellPath } from "../../managed-processes/managed-processes.js";

// Windows does not reparent: a process keeps its parent's PID after the parent exits. A process
// whose parent PID matches is a child only if it started after that parent, which rules out a
// reused PID. When a shell between the provider and a command exits too, the walk from the
// provider breaks, so descendants are also recorded while the provider runs.
const RECORD_INTERVAL_MS = 5_000;
const QUERY_TIMEOUT_MS = 15_000;

const WindowsProcessSchema = z.object({
  ProcessId: z.number().int().nonnegative(),
  ParentProcessId: z.number().int().nonnegative(),
  CreatedMs: z.number(),
});
const WindowsProcessListSchema = z.union([WindowsProcessSchema, z.array(WindowsProcessSchema)]);

export interface WindowsProcess {
  pid: number;
  ppid: number;
  createdMs: number;
}

export async function listWindowsProcesses(): Promise<WindowsProcess[]> {
  const command = [
    "Get-CimInstance Win32_Process |",
    "Select-Object ProcessId,ParentProcessId,",
    "@{n='CreatedMs';e={[double]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds}} |",
    "ConvertTo-Json -Compress",
  ].join(" ");
  const { stdout } = await execCommand(
    windowsPowerShellPath(),
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { envMode: "internal", timeout: QUERY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = WindowsProcessListSchema.parse(JSON.parse(stdout));
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((entry) => ({
    pid: entry.ProcessId,
    ppid: entry.ParentProcessId,
    createdMs: entry.CreatedMs,
  }));
}

/** Processes descended from `roots` in `table`, each started no earlier than its parent. */
export function walkWindowsDescendants(
  table: WindowsProcess[],
  roots: ReadonlyMap<number, number>,
): Map<number, number> {
  const found = new Map(roots);
  let added = true;
  while (added) {
    added = false;
    for (const entry of table) {
      const parentCreatedMs = found.get(entry.ppid);
      if (found.has(entry.pid) || parentCreatedMs === undefined) continue;
      if (entry.createdMs < parentCreatedMs) continue;
      found.set(entry.pid, entry.createdMs);
      added = true;
    }
  }
  return found;
}

interface ProviderLineage {
  /** Exact start once a record has seen the provider; until then, when Paseo spawned it. */
  startMs: number;
  startSeen: boolean;
  /** Descendant PID -> start time, as recorded while the provider ran. */
  descendants: Map<number, number>;
}

/** Descendant PIDs (with start times) remembered per provider PID while the provider runs. */
export class WindowsLineageRecorder {
  private readonly lineages = new Map<number, ProviderLineage>();
  private timer: NodeJS.Timeout | null = null;
  private recording: Promise<void> | null = null;

  constructor(
    private readonly listProcesses: () => Promise<WindowsProcess[]>,
    private readonly onError: (error: unknown) => void,
  ) {}

  track(pid: number, spawnedAtMs: number): void {
    this.lineages.set(pid, { startMs: spawnedAtMs, startSeen: false, descendants: new Map() });
    this.timer ??= setInterval(() => void this.record(), RECORD_INTERVAL_MS);
    this.timer.unref();
    void this.record();
  }

  /** Stops recording `pid` and returns its descendants that are still running. */
  async release(pid: number): Promise<number[]> {
    // A record already querying may hold the last snapshot that shows an intermediate shell.
    await this.recording;
    const lineage = this.lineages.get(pid);
    this.lineages.delete(pid);
    if (this.lineages.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!lineage) return [];
    const table = await this.listProcesses();
    const descendants = walkWindowsDescendants(
      table,
      liveRoots({ table, providerPid: pid, lineage, providerExited: true }),
    );
    descendants.delete(pid);
    return [...descendants.keys()];
  }

  /** One process-table query at a time; a call during a running query waits for that one. */
  record(): Promise<void> {
    this.recording ??= this.recordOnce().finally(() => {
      this.recording = null;
    });
    return this.recording;
  }

  private async recordOnce(): Promise<void> {
    if (this.lineages.size === 0) return;
    let table: WindowsProcess[];
    try {
      table = await this.listProcesses();
    } catch (error) {
      this.onError(error);
      return;
    }
    for (const [pid, lineage] of this.lineages) {
      const provider = table.find((entry) => entry.pid === pid);
      // Started after Paseo spawned it, so it is the provider and not a later reuse of its PID.
      if (provider && !lineage.startSeen && provider.createdMs >= lineage.startMs) {
        lineage.startMs = provider.createdMs;
        lineage.startSeen = true;
      }
      for (const [descendant, createdMs] of walkWindowsDescendants(
        table,
        liveRoots({ table, providerPid: pid, lineage, providerExited: false }),
      )) {
        if (descendant !== pid) lineage.descendants.set(descendant, createdMs);
      }
    }
  }
}

/**
 * Where to walk from: the provider, unless its PID now names another process, plus every
 * recorded descendant still running with the same start time. A recorded PID that now names a
 * newer process is dropped, so that process's children are not mistaken for the provider's.
 */
function liveRoots(input: {
  table: WindowsProcess[];
  providerPid: number;
  lineage: ProviderLineage;
  providerExited: boolean;
}): Map<number, number> {
  const { table, providerPid, lineage } = input;
  const roots = new Map<number, number>();
  const current = table.find((entry) => entry.pid === providerPid);
  // Without a recorded start, a live process under an exited provider's PID can only be a reuse.
  const isReusedPid = lineage.startSeen
    ? current !== undefined && current.createdMs !== lineage.startMs
    : current !== undefined && input.providerExited;
  if (!isReusedPid) roots.set(providerPid, lineage.startMs);
  for (const entry of table) {
    if (lineage.descendants.get(entry.pid) === entry.createdMs)
      roots.set(entry.pid, entry.createdMs);
  }
  return roots;
}
