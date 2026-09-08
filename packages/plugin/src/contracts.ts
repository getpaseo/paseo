import type { JsonValue } from "@getpaseo/protocol/agent-types";
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

export interface PluginWorkspaceSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly projectDisplayName: string;
  readonly projectRootPath: string;
  readonly directory: string;
  readonly projectKind: "git" | "non_git" | "directory";
  readonly kind: "directory" | "local_checkout" | "checkout" | "worktree";
  readonly name: string;
  readonly title: string | null;
  readonly status: "needs_input" | "failed" | "running" | "attention" | "done";
  readonly statusEnteredAt: string | null;
  readonly archivingAt: string | null;
  readonly diffStat: { readonly additions: number; readonly deletions: number } | null;
}

export interface PluginAgentSnapshot {
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

export interface PluginThemeContribution {
  id: string;
  name: string;
  appearance: "light" | "dark";
  colors: PluginThemeColors;
}

export interface PluginAttachmentSourceContribution {
  id: string;
  title: string;
  icon: string;
  pickerTitle: string;
  searchPlaceholder: string;
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
