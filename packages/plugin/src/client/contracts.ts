import type { ComponentType } from "react";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginRpcContract } from "../rpc.js";
import type {
  PluginButtonRegistration,
  PluginHeaderButtonContribution,
  PluginComposerPillContribution,
} from "./buttons.js";
import type {
  PluginTheme,
  PluginWorkspaceSnapshot,
  PluginAgentSnapshot,
  PluginThemeContribution,
  PluginAttachmentSourceContribution,
  PluginTimelineTransformResult,
  PluginCleanup,
} from "../contracts.js";

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
    /** Present only on Electron. The browser runs locally; serverId selects workspace ownership. */
    readonly openBrowser?: (input: {
      readonly url: string;
      readonly workspaceId: string;
      readonly serverId?: string;
    }) => void;
    /** Reveal an existing terminal using the client's terminal open-location preference. */
    readonly openTerminal?: (input: {
      readonly workspaceId: string;
      readonly terminalId: string;
      readonly serverId?: string;
    }) => void;
    readonly openAgent: (input: { readonly agentId: string; readonly serverId?: string }) => void;
    readonly openWorkspace: (input: {
      readonly workspaceId: string;
      readonly serverId?: string;
    }) => void;
  };
}

/** String keys and values: params travel in the screen's URL. */
export type PluginScreenParams = Record<string, string>;

export interface PluginOpenScreenInput {
  screenId: string;
  params?: PluginScreenParams;
}

export interface PluginScreenLocation {
  screenId: string;
  params: PluginScreenParams;
}

export interface PluginSurfaceProps extends PluginNavigableHostProps {}

export interface PluginScreenProps extends PluginSurfaceProps {
  /** The params the screen was opened with; `{}` when none. */
  params: PluginScreenParams;
}

export interface PluginPopoverProps extends PluginHostProps {
  close(): void;
  openScreen(input: PluginOpenScreenInput): void;
}

export interface PluginSidebarItemProps extends PluginHostProps {
  /** This plugin's screen open on this item's host, with its params, else null. */
  currentScreen: PluginScreenLocation | null;
  openScreen(input: PluginOpenScreenInput): void;
  /** Anchored to the item on wide layouts; a bottom sheet on compact layouts. */
  openPopover(Content: ComponentType<PluginPopoverProps>): void;
}

export interface PluginSidebarItemContribution {
  id: string;
  /** Settings row label, accessibility label, and default label for SidebarRow. */
  title: string;
  Component: ComponentType<PluginSidebarItemProps>;
}

export interface PluginIconProps {
  name: string;
  size?: number;
  color?: string;
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

export interface PluginClientOpenPanelOptions extends PluginOpenPanelOptions {
  workspaceId: string;
  agentId?: string;
}

// COMPAT(pluginSidebarAliases): added in v0.11.0, remove after 2027-03-29
interface PluginClientContextAliases {
  /** @deprecated Use `addScreen`. */
  addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): PluginCleanup;
  /** @deprecated Use `addSidebarHeaderItem`. */
  addSidebarItem(contribution: PluginSidebarContribution): PluginCleanup;
}

export interface PluginClientContext extends PluginCommandCapabilities, PluginClientContextAliases {
  addCodeBlockActions(contribution: PluginCodeBlockActionsContribution): PluginCleanup;
  addSettingsScreen(contribution: PluginSettingsScreenContribution): PluginCleanup;
  addScreen(contribution: PluginScreenContribution): PluginCleanup;
  addSidebarHeaderItem(contribution: PluginSidebarItemContribution): PluginCleanup;
  addSidebarFooterItem(contribution: PluginSidebarItemContribution): PluginCleanup;
  addWorkspacePanel(contribution: PluginWorkspacePanelContribution): PluginCleanup;
  addCommandCenterItem(contribution: PluginCommandCenterItemContribution): PluginCleanup;
  addSlashCommand(contribution: PluginClientSlashCommandContribution): PluginCleanup;
  addHeaderButton(contribution: PluginHeaderButtonContribution): PluginButtonRegistration;
  addComposerPill(contribution: PluginComposerPillContribution): PluginButtonRegistration;
  addAttachmentSource(contribution: PluginAttachmentSourceContribution): PluginCleanup;
  addTheme(contribution: PluginThemeContribution): PluginCleanup;
  addTimelineTransformer<ItemType extends AgentTimelineItem["type"]>(
    contribution: PluginTimelineTransformerContribution<ItemType>,
  ): PluginCleanup;
  addTimelineRenderer<Schema extends ZodType>(
    contribution: PluginTimelineRendererContribution<Schema>,
  ): PluginCleanup;
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

export interface PluginSettingsScreenContribution {
  id: string;
  title: string;
  icon: string;
  Component: ComponentType<PluginSurfaceProps>;
}

/** The screen header's title: fixed, or derived from the params the screen was opened with. */
export type PluginScreenTitle = string | ((params: PluginScreenParams) => string);

export interface PluginScreenContribution {
  id: string;
  title: PluginScreenTitle;
  Component: ComponentType<PluginScreenProps>;
}

export interface PluginSurfaceContribution {
  id: string;
  Component: ComponentType<PluginSurfaceProps>;
}

/** @deprecated Use `PluginSidebarItemContribution` with `addSidebarHeaderItem`. */
export interface PluginSidebarContribution {
  id: string;
  title: string;
  icon: string;
  surface: string;
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
        phase: "streaming" | "complete";
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
  paseo: PaseoApi;
  rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    input: ZodInput<InputSchema>,
  ): Promise<ZodOutput<OutputSchema>>;
  openScreen(input: PluginOpenScreenInput): void;
  /** @deprecated Use `openScreen`. */
  openSurface(id: string): void;
  openSettings(id: string): void;
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

interface PluginClientSlashCommandBase {
  name: string;
  description: string;
  argumentHint: string;
}

export type PluginClientSlashCommandContribution =
  | (PluginClientSlashCommandBase & {
      context: "workspace";
      onSubmit(context: PluginWorkspaceCommandContext & { args: string }): void | Promise<void>;
    })
  | (PluginClientSlashCommandBase & {
      context: "agent";
      onSubmit(context: PluginAgentCommandContext & { args: string }): void | Promise<void>;
    });

export type SettingsState<Schema extends ZodType> = (
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "invalid"; error: string; revision: string }
  | { status: "ready"; values: ZodOutput<Schema>; revision: string }
) & {
  saving: boolean;
  saveError: string | null;
  /** Save an entire document against the revision currently displayed. Never throws. */
  save(values: ZodOutput<Schema>, revision: string): Promise<boolean>;
  reset(): Promise<boolean>;
  reload(): Promise<void>;
};

/** Actions below an assistant fenced block; code remains owned by the Markdown renderer. */
export interface PluginCodeBlockActionsProps extends PluginNavigableHostProps {
  agentId: string;
  messageId: string;
  /** Zero-based index among all fences in this message, including unsupported languages. */
  blockIndex: number;
  code: string;
  language: string;
  /** Streaming includes text still being revealed. Never execute a streaming block. */
  phase: "streaming" | "complete";
}

export interface PluginCodeBlockActionsContribution {
  id: string;
  languages: readonly string[];
  Component: ComponentType<PluginCodeBlockActionsProps>;
}
