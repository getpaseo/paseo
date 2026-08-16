import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkspaceFiles } from "@getpaseo/workspace-helper";

import { createCommandRuntimeAdapter } from "./command/index.js";
import { createHostGitObservationOwner } from "./internal/host-git-observation.js";
import { createLocalRuntime } from "./internal/local-runtime.js";
import { createService } from "./internal/service.js";
import { createWorktreeRuntime } from "./internal/worktree-runtime.js";

export type WorkspaceProjectSource =
  | { kind: "host-directory"; path: string }
  | { kind: "git"; url: string; revision: string; subdirectory?: string };

export type WorkspacePlacement =
  | { kind: "existing"; relativeCwd?: string }
  | {
      kind: "branch";
      branchName: string;
      baseRef: string;
      relativeCwd?: string;
      worktreeSlug?: string;
    }
  | { kind: "checkout"; ref: string; relativeCwd?: string; worktreeSlug?: string }
  | ResolvedWorktreePlacement;

export type ResolvedWorktreeSource =
  | { kind: "branch-off"; baseBranch: string; branchName: string }
  | { kind: "checkout-branch"; branchName: string }
  | {
      kind: "checkout-change-request" | "checkout-github-pr";
      forge?: string;
      changeRequestNumber?: number;
      githubPrNumber?: number;
      headRef: string;
      headRepositoryOwner?: string;
      baseRefName: string;
      checkoutRefs?: readonly {
        remoteName?: string;
        remoteRef: string;
      }[];
      localBranchName?: string;
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    };

export interface ResolvedWorktreePlacement {
  kind: "resolved-worktree";
  source: ResolvedWorktreeSource;
  worktreeSlug: string;
  relativeCwd?: string;
}

export type WorkspaceProcessPurpose =
  | { kind: "agent"; agentId: string; provider: string }
  | { kind: "terminal"; terminalId: string }
  | { kind: "git" }
  | { kind: "provider-probe"; provider: string }
  | { kind: "workspace-helper" }
  | { kind: "workspace-script"; script: string }
  | { kind: "setup" }
  | { kind: "archive" };

export interface WorkspaceSetupCommand {
  cwd?: string;
  argv: readonly [string, ...string[]];
  env: Readonly<Record<string, string>>;
}

export interface CreateWorkspaceInput {
  workspaceId: string;
  runtimeId: string;
  project: { id: string; source: WorkspaceProjectSource };
  placement: WorkspacePlacement;
  purpose?: "provider-probe";
  markFirstAgentBranchAutoName?: boolean;
  seedPaseoConfigFrom?: string;
}

export interface WorkspaceProcessInput extends WorkspaceSetupCommand {
  workspaceId: string;
  purpose: WorkspaceProcessPurpose;
}

export interface WorkspaceTerminalInput extends WorkspaceProcessInput {
  rows: number;
  cols: number;
  term?: string;
}

export interface WorkspaceProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface WorkspaceProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<WorkspaceProcessExit>;
  kill(signal?: NodeJS.Signals): void;
}

export type WorkspaceScriptTerminal =
  | { readonly kind: "persistent-shell" }
  | {
      readonly kind: "direct-command";
      readonly command: string;
      readonly argsPrefix: readonly string[];
    };

