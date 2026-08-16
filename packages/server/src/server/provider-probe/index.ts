import type pino from "pino";
import type { PersistedProjectRecord } from "../workspace-registry.js";

import type { ProviderWorkspace } from "../agent/providers/workspace/index.js";
import type {
  CreateWorkspaceInput,
  WorkspaceRuntimeInspection,
  WorkspaceRuntimePlacement,
  WorkspaceRuntimeRecordStore,
} from "../workspace-runtime/index.js";
import { createProbeStore } from "./internal/probe-store.js";
import { createService } from "./internal/service.js";

export interface ProviderProbeService {
  ensure(input: { projectId: string; runtimeId: string }): Promise<{ workspaceId: string }>;
  resolveProviderWorkspace(workspaceId: string): Promise<ProviderWorkspace | null>;
  invalidateProject(projectId: string): Promise<void>;
  reconcile(): Promise<void>;
  close(): Promise<void>;
  readonly records: WorkspaceRuntimeRecordStore;
}

export interface ProviderProbeTimer {
  unref?(): void;
}

export interface ProviderProbeClock {
  now(): Date;
  setTimeout(callback: () => void | Promise<void>, delayMs: number): ProviderProbeTimer;
  clearTimeout(timer: ProviderProbeTimer): void;
}

export interface ProviderProbeServiceOptions {
  filePath: string;
  logger: pino.Logger;
  projects: {
    get(
      projectId: string,
    ): Promise<Pick<
      PersistedProjectRecord,
      "projectId" | "rootPath" | "source" | "updatedAt" | "archivedAt"
    > | null>;
  };
  runtime: {
    create(input: CreateWorkspaceInput): Promise<WorkspaceRuntimePlacement>;
    inspect(workspaceId: string): Promise<WorkspaceRuntimeInspection>;
    pause(workspaceId: string): Promise<void>;
    resume(workspaceId: string): Promise<void>;
    destroy(workspaceId: string): Promise<void>;
    listRuntimes(): readonly { runtimeId: string }[];
  };
  clock?: ProviderProbeClock;
  runtimeConfiguration?: Readonly<Record<string, unknown>>;
  bindWorkspaceProviderCapability(
    workspaceId: string,
    runtimeId: string,
  ): Promise<ProviderWorkspace>;
}

export function createProviderProbeService(
  options: ProviderProbeServiceOptions,
): ProviderProbeService {
  const store = createProbeStore(options.filePath, options.logger);
  return createService({ ...options, store });
}
