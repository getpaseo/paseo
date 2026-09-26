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
import type { PluginForgeClientProviderContribution } from "../forge.js";

export interface PluginHostProps {
  theme: PluginTheme;
  host: {
    id: string;
    label: string;
  };
  layout: {
    compact: boolean;
    platform: "ios" | "android" | "web";
    /**
     * Safe-area insets of the window, in points: the status bar, notch, and home indicator.
     * Undefined on older hosts; fall back to your own constant when absent.
     */
    insets?: PluginSafeAreaInsets;
  };
}

export interface PluginSafeAreaInsets {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface PluginNavigableHostProps extends PluginHostProps {
  /** Client-owned navigation. Undefined on older hosts; hide dependent affordances when absent. */
  readonly navigation?: {
    /** Present only on Electron. The browser runs locally; serverId selects workspace ownership. */
    readonly openBrowser?: (input: {
      readonly url: string;
      readonly workspaceId: string;
      readonly serverId?: string;
    }) => void;
    readonly openAgent: (input: { readonly agentId: string; readonly serverId?: string }) => void;
    readonly openWorkspace: (input: {
      readonly workspaceId: string;
      readonly serverId?: string;
    }) => void;
    readonly openAgentLaunch?: (
      request: PluginAgentLaunchRequest,
    ) => Promise<PluginAgentLaunchOpenResult>;
    /** Opens one of this plugin's registered surfaces. Undefined on older hosts. */
    readonly openSurface?: (id: string) => void;
    /**
     * Mounts `Component` outside the caller, over the current page, so it outlives a closing
     * popover or panel. Undefined on older hosts.
     */
    readonly openOverlay?: (Component: ComponentType<PluginOverlayProps>) => PluginOverlayHandle;
  };
}

/**
 * Props of a component opened with `openOverlay`. It renders an `Overlay` from
 * `@getpaseo/plugin/client/react-native`; the host mounts nothing else.
 */
export interface PluginOverlayProps extends PluginNavigableHostProps {
  /** Unmounts the component. Idempotent. */
  close(): void;
}

export interface PluginOverlayHandle {
  /** Unmounts the component. Idempotent. */
  close(): void;
}

export interface PluginAgentLaunchRequest {
  launchId: string;
  documentIncarnationId: string;
  requestFingerprint: string;
  projectId: string;
  defaultWorkspaceId?: string;
  title?: string;
  seedPrompt: string;
  clientMessageId: string;
  labels: Readonly<Record<string, string>>;
  expectedClientInstanceId?: string;
  workspace: {
    allowExisting: boolean;
    allowCreate: boolean;
  };
  onEvent?: (event: PluginAgentLaunchEvent) => void;
}

export type PluginAgentLaunchOpenResult =
  | {
      status: "opened" | "restored";
      clientInstanceId: string;
      journalVersion: number;
      submissionState: "editable" | "outcome_unknown_readonly";
    }
  | {
      status: "completed";
      clientInstanceId: string;
      journalVersion: number;
      terminalOutcome: "agent_known" | "discarded";
      workspaceId?: string;
      agentId?: string;
    }
  | {
      status: "rejected";
      code:
        | "wrong_device"
        | "launch_key_conflict"
        | "journal_invalid"
        | "journal_persist_failed"
        | "no_eligible_workspace";
      message: string;
    };

export type PluginAgentLaunchEvent =
  | { type: "journal_ready"; clientInstanceId: string; journalVersion: number }
  | { type: "workspace_request_started"; journalVersion: number }
  | { type: "workspace_created"; workspaceId: string; journalVersion: number }
  | { type: "agent_request_started"; workspaceId: string; journalVersion: number }
  | { type: "agent_created"; workspaceId: string; agentId: string; journalVersion: number }
  | { type: "discarded"; certainty: "not_submitted"; journalVersion: number }
  | {
      type: "failed";
      stage: "journal" | "open" | "workspace_create" | "agent_create";
      certainty: "not_submitted" | "outcome_unknown";
      message: string;
      workspaceId?: string;
      journalVersion?: number;
    };

export interface PluginSurfaceProps extends PluginNavigableHostProps {}

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

export interface PluginClientContext extends PluginCommandCapabilities {
  addSettingsScreen(contribution: PluginSettingsScreenContribution): PluginCleanup;
  addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): PluginCleanup;
  addSidebarItem(contribution: PluginSidebarContribution): PluginCleanup;
  /** Set a sidebar item's count. Undefined on older hosts; the item still renders without it. */
  setSidebarBadge?(id: string, badge: number | null): void;
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
  addForgeClientProvider(contribution: PluginForgeClientProviderContribution): PluginCleanup;
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

export interface PluginSurfaceContribution {
  id: string;
  Component: ComponentType<PluginSurfaceProps>;
}

export interface PluginSidebarContribution {
  id: string;
  title: string;
  icon: string;
  surface: string;
  /** Count beside the item. Zero and undefined render nothing. */
  badge?: number;
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

export interface PluginTimelineItemProps<Data = unknown> extends PluginNavigableHostProps {
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

export interface PluginNotifier {
  /** Confirms an action the user just took. */
  success(message: string): void;
  info(message: string): void;
  error(message: string): void;
}

export interface PluginCommandCapabilities {
  paseo: PaseoApi;
  /** Transient app-level feedback. Undefined on older hosts; skip the message when absent. */
  notify?: PluginNotifier;
  rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    input: ZodInput<InputSchema>,
  ): Promise<ZodOutput<OutputSchema>>;
  openSurface(id: string): void;
  openSettings(id: string): void;
  /**
   * Mounts `Component` over the page the user is on, without navigating. Undefined on older
   * hosts. See `PluginOverlayProps`.
   */
  openOverlay?(Component: ComponentType<PluginOverlayProps>): PluginOverlayHandle;
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
  /**
   * Default keybinding, in Paseo's combo grammar: modifiers `Mod`, `Cmd`, `Ctrl`, `Alt`, `Shift`
   * joined to one key with `+` ("Mod+Shift+T"), chords separated by a space. Ignored by hosts that
   * do not support it, and by any host where a built-in shortcut already claims the keys.
   */
  shortcut?: string;
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
