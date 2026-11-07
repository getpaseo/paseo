import type { WorkspaceRef, AgentRef, ProjectRef, TerminalRef } from "./refs.js";
import type { PluginText } from "./text.js";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { PluginSerializableIcon } from "./icons.js";
import type { PluginRpcContract } from "./rpc.js";

export interface PluginTheme {
  readonly colors: {
    readonly surface0: string;
    readonly surface1: string;
    readonly surface2: string;
    readonly border: string;
    readonly foreground: string;
    readonly foregroundMuted: string;
    readonly accent: string;
    readonly accentForeground: string;
    readonly statusSuccess: string;
    readonly statusWarning: string;
    readonly statusDanger: string;
  };
}

export type WorkspaceIndicator = "needs_input" | "failed" | "running" | "attention" | "done";

export interface PluginWorkspaceSnapshot {
  readonly ref: WorkspaceRef;
  readonly hostId: string;
  readonly project: ProjectRef;
  readonly pinnedAt: string | null;
  readonly labels: readonly string[];
  readonly background: boolean;
  readonly branch: string | null;
  /** Null when an older host has not supplied the workspace creation time. */
  readonly createdAt: string | null;
  readonly lastPromptAt: string | null;
  readonly parentAgent: AgentRef | null;
  readonly indicator: WorkspaceIndicator;
  readonly indicatorLabel: string | null;
  readonly id: string;
  readonly projectId: string;
  readonly projectDisplayName: string;
  readonly projectRootPath: string;
  readonly directory: string;
  readonly projectKind: "git" | "non_git" | "directory";
  readonly kind: "directory" | "local_checkout" | "checkout" | "worktree";
  readonly name: string;
  readonly title: string | null;
  /** Raw daemon status; prefer indicator for presentation. */
  readonly status: "needs_input" | "failed" | "running" | "attention" | "done";
  readonly statusEnteredAt: string | null;
  readonly archivingAt: string | null;
  readonly diffStat: { readonly additions: number; readonly deletions: number } | null;
}

export interface PluginAgentSnapshot {
  readonly ref: AgentRef;
  readonly hostId: string;
  readonly workspace: WorkspaceRef;
  readonly parentAgent: AgentRef | null;
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: string;
  readonly status: "initializing" | "idle" | "running" | "error" | "closed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActivityAt: string;
  readonly title: string | null;
  readonly cwd: string;
  readonly model: string | null;
  readonly currentModeId: string | null;
  readonly thinkingOptionId: string | null;
  readonly requiresAttention: boolean;
  readonly attentionReason: "finished" | "error" | "permission" | null;
  readonly parentAgentId: string | null;
  readonly labels: Readonly<Record<string, string>>;
  /** Structured data plugins store on the agent. */
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface PluginThemeColors {
  background: string;
  foreground: string;
  raised: string;
  control: string;
  border: string;
  accent?: string;
  mutedForeground: string;
  ring: string;
}

export interface PluginThemeContribution<Text extends PluginText = string> {
  id: string;
  name: Text;
  appearance: "light" | "dark";
  colors: PluginThemeColors;
}

export interface PluginAttachmentSourceContribution<Text extends PluginText = string> {
  id: string;
  title: Text;
  icon: PluginSerializableIcon;
  pickerTitle: Text;
  searchPlaceholder: Text;
  search: PluginRpcContract;
}

export type PluginTimelineData = JsonValue;

export interface PluginTimelineItem {
  type: "plugin";
  id?: string;
  kind: string;
  version: number;
  data: PluginTimelineData;
}

export interface PluginTimelineTransformResult {
  items: PluginTimelineItem[];
}

export type PluginCleanup = () => void | Promise<void>;

export interface PluginProjectSnapshot {
  readonly ref: ProjectRef;
  readonly hostId: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly kind: PluginWorkspaceSnapshot["projectKind"];
  readonly iconRevision: string | null;
}

export interface PluginTerminalSnapshot {
  readonly ref: TerminalRef;
  readonly hostId: string;
  readonly workspace: WorkspaceRef;
  readonly title: string;
  readonly isScript: boolean;
  /** Null for terminals owned by workers started before timestamps were tracked. */
  readonly createdAt: string | null;
}
