export type {
  PluginHostProps,
  PluginTab,
  PluginPanelProps,
  PluginWorkspacePanelParams,
  PluginAgentPanelParams,
  PluginFilePanelParams,
  PluginAgentPanelContribution,
  PluginFilePanelContribution,
  PluginFilePanelProps,
  PluginSurfaceProps,
  PluginScreenProps,
  PluginPopoverProps,
  PluginScreenParams,
  PluginOpenScreenInput,
  PluginScreenLocation,
  PluginSidebarItemProps,
  PluginSidebarViewProps,
  PluginSidebarViewContribution,
  PluginSidebarItemContribution,
  PluginIcon,
  PluginPanelLocation,
  PluginOpenPanelOptions,
  PluginWorkspacePanelProps,
  PluginAgentPanelProps,
  PluginClientOpenPanelOptions,
  PluginClientContext,
  PluginClientContribution,
  PluginWorkspacePanelContribution,
  PluginSettingsScreenContribution,
  PluginSurfaceContribution,
  PluginScreenContribution,
  PluginScreenTitle,
  PluginSidebarContribution,
  PluginTimelineTransformerContribution,
  PluginTimelineItemProps,
  PluginTimelineRendererContribution,
  PluginCommandCapabilities,
  PluginGlobalCommandContext,
  PluginWorkspaceCommandContext,
  PluginAgentCommandContext,
  PluginCommandCenterItemContribution,
  PluginClientSlashCommandContribution,
  SettingsState,
} from "./contracts.js";
export type {
  PluginButton,
  PluginButtonBehavior,
  PluginButtonContentProps,
  PluginButtonContext,
  PluginButtonIcon,
  PluginButtonIconProps,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginComposerPillContribution,
  PluginComposerToolbarButtonContribution,
  PluginHeaderButtonContribution,
  PluginVerticalBarButtonContribution,
} from "./buttons.js";
export type { PluginIconProps, PluginSerializableIcon, PluginSvgIcon } from "../icons.js";
export type {
  PluginFile,
  PluginFileBytesState,
  PluginFileEvent,
  PluginFileTextState,
  PluginFileUrlState,
  PluginFileWriteOptions,
} from "./file.js";
export {
  PluginFileConflictError,
  PluginFileDeletedError,
  useFileBytes,
  useFileText,
  useFileUrl,
} from "./file.js";
export { usePaseo } from "./paseo-context.js";
export {
  useAgent,
  useWorkspace,
  useProject,
  useTerminal,
  useWorkspaces,
  useAgents,
  useProjects,
  useTerminals,
} from "./client-state.js";
export { useComposer, useComposers } from "./composer.js";
export type {
  PluginComposer,
  PluginComposerAttachment,
  PluginComposerFocusOptions,
  PluginComposerItemContribution,
  PluginComposerItemProps,
  PluginComposerSelector,
} from "./composer.js";
export { useNewWorkspace } from "./new-workspace.js";
export type {
  PluginNewWorkspace,
  PluginNewWorkspaceItemContribution,
  PluginNewWorkspaceItemProps,
} from "./new-workspace.js";
export { useRpc, useSubscription, type PluginSubscriptionState } from "./rpc-context.js";
export type {
  PluginSubscribeOptions,
  PluginSubscriptionClosed,
  PluginSubscriptionHandle,
} from "../rpc.js";
import type { SettingsDefinition } from "../settings.js";
import type { SettingsState } from "./contracts.js";
import type { ZodType } from "zod";
export declare function useSettings<Schema extends ZodType>(
  definition: SettingsDefinition<Schema>,
): SettingsState<Schema>;

/** Configured app host, including hosts that are currently disconnected. */
export interface PluginHostSummary {
  readonly serverId: string;
  readonly label: string;
  readonly status: "idle" | "connecting" | "online" | "offline" | "error";
}
/** Live configured hosts. Supplied by the app's client bundle loader. */
export declare function useHosts(): readonly PluginHostSummary[];
/** Borrow an online host's API under this installation's lifetime. */
export declare function getPaseoClient(serverId: string): import("@getpaseo/client").PaseoApi;
/** Open an absolute HTTP(S) URL using the client platform’s external opener. */
export declare function openExternalUrl(url: string): Promise<void>;

/**
 * The system vertical bar: the side rail a folded iPhone uses for the status bar and bar items.
 * `edge` is "none" on every other device, window size, and platform.
 */
export interface PluginVerticalBar {
  readonly edge: "none" | "leading" | "trailing";
  readonly behavior: "automatic" | "disabled";
}
/** The window's vertical bar, live. Supplied by the app's client bundle loader. */
export declare function useVerticalBar(): PluginVerticalBar;
/** The window's vertical bar now, for code outside components. */
export declare function getVerticalBar(): PluginVerticalBar;
/** Calls `listener` whenever the vertical bar's edge or behavior changes. Returns the remover. */
export declare function subscribeVerticalBar(listener: () => void): () => void;
/**
 * "disabled" moves the status bar to the top and gives the bar's column to Paseo's content;
 * "automatic" restores the system bar. Does nothing where `edge` is "none".
 */
export declare function setVerticalBarBehavior(behavior: PluginVerticalBar["behavior"]): void;

export { defineTranslations, useTranslation } from "./translations.js";
export type { PluginI18n } from "./translations.js";
export type { PluginText, PluginMessage, PluginTranslations } from "../text.js";

export { useTabState } from "./tab.js";

export type { WorkspaceRef, AgentRef, ProjectRef, TerminalRef } from "../refs.js";
export type { Query, Group, GroupKey } from "./query.js";

export type { PluginPaseoApi, PluginProjectHandle, PluginTerminalHandle } from "./reference-api.js";
