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
  readonly diffStat: {
    readonly additions: number;
    readonly deletions: number;
  } | null;
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
  /** Shells and monitors the agent left running after its turn. 0 when none are live. */
  readonly backgroundWork: { readonly count: number };
  /** A helper hidden from tabs, lists and attention. Fixed at creation. */
  readonly background: boolean;
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
  sidebar?: string;
  sidebarHover?: string;
  sidebarSelected?: string;
  surface3?: string;
  surface4?: string;
  foregroundExtraMuted?: string;
}

/** Pixel sizes. `none` (0) and `full` (pill) are fixed so round elements stay round. */
export interface PluginThemeRadius {
  sm?: number;
  base?: number;
  md?: number;
  lg?: number;
  xl?: number;
  "2xl"?: number;
}

/** Pixel sizes for the spacing scale. `0` is fixed. */
export type PluginThemeSpacing = Partial<
  Record<0.5 | 1 | 1.5 | 2 | 3 | 3.5 | 4 | 6 | 7 | 8 | 12 | 16 | 20 | 24 | 32, number>
>;

/** The UI type ramp in pixels. Chat content and code sizes stay user settings. */
export interface PluginThemeFontSize {
  sm?: number;
  base?: number;
  lg?: number;
  xl?: number;
  "2xl"?: number;
  "3xl"?: number;
  "4xl"?: number;
}

export type PluginThemeFontWeightValue =
  | "normal"
  | "bold"
  | "100"
  | "200"
  | "300"
  | "400"
  | "500"
  | "600"
  | "700"
  | "800"
  | "900";

export interface PluginThemeFontWeight {
  normal?: PluginThemeFontWeightValue;
  medium?: PluginThemeFontWeightValue;
  semibold?: PluginThemeFontWeightValue;
  bold?: PluginThemeFontWeightValue;
}

/** Pixel widths. `0` is fixed. */
export interface PluginThemeBorderWidth {
  1?: number;
  2?: number;
}

/** `50` is the disabled-control opacity, from 0 to 1. `0` and `100` are fixed. */
export interface PluginThemeOpacity {
  50?: number;
}

export interface PluginThemeContribution<Text extends PluginText = string> {
  id: string;
  name: Text;
  appearance: "light" | "dark";
  colors: PluginThemeColors;
  radius?: PluginThemeRadius;
  spacing?: PluginThemeSpacing;
  fontSize?: PluginThemeFontSize;
  fontWeight?: PluginThemeFontWeight;
  borderWidth?: PluginThemeBorderWidth;
  opacity?: PluginThemeOpacity;
  /** Default stroke width of Paseo's line icons. */
  iconStrokeWidth?: number;
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
