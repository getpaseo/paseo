import type { ComponentType } from "react";
import type { PaseoPluginApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { DeliveryPayload, DeliveryRecord } from "@getpaseo/protocol/deliveries";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
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

export interface PluginHostProps {
  theme: PluginTheme;
  host: {
    id: string;
    label: string;
  };
  layout: {
    compact: boolean;
    platform: "ios" | "android" | "web";
  };
}

interface PluginNavigableHostProps extends PluginHostProps {
  /** Client-owned navigation. Undefined on older hosts; hide dependent affordances when absent. */
  readonly navigation?: {
    readonly openAgent: (input: { readonly agentId: string }) => void;
    readonly openWorkspace: (input: { readonly workspaceId: string }) => void;
  };
}

export interface PluginSurfaceProps extends PluginNavigableHostProps {}

export interface PluginIconProps {
  name: string;
  size?: number;
  color?: string;
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

/** A value is usable for policy decisions only when the daemon proved it. */
export type PluginKnownValue<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false };

/** Provider-neutral security levels. `unknown` is the restrictive value. */
export type PluginFilesystemSecurityCeiling = "none" | "workspace" | "unrestricted" | "unknown";
export type PluginNetworkSecurityCeiling = "none" | "restricted" | "unrestricted" | "unknown";
export type PluginApprovalSecurityCeiling = "none" | "interactive" | "preapproved" | "unknown";
export type PluginUnattendedSecurityCeiling = "forbidden" | "allowed" | "unknown";

export interface PluginSecurityCeiling {
  readonly filesystem: PluginFilesystemSecurityCeiling;
  readonly network: PluginNetworkSecurityCeiling;
  readonly approvals: PluginApprovalSecurityCeiling;
  readonly unattended: PluginUnattendedSecurityCeiling;
}

export interface PluginCallerAuthority {
  readonly callerAgentId: string;
  readonly agent: PluginAgentSnapshot;
  readonly workspace: PluginWorkspaceSnapshot | null;
  readonly effective: {
    readonly provider: PluginKnownValue<string>;
    readonly model: PluginKnownValue<string>;
    readonly thinking: PluginKnownValue<string>;
    readonly providerSessionId: PluginKnownValue<string>;
  };
  readonly securityCeiling: PluginSecurityCeiling;
}

export interface PluginHostDeliveryGetOptions {
  readonly deliveryId?: string;
  readonly includeAcknowledged?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface PluginHostDeliverySendOptions {
  readonly deliveryId?: string;
  readonly messageId?: string;
}

export interface PluginHostDeliveryActions {
  /** The daemon targets this invocation's exact caller agent. */
  readonly send: (
    payload: DeliveryPayload,
    options?: PluginHostDeliverySendOptions,
  ) => Promise<DeliveryRecord>;
  readonly get: (options?: PluginHostDeliveryGetOptions) => Promise<{
    readonly delivery: DeliveryRecord | null;
    readonly deliveries: DeliveryRecord[];
    readonly nextCursor: string | null;
  }>;
  readonly acknowledge: (deliveryId: string) => Promise<DeliveryRecord>;
}

export interface PluginHostChildCreateOptions {
  readonly model?: string;
  readonly thinking?: string;
  readonly toolPolicy?: "none" | "readonly" | "standard" | "all";
  readonly security?: Partial<PluginSecurityCeiling>;
  readonly title?: string;
  readonly prompt?: string;
  readonly worktreeId?: string;
}

export interface PluginHostedChild {
  readonly agentId: string;
  readonly parentAgentId: string;
  readonly workspaceId: string | null;
  readonly cwd: string;
  readonly provider: string;
  readonly model: string | null;
  readonly thinking: string | null;
}

export interface PluginManagedWorktreeCreateOptions {
  readonly name?: string;
  readonly branch?: string;
}

export interface PluginManagedWorktree {
  /** Opaque to plugins; only the owning plugin session and caller may remove it. */
  readonly id: string;
  readonly workspace: PluginWorkspaceSnapshot;
  readonly cwd: string;
}

export interface PluginHostCapability {
  readonly deliveries: PluginHostDeliveryActions;
  readonly children: {
    readonly create: (options?: PluginHostChildCreateOptions) => Promise<PluginHostedChild>;
  };
  readonly worktrees: {
    readonly create: (
      options?: PluginManagedWorktreeCreateOptions,
    ) => Promise<PluginManagedWorktree>;
    readonly remove: (id: string) => Promise<void>;
  };
}

export type PluginPanelLocation = "workspace" | "explorer";

export interface PluginOpenPanelOptions {
  location?: PluginPanelLocation;
}

interface PluginWorkspacePanelBase {
  id: string;
  title: string;
  icon: string;
  locations?: readonly PluginPanelLocation[];
}

export interface PluginWorkspacePanelProps extends PluginNavigableHostProps {
  context: "workspace";
  workspaceId: string;
}

export interface PluginAgentPanelProps extends PluginNavigableHostProps {
  context: "agent";
  workspaceId: string;
  agentId: string;
}

export interface PluginComposerPillProps extends PluginHostProps {
  workspaceId: string;
  agentId: string;
}

export interface PluginComposerPillContribution {
  id: string;
  title: string;
  workspaceId: string;
  agentId: string;
  Component: ComponentType<PluginComposerPillProps>;
  onPress(): void | Promise<void>;
}

export interface PluginClientOpenPanelOptions extends PluginOpenPanelOptions {
  workspaceId: string;
  agentId?: string;
}

export interface PluginClientContext extends PluginCommandCapabilities {
  addComposerPill(contribution: PluginComposerPillContribution): PluginCleanup;
  openPanel(id: string, options: PluginClientOpenPanelOptions): void;
}

export type PluginClientContribution = (client: PluginClientContext) => PluginCleanup;

export type PluginWorkspacePanelContribution =
  | (PluginWorkspacePanelBase & {
      context: "workspace";
      Component: ComponentType<PluginWorkspacePanelProps>;
    })
  | (PluginWorkspacePanelBase & {
      context: "agent";
      Component: ComponentType<PluginAgentPanelProps>;
    });

export interface PluginSurfaceContribution {
  id: string;
  Component: ComponentType<PluginSurfaceProps>;
}

export interface PluginSidebarContribution {
  id: string;
  title: string;
  icon: string;
  surface: string;
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

export type PluginTimelineData =
  | null
  | boolean
  | number
  | string
  | PluginTimelineData[]
  | { [key: string]: PluginTimelineData };

export interface PluginTimelineItem {
  type: "plugin";
  kind: string;
  version: number;
  data: PluginTimelineData;
}

export interface PluginTimelineTransformResult {
  items: PluginTimelineItem[];
}

export type PluginTimelineTransformerContribution<
  ItemType extends AgentTimelineItem["type"] = AgentTimelineItem["type"],
> = ItemType extends AgentTimelineItem["type"]
  ? {
      id: string;
      query: {
        itemType: ItemType;
      };
      transform(input: {
        item: Extract<AgentTimelineItem, { type: ItemType }>;
      }): PluginTimelineTransformResult | undefined;
    }
  : never;

export interface PluginTimelineItemProps<Data = unknown> extends PluginHostProps {
  agentId: string;
  item: {
    type: "plugin";
    kind: string;
    version: number;
    data: Data;
  };
  timestamp: Date;
}

export interface PluginTimelineRendererContribution<Schema extends ZodType = ZodType> {
  kind: string;
  version: number;
  schema: Schema;
  Component: ComponentType<PluginTimelineItemProps<ZodOutput<Schema>>>;
}

export interface PluginCommandCapabilities {
  paseo: PaseoPluginApi;
  rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    input: ZodInput<InputSchema>,
  ): Promise<ZodOutput<OutputSchema>>;
  openSurface(id: string): void;
}

export interface PluginGlobalCommandContext extends PluginCommandCapabilities {
  context: "global";
}

export interface PluginWorkspaceCommandContext extends PluginCommandCapabilities {
  context: "workspace";
  workspace: PluginWorkspaceSnapshot;
  openPanel(id: string, options?: PluginOpenPanelOptions): void;
}

export interface PluginAgentCommandContext extends PluginCommandCapabilities {
  context: "agent";
  workspace: PluginWorkspaceSnapshot;
  agent: PluginAgentSnapshot;
  openPanel(id: string, options?: PluginOpenPanelOptions): void;
}

interface PluginCommandCenterItemBase {
  id: string;
  title: string;
  icon: string;
  keywords?: readonly string[];
}

export type PluginCommandCenterItemContribution =
  | (PluginCommandCenterItemBase & {
      context: "global";
      onSelect(context: PluginGlobalCommandContext): void | Promise<void>;
    })
  | (PluginCommandCenterItemBase & {
      context: "workspace";
      onSelect(context: PluginWorkspaceCommandContext): void | Promise<void>;
    })
  | (PluginCommandCenterItemBase & {
      context: "agent";
      onSelect(context: PluginAgentCommandContext): void | Promise<void>;
    });

export interface PluginHandlerContext {
  paseo: PaseoPluginApi;
  readonly caller: PluginCallerAuthority | null;
  readonly host: PluginHostCapability | null;
  readonly signal: AbortSignal;
}

/**
 * Context supplied by the daemon when a model invokes a plugin tool. Every
 * authority-bearing field is resolved by Paseo; tool input cannot provide or
 * replace it.
 */
export interface PluginToolHandlerContext {
  readonly paseo: PaseoPluginApi;
  readonly caller: PluginCallerAuthority;
  readonly host: PluginHostCapability;
  readonly callerAgentId: string;
  readonly agent: PluginAgentSnapshot | null;
  readonly workspace: PluginWorkspaceSnapshot | null;
  readonly signal: AbortSignal;
  /** Bounded, best-effort progress updates visible to the calling provider. */
  readonly progress?: (update: unknown) => void;
}

export type PluginToolContext = PluginToolHandlerContext;

type PluginToolOutput<OutputSchema extends ZodType | undefined> = OutputSchema extends ZodType
  ? ZodOutput<OutputSchema>
  : unknown;

export interface PluginToolContribution<
  InputSchema extends ZodType = ZodType,
  OutputSchema extends ZodType | undefined = ZodType | undefined,
> {
  /** Exact global name exposed to the model-facing provider tool catalog. */
  name: string;
  title: string;
  description: string;
  input: InputSchema;
  output?: OutputSchema;
  /** Host-capped execution deadline in milliseconds. */
  timeoutMs?: number;
  handler(
    input: ZodOutput<InputSchema>,
    context: PluginToolHandlerContext,
  ): PluginToolOutput<OutputSchema> | Promise<PluginToolOutput<OutputSchema>>;
}

export interface PluginContext {
  handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginHandlerContext,
    ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
  ): void;
  addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): void;
  addSidebarItem(contribution: PluginSidebarContribution): void;
  addWorkspacePanel(contribution: PluginWorkspacePanelContribution): void;
  addCommandCenterItem(contribution: PluginCommandCenterItemContribution): void;
  addClientSide(contribution: PluginClientContribution): void;
  addAttachmentSource(contribution: PluginAttachmentSourceContribution): void;
  /** Server-only model-facing tool registration. */
  addTool<
    InputSchema extends ZodType,
    OutputSchema extends ZodType | undefined = ZodType | undefined,
  >(
    contribution: PluginToolContribution<InputSchema, OutputSchema>,
  ): void;
  addTheme(contribution: PluginThemeContribution): void;
  addTimelineTransformer<ItemType extends AgentTimelineItem["type"]>(
    contribution: PluginTimelineTransformerContribution<ItemType>,
  ): void;
  addTimelineRenderer<Schema extends ZodType>(
    contribution: PluginTimelineRendererContribution<Schema>,
  ): void;
}

export type PluginCleanup = () => void | Promise<void>;

export type PluginContribution = (plugin: PluginContext) => PluginCleanup;
