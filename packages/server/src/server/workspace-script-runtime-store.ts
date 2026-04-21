export interface ScriptRuntimeEntry {
  workspaceId: string;
  scriptName: string;
  type: "script" | "service";
  lifecycle: "running" | "stopped";
  terminalId: string;
  exitCode: number | null;
}

type RuntimeEntryKey = {
  workspaceId: string;
  scriptName: string;
};

export class WorkspaceScriptRuntimeStore {
  private readonly entries = new Map<string, ScriptRuntimeEntry>();
  private readonly scriptsByWorkspace = new Map<string, Set<string>>();

  get(key: RuntimeEntryKey): ScriptRuntimeEntry | null {
    const entry = this.entries.get(this.toEntryKey(key));
    return entry ? { ...entry } : null;
  }

  set(entry: ScriptRuntimeEntry): void {
    const workspaceKey = this.toWorkspaceKey(entry.workspaceId);
    const entryKey = this.toEntryKey(entry);
    const previous = this.entries.get(entryKey);
    if (previous) {
      this.removeScriptFromWorkspaceIndex(previous.workspaceId, previous.scriptName);
    }

    this.entries.set(entryKey, { ...entry });
    this.addScriptToWorkspaceIndex(workspaceKey, entry.scriptName);
  }

  remove(key: RuntimeEntryKey): void {
    const entryKey = this.toEntryKey(key);
    const existing = this.entries.get(entryKey);
    if (!existing) {
      return;
    }

    this.entries.delete(entryKey);
    this.removeScriptFromWorkspaceIndex(existing.workspaceId, existing.scriptName);
  }

  listForWorkspace(workspaceId: string): ScriptRuntimeEntry[] {
    const scriptNames = this.scriptsByWorkspace.get(this.toWorkspaceKey(workspaceId));
    if (!scriptNames) {
      return [];
    }

    const entries: ScriptRuntimeEntry[] = [];
    for (const scriptName of scriptNames) {
      const entry = this.entries.get(
        this.toEntryKey({
          workspaceId,
          scriptName,
        }),
      );
      if (entry) {
        entries.push({ ...entry });
      }
    }
    return entries;
  }

  removeForWorkspace(workspaceId: string): void {
    for (const entry of this.listForWorkspace(workspaceId)) {
      this.entries.delete(this.toEntryKey(entry));
    }
    this.scriptsByWorkspace.delete(this.toWorkspaceKey(workspaceId));
  }

  isRunning(key: RuntimeEntryKey): boolean {
    return this.get(key)?.lifecycle === "running";
  }

  private addScriptToWorkspaceIndex(workspaceKey: string, scriptName: string): void {
    const scripts = this.scriptsByWorkspace.get(workspaceKey) ?? new Set<string>();
    scripts.add(scriptName);
    this.scriptsByWorkspace.set(workspaceKey, scripts);
  }

  private removeScriptFromWorkspaceIndex(workspaceId: string, scriptName: string): void {
    const workspaceKey = this.toWorkspaceKey(workspaceId);
    const scripts = this.scriptsByWorkspace.get(workspaceKey);
    if (!scripts) {
      return;
    }

    scripts.delete(scriptName);
    if (scripts.size === 0) {
      this.scriptsByWorkspace.delete(workspaceKey);
    }
  }

  private toEntryKey(key: RuntimeEntryKey): string {
    return `${this.toWorkspaceKey(key.workspaceId)}::${key.scriptName}`;
  }

  private toWorkspaceKey(workspaceId: string): string {
    return workspaceId;
  }
}
