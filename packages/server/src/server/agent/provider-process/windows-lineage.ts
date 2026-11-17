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

/** Descendant PIDs (with start times) remembered per provider PID while the provider runs. */
export class WindowsLineageRecorder {
  private readonly lineages = new Map<number, Map<number, number>>();
  private timer: NodeJS.Timeout | null = null;
  private recording: Promise<void> | null = null;

  constructor(
    private readonly listProcesses: () => Promise<WindowsProcess[]>,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** `spawnedAtMs` bounds the provider's start until the first record reads the exact time. */
  track(pid: number, spawnedAtMs: number): void {
    this.lineages.set(pid, new Map([[pid, spawnedAtMs]]));
    this.timer ??= setInterval(() => void this.record(), RECORD_INTERVAL_MS);
    this.timer.unref();
    void this.record();
  }

  /** Stops recording `pid` and returns the descendants still running with the recorded start. */
  async release(pid: number): Promise<number[]> {
    const lineage = this.lineages.get(pid) ?? new Map<number, number>();
    this.lineages.delete(pid);
    if (this.lineages.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const table = await this.listProcesses();
    const descendants = walkWindowsDescendants(table, liveRoots(table, pid, lineage));
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
      if (provider) lineage.set(pid, provider.createdMs);
      for (const [descendant, createdMs] of walkWindowsDescendants(
        table,
        liveRoots(table, pid, lineage),
      )) {
        lineage.set(descendant, createdMs);
      }
    }
  }
}

/**
 * The provider (alive or not, by its recorded start) plus every recorded descendant that is
 * still running with the same start time. A recorded PID that now names a newer process is
 * dropped, so its children are not mistaken for the provider's.
 */
function liveRoots(
  table: WindowsProcess[],
  providerPid: number,
  lineage: ReadonlyMap<number, number>,
): Map<number, number> {
  const roots = new Map<number, number>();
  const providerCreatedMs = lineage.get(providerPid);
  if (providerCreatedMs !== undefined) roots.set(providerPid, providerCreatedMs);
  for (const entry of table) {
    if (entry.pid !== providerPid && lineage.get(entry.pid) === entry.createdMs) {
      roots.set(entry.pid, entry.createdMs);
    }
  }
  return roots;
}
