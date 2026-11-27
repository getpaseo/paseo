export type {
  PluginHostProps,
  PluginHostNavigationActions,
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
  PluginWorkspaceRowBadgeItemProps,
  PluginWorkspaceRowBadgeItemContribution,
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
  PluginNotificationOpenEvent,
  PluginNotificationOpenContext,
  PluginNotificationOpenHandler,
} from "./notifications.js";
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
  PluginHeaderButtonContribution,
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

/** A workspace row badge item that a plugin contributes, as listed for a sidebar view. */
export interface WorkspaceRowBadgeItem {
  /** `<pluginId>/<itemId>`, the same on every host. */
  readonly key: string;
  readonly pluginId: string;
  readonly itemId: string;
  /** The item's title in the app language. */
  readonly title: string;
  readonly icon: import("./contracts.js").PluginIcon;
  /** Hosts whose copy of the plugin contributes the item; it draws only on their workspaces. */
  readonly hostIds: readonly string[];
}
/**
 * The workspace row badge items installed on any host, in install order, minus the ones hidden in Paseo's sidebar
 * display preferences, for drawing with `WorkspaceRowBadges`. Empty outside a sidebar view. Supplied by the app's
 * client bundle loader; apps older than this hook lack it, so check before calling.
 */
export declare function useWorkspaceRowBadgeItems(): readonly WorkspaceRowBadgeItem[];
/** Borrow an online host's API under this installation's lifetime. */
export declare function getPaseoClient(serverId: string): import("@getpaseo/client").PaseoApi;
/** Open an absolute HTTP(S) URL using the client platform’s external opener. */
export declare function openExternalUrl(url: string): Promise<void>;

export { defineTranslations, useTranslation } from "./translations.js";
export type { PluginI18n } from "./translations.js";
export type { PluginText, PluginMessage, PluginTranslations } from "../text.js";

export { useTabState } from "./tab.js";

export type { WorkspaceRef, AgentRef, ProjectRef, TerminalRef } from "../refs.js";
export type { Query, Group, GroupKey } from "./query.js";

export type { PluginPaseoApi, PluginProjectHandle, PluginTerminalHandle } from "./reference-api.js";
