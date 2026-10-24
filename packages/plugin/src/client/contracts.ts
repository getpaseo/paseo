import type { PluginText } from "../text.js";
import type { ComponentType } from "react";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem, JsonValue } from "@getpaseo/protocol/agent-types";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginFile } from "./file.js";
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
import type { PluginIconProps, PluginSerializableIcon } from "../icons.js";
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
    readonly openAgent: (input: {
      readonly agentId: string;
      readonly serverId?: string;
      /**
       * The first message of an agent the plugin just created, which the daemon sends once the
       * agent's first turn starts. The host shows it right away, as sending, until the daemon's
       * copy with the same `clientMessageId` arrives. Older hosts ignore it.
       */
      readonly pendingMessage?: PluginPendingAgentMessage;
    }) => void;
    /**
     * Withdraws a `pendingMessage` the daemon will not send, such as a launch that failed after
     * `openAgent`. A message the daemon already recorded stays. Undefined on older hosts.
     */
    readonly withdrawPendingAgentMessage?: (input: {
      readonly agentId: string;
      readonly clientMessageId: string;
      readonly serverId?: string;
    }) => void;
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

/** What `openAgent` shows of a created agent's first message before the daemon records it. */
export interface PluginPendingAgentMessage {
  readonly clientMessageId: string;
  readonly text: string;
  /** Images sent inline with the prompt: base64 without a data-URL prefix. */
  readonly images?: readonly { readonly data: string; readonly mimeType: string }[];
  /** Files on the daemon host sent with the prompt, shown as file pills. */
  readonly attachments?: readonly {
    readonly type: "uploaded_file";
    readonly id: string;
    readonly fileName: string;
    readonly mimeType: string;
    readonly size: number;
    readonly path: string;
  }[];
}

/**
 * Props of a component opened with `openOverlay`. It renders an `Overlay` from
 * `@getpaseo/plugin/client/ui`; the host mounts nothing else.
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

export interface PluginSidebarItemContribution<Text extends PluginText = string> {
  id: string;
  /** Settings row label, accessibility label, and default label for SidebarRow. */
  title: Text;
  Component: ComponentType<PluginSidebarItemProps>;
}

/**
 * A Lucide icon name, inline SVG markup, or a component. Components receive the surface's size
 * and color; buttons widen the props with their host and target context.
 */
export type PluginIcon<Props extends PluginIconProps = PluginIconProps> =
  | PluginSerializableIcon
  | ComponentType<Props>;

export type PluginPanelLocation = "workspace" | "explorer";

export interface PluginOpenPanelOptions {
  location?: PluginPanelLocation;
}

interface PluginWorkspacePanelBase<Text extends PluginText = string> {
  id: string;
  title: Text;
  icon: PluginIcon;
  locations?: readonly PluginPanelLocation[];
}

export interface PluginTab {
  /** Shows the tab's unsaved dot and asks before closing. */
  setModified(modified: boolean): void;
  /** Opaque persisted JSON. Undefined until written; the panel validates it. */
  readonly state: unknown;
  setState(state: JsonValue): void;
}

export interface PluginPanelProps<Params> extends PluginNavigableHostProps {
  workspaceId: string;
  readonly params: Readonly<Params>;
  revision: number;
  tab: PluginTab;
}
export interface PluginWorkspacePanelParams {}
export interface PluginAgentPanelParams {
  readonly agentId: string;
}
export interface PluginFilePanelParams {
  readonly path: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}
export interface PluginWorkspacePanelProps extends PluginPanelProps<PluginWorkspacePanelParams> {
  // COMPAT(pluginPanelFlatProps): added in v0.13.0, remove after 2027-04-23
  /** @deprecated Use the panel registration to select the context. */
  context: "workspace";
}
export interface PluginAgentPanelProps extends PluginPanelProps<PluginAgentPanelParams> {
  // COMPAT(pluginPanelFlatProps): added in v0.13.0, remove after 2027-04-23
  /** @deprecated Use the panel registration to select the context. */
  context: "agent";
  // COMPAT(pluginPanelFlatProps): added in v0.13.0, remove after 2027-04-23
  /** @deprecated Read `params.agentId`. */
  agentId: string;
}
export interface PluginFilePanelProps extends PluginPanelProps<PluginFilePanelParams> {
  file: PluginFile;
}

export interface PluginFilePanelContribution<Text extends PluginText = string> {
  id: string;
  title: Text;
  icon: PluginIcon;
  /** Extensions without the dot, case-insensitive, and exact filenames. */
  files: { extensions: readonly string[]; filenames?: readonly string[] };
  Component: ComponentType<PluginFilePanelProps>;
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
  addSidebarItem(contribution: PluginSidebarContribution<PluginText>): PluginCleanup;
  /** Set a sidebar item's count. Undefined on older hosts; the item still renders without it. */
  setSidebarBadge?(id: string, badge: number | null): void;
}

