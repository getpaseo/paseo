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

/** Immutable plugin-facing activity data, independent of transport message schemas. */
export interface PluginWorkspaceActivitySnapshot {
  readonly id: string;
  readonly pluginId: string;
  readonly activityId: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly label: string;
  readonly status: "running" | "attention" | "needs_input" | "failed";
  readonly icon?: string;
  readonly count?: number;
  readonly items?: readonly { readonly id: string; readonly label: string }[];
  readonly changedAt: string;
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
  readonly activities?: readonly PluginWorkspaceActivitySnapshot[];
  readonly primaryActivityId?: string | null;
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

export interface PluginThemeRowStyle {
  /** Desktop minimum height. Compact layouts retain at least a 44pt target. */
  minHeight?: number;
  paddingHorizontal?: number;
  paddingVertical?: number;
  radius?: number;
  gap?: number;
  fontWeight?: "400" | "500" | "600";
}

/** Optional presentation overrides. They never replace controls or change their behavior. */
export interface PluginThemeComponents {
  button?: {
    radius?: number;
    borderWidth?: number;
    fontWeight?: "400" | "500" | "600";
    hoverOpacity?: number;
    pressedOpacity?: number;
    pressedScale?: number;
    sizes?: Partial<
      Record<"xs" | "sm" | "md" | "lg", { minHeight?: number; paddingHorizontal?: number }>
    >;
  };
  iconButton?: {
    radius?: number;
    highlightColor?: string;
  };
  sidebar?: {
    projectRow?: PluginThemeRowStyle;
    workspaceRow?: PluginThemeRowStyle;
    /** Indent of the workspaces nested under a project. */
    workspaceIndent?: number;
    groupGap?: number;
  };
  projectIcon?: {
    /** Sidebar size; compact layouts retain the built-in minimum. */
    size?: number;
    /** Explicitly rounds both generated initials and uploaded artwork. Omit to keep their defaults. */
    radius?: number;
    background?: string;
    foreground?: string;
    borderColor?: string;
    borderWidth?: number;
  };
  statusIndicator?: {
    size?: number;
    runningStyle?: "ring" | "dot";
    animation?: "default" | "none";
    colors?: {
      running?: string;
      needsInput?: string;
      failed?: string;
      attention?: string;
      inactive?: string;
    };
  };
}

export interface PluginThemeContribution<Text extends PluginText = string> {
  id: string;
  name: Text;
  appearance: "light" | "dark";
  colors: PluginThemeColors;
  components?: PluginThemeComponents;
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