export interface WorkspaceTerminal {
  onData(listener: (data: string) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  readonly exited: Promise<WorkspaceProcessExit>;
  kill(signal?: NodeJS.Signals): void;
}

export interface BoundWorkspaceRuntime {
  run(input: Omit<WorkspaceProcessInput, "workspaceId">): Promise<WorkspaceProcess>;
  resolveCommand(command: string): Promise<string | null>;
  readonly scriptTerminal: WorkspaceScriptTerminal;
  readonly provider: WorkspaceRuntimeProviderCapability;
  readonly files: WorkspaceFiles;
}

export interface WorkspaceRuntimeProviderCapability {
  readonly environment: "inherit-sanitized-host" | "isolated";
  readonly sharedHostProviders: ReadonlySet<string>;
}

export interface WorkspaceRuntimeService {
  listRuntimes(): readonly WorkspaceRuntimeCatalogEntry[];
  reconcile(): Promise<void>;
  close(): Promise<void>;
  create(input: CreateWorkspaceInput): Promise<WorkspaceRuntimePlacement>;
  run(input: WorkspaceProcessInput): Promise<WorkspaceProcess>;
  openTerminal(input: WorkspaceTerminalInput): Promise<WorkspaceTerminal>;
  bind(workspaceId: string): Promise<BoundWorkspaceRuntime>;
  files(workspaceId: string): WorkspaceFiles;
  inspect(workspaceId: string): Promise<WorkspaceRuntimeInspection>;
  requireHostVisiblePath(workspaceId: string): Promise<string>;
  pause(workspaceId: string): Promise<void>;
  resume(workspaceId: string): Promise<void>;
  archive(workspaceId: string, options?: { releaseBacking?: boolean }): Promise<void>;
  restore(workspaceId: string): Promise<void>;
  destroy(workspaceId: string): Promise<void>;
}

export interface WorkspaceRuntimeCatalogEntry {
  runtimeId: string;
  builtin: boolean;
  label?: string;
  requiresGitProject: boolean;
}

export interface WorkspaceRuntimePlacement {
  workspaceId: string;
  runtimeId: string;
  cwd: string;
  hostVisiblePath?: string;
  materializedFreshContent: boolean;
}

export type WorkspaceRuntimeInspection =
  | { status: "missing" | "error" }
  | ({ status: "paused" | "ready" } & Omit<
      WorkspaceRuntimePlacement,
      "workspaceId" | "runtimeId" | "materializedFreshContent"
    >);

export interface WorkspaceRuntimeRecordStore {
  resolveRuntimeId(workspaceId: string): Promise<string | null>;
  persistRuntimeId(
    workspaceId: string,
    runtimeId: string,
    placement: { cwd: string; hostVisiblePath?: string },
  ): Promise<void>;
  archiveWorkspaceRecord?(workspaceId: string): Promise<void>;
  restoreWorkspaceRecord?(workspaceId: string): Promise<void>;
  beginWorkspaceDeletion?(workspaceId: string): Promise<void>;
  removeWorkspaceRecord?(workspaceId: string): Promise<void>;
  listRuntimeRecords?(): Promise<
    readonly { workspaceId: string; runtimeId: string; archived: boolean; deleting?: boolean }[]
  >;
}

export interface ExternalWorkspaceRuntime {
  type: "command";
  label?: string;
  command: readonly [string, ...string[]];
  options?: Readonly<Record<string, WorkspaceRuntimeJsonValue>>;
}
export type WorkspaceRuntimeConfig = ExternalWorkspaceRuntime;
export type WorkspaceRuntimeJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly WorkspaceRuntimeJsonValue[]
  | { readonly [key: string]: WorkspaceRuntimeJsonValue };

export interface WorkspaceRuntimeOptions extends WorkspaceRuntimeRecordStore {
  paseoHome: string;
  worktreesRoot?: string;
  externalRuntimes?: Readonly<Record<string, WorkspaceRuntimeConfig>>;
  commandResolutionBase?: string;
}

export function createWorkspaceRuntimeService(
  options: WorkspaceRuntimeOptions,
): WorkspaceRuntimeService {
  const hostGitObservations = createHostGitObservationOwner();
  const configuredRuntimes = options.externalRuntimes ?? {};
  const externalEntries = Object.entries(configuredRuntimes);
  const runtimeInstanceId = createHash("sha256").update(resolve(options.paseoHome)).digest("hex");
  const externalDrivers = externalEntries.map(([runtimeId, config]) => {
    if (runtimeId === "local" || runtimeId === "worktree") {
      throw new Error(`Workspace runtime id is reserved: ${runtimeId}`);
    }
    return createCommandRuntimeAdapter(
      runtimeId,
      config,
      runtimeInstanceId,
      options.commandResolutionBase ?? fileURLToPath(new URL(".", import.meta.url)),
      options.paseoHome,
    );
  });
  const drivers = [
    createLocalRuntime(options.paseoHome, hostGitObservations),
    createWorktreeRuntime({
      paseoHome: options.paseoHome,
      worktreesRoot: options.worktreesRoot,
      hostGitObservations,
    }),
    ...externalDrivers,
  ];
  const catalogMetadata = new Map<string, { builtin: boolean; label?: string }>([
    ["local", { builtin: true }],
    ["worktree", { builtin: true }],
    ...externalEntries.map(
      ([runtimeId, config]) =>
        [
          runtimeId,
          {
            builtin: false,
            ...(config.label ? { label: config.label } : {}),
          },
        ] as const,
    ),
  ]);
  return createService(drivers, options, catalogMetadata);
}
