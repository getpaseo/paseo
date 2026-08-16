import type { Readable, Writable } from "node:stream";

export type WorkspaceRuntimeId = string;
export type WorkspaceId = string;

export type WorkspaceProjectSource = import("../index.js").WorkspaceProjectSource;

export type WorkspacePlacementIntent =
  | { kind: "existing"; relativeCwd?: string }
  | {
      kind: "branch";
      branchName: string;
      baseRef: string;
      relativeCwd?: string;
      worktreeSlug?: string;
    }
  | { kind: "checkout"; ref: string; relativeCwd?: string; worktreeSlug?: string }
  | import("../index.js").ResolvedWorktreePlacement;

export interface WorkspaceDriverCreateInput {
  workspaceId: WorkspaceId;
  project: { projectId: string; source: WorkspaceProjectSource };
  placement: WorkspacePlacementIntent;
  purpose?: "provider-probe";
  markFirstAgentBranchAutoName?: boolean;
  seedPaseoConfigFrom?: string;
}

export interface WorkspaceDriverState {
  workspaceId: WorkspaceId;
  lifecycle: "ready" | "paused";
  lifecycleEnvironment?: Readonly<Record<string, string>>;
}

export interface WorkspacePublicPlacement {
  cwd: string;
  hostVisiblePath?: string;
}

export interface WorkspaceDriverReady {
  state: WorkspaceDriverState;
  placement: WorkspacePublicPlacement;
}

export interface WorkspaceDriverCreation extends WorkspaceDriverReady {
  /** This create materialized fresh workspace content/resources, so user setup may run. */
  materializedFreshContent: boolean;
}

export type WorkspaceDriverInspection =
  | { status: "missing" }
  | ({ status: "paused" } & WorkspaceDriverReady)
  | ({ status: "ready" } & WorkspaceDriverReady)
  | { status: "error"; message: string };

export interface WorkspaceDriverSpawnInput {
  workspaceId: WorkspaceId;
  cwd?: string;
  argv: readonly [string, ...string[]];
  env: Readonly<Record<string, string>>;
  purpose:
    | { kind: "agent"; agentId: string; provider: string }
    | { kind: "terminal"; terminalId: string }
    | { kind: "git" }
    | { kind: "provider-probe"; provider: string }
    | { kind: "workspace-helper" }
    | { kind: "workspace-script"; script: string }
    | { kind: "setup" }
    | { kind: "archive" };
  stdio: { kind: "pipes" } | { kind: "pty"; rows: number; cols: number; term?: string };
}

export interface WorkspaceProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface WorkspacePipeProcess {
  kind: "pipes";
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<WorkspaceProcessExit>;
  kill(signal?: NodeJS.Signals): void;
}

export interface WorkspacePtyProcess {
  kind: "pty";
  onData(listener: (data: string) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  exited: Promise<WorkspaceProcessExit>;
  kill(signal?: NodeJS.Signals): void;
}

export type WorkspaceDriverProcess = WorkspacePipeProcess | WorkspacePtyProcess;

export interface WorkspaceRuntimeDriver {
  readonly id: WorkspaceRuntimeId;
  readonly requiresGitProject: boolean;
  readonly reconciliationDomainId?: string;
  /** Runtime-local launch specification for Paseo's compatible workspace helper. */
  readonly workspaceHelper: {
    command: readonly [string, ...string[]];
    env: Readonly<Record<string, string>>;
  };
  readonly scriptTerminal: import("../index.js").WorkspaceScriptTerminal;
  readonly provider: import("../index.js").WorkspaceRuntimeProviderCapability;
  /** Private setup-only base environment owned by this execution boundary. */
  setupEnvironment?(): Readonly<Record<string, string>>;
  create(input: WorkspaceDriverCreateInput): Promise<WorkspaceDriverCreation>;
  inspect(workspaceId: WorkspaceId): Promise<WorkspaceDriverInspection>;
  spawn(input: WorkspaceDriverSpawnInput): Promise<WorkspaceDriverProcess>;
  observeGit?(
    workspaceId: WorkspaceId,
    listener: () => void,
  ): Promise<{ unsubscribe(): Promise<void> }>;
  pause(workspaceId: WorkspaceId): Promise<void>;
  /** Release restorable backing owned by this driver after the runtime is paused. */
  releaseBacking?(workspaceId: WorkspaceId): Promise<void>;
  resume(workspaceId: WorkspaceId): Promise<WorkspaceDriverReady>;
  destroy(workspaceId: WorkspaceId): Promise<void>;
  reconcile?(workspaceIds: readonly WorkspaceId[]): Promise<void>;
}
