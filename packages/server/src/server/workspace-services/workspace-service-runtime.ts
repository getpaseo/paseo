import type { TerminalManager } from "../../terminal/terminal-manager.js";
import {
  observeTerminalServices,
  type TerminalServiceObserver,
} from "./terminal-service-observer.js";
import type { TerminalServiceCandidate } from "./terminal-service-store.js";

type WorkspaceServiceListener = (workspaceId: string) => void;

export class WorkspaceServiceRuntime {
  private readonly observer: TerminalServiceObserver;
  private readonly listeners = new Set<WorkspaceServiceListener>();

  constructor(options: {
    terminalManager: TerminalManager;
    probe?: (url: string) => Promise<boolean>;
  }) {
    this.observer = observeTerminalServices({
      terminalManager: options.terminalManager,
      ...(options.probe ? { probe: options.probe } : {}),
      onChange: (workspaceId) => {
        for (const listener of this.listeners) listener(workspaceId);
      },
    });
  }

  listTerminalCandidates(workspaceId: string): TerminalServiceCandidate[] {
    return this.observer.store.listForWorkspace(workspaceId);
  }

  subscribe(listener: WorkspaceServiceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.observer.dispose();
    this.listeners.clear();
  }
}