export interface PluginClientContext extends PluginCommandCapabilities, PluginClientContextAliases {
  readonly i18n: import("./translations.js").PluginI18n;
  /** Play a base64-encoded audio file on this client; resolves when playback ends. */
  playAudio(source: { base64: string; mimeType: string }): Promise<void>;
  addSettingsScreen(contribution: PluginSettingsScreenContribution<PluginText>): PluginCleanup;
  addScreen(contribution: PluginScreenContribution<PluginText>): PluginCleanup;
  addSidebarHeaderItem(contribution: PluginSidebarItemContribution<PluginText>): PluginCleanup;
  addSidebarFooterItem(contribution: PluginSidebarItemContribution<PluginText>): PluginCleanup;
  addAgentPanel(contribution: PluginAgentPanelContribution<PluginText>): PluginCleanup;
  addWorkspacePanel(contribution: PluginWorkspacePanelContribution<PluginText>): PluginCleanup;
  addCommandCenterItem(
    contribution: PluginCommandCenterItemContribution<PluginText>,
  ): PluginCleanup;
  addSlashCommand(contribution: PluginClientSlashCommandContribution<PluginText>): PluginCleanup;
  addHeaderButton(
    contribution: PluginHeaderButtonContribution<PluginText>,
  ): PluginButtonRegistration<PluginText>;
  addComposerPill(
    contribution: PluginComposerPillContribution<PluginText>,
  ): PluginButtonRegistration<PluginText>;
  addAttachmentSource(contribution: PluginAttachmentSourceContribution<PluginText>): PluginCleanup;
  addTheme(contribution: PluginThemeContribution<PluginText>): PluginCleanup;
  addFilePanel(contribution: PluginFilePanelContribution<PluginText>): PluginCleanup;
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

export type PluginWorkspacePanelContribution<Text extends PluginText = string> =
  | (PluginWorkspacePanelBase<Text> & {
      // COMPAT(pluginPanelFlatProps): added in v0.13.0, remove after 2027-04-23
      /** @deprecated Omit context. */
      context?: "workspace";
      Component: ComponentType<PluginWorkspacePanelProps>;
    })
  | (PluginWorkspacePanelBase<Text> & {
      // COMPAT(pluginAgentPanelAlias): added in v0.13.0, remove after 2027-04-23
      /** @deprecated Register with `addAgentPanel`. */
      context: "agent";
      Component: ComponentType<PluginAgentPanelProps>;
    });

export interface PluginAgentPanelContribution<
  Text extends PluginText = string,
> extends PluginWorkspacePanelBase<Text> {
  Component: ComponentType<PluginAgentPanelProps>;
}

export interface PluginSettingsScreenContribution<Text extends PluginText = string> {
  id: string;
  title: Text;
  icon: PluginIcon;
  Component: ComponentType<PluginSurfaceProps>;
}

/** The screen header's title: fixed, or derived from the params the screen was opened with. */
export type PluginScreenTitle<Text extends PluginText = string> =
  | Text
  | ((params: PluginScreenParams) => Text);

export interface PluginScreenContribution<Text extends PluginText = string> {
  id: string;
  title: PluginScreenTitle<Text>;
  Component: ComponentType<PluginScreenProps>;
}

export interface PluginSurfaceContribution {
  id: string;
  Component: ComponentType<PluginSurfaceProps>;
}

/** @deprecated Use `PluginSidebarItemContribution` with `addSidebarHeaderItem`. */
export interface PluginSidebarContribution<Text extends PluginText = string> {
  id: string;
  title: Text;
  icon: PluginIcon;
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
  openScreen(input: PluginOpenScreenInput): void;
  /** @deprecated Use `openScreen`. */
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

interface PluginCommandCenterItemBase<Text extends PluginText = string> {
  id: string;
  title: Text;
  icon: PluginIcon;
  keywords?: readonly string[];
  /**
   * Default keybinding, in Paseo's combo grammar: modifiers `Mod`, `Cmd`, `Ctrl`, `Alt`, `Shift`
   * joined to one key with `+` ("Mod+Shift+T"), chords separated by a space. Ignored by hosts that
   * do not support it, and by any host where a built-in shortcut already claims the keys.
   */
  shortcut?: string;
}

export type PluginCommandCenterItemContribution<Text extends PluginText = string> =
  | (PluginCommandCenterItemBase<Text> & {
      context: "global";
      onSelect(context: PluginGlobalCommandContext): void | Promise<void>;
    })
  | (PluginCommandCenterItemBase<Text> & {
      context: "workspace";
      onSelect(context: PluginWorkspaceCommandContext): void | Promise<void>;
    })
  | (PluginCommandCenterItemBase<Text> & {
      context: "agent";
      onSelect(context: PluginAgentCommandContext): void | Promise<void>;
    });

interface PluginClientSlashCommandBase<Text extends PluginText = string> {
  name: string;
  description: Text;
  argumentHint: Text;
}

export type PluginClientSlashCommandContribution<Text extends PluginText = string> =
  | (PluginClientSlashCommandBase<Text> & {
      context: "workspace";
      onSubmit(context: PluginWorkspaceCommandContext & { args: string }): void | Promise<void>;
    })
  | (PluginClientSlashCommandBase<Text> & {
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
