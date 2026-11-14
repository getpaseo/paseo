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

/** A surface whose text size the user can zoom, separately from the others. */
export type PluginTextZoomSurface = "chat" | "terminal" | "files";
/**
 * A surface's text zoom on this device: a multiplier on the size set in Settings → Appearance.
 * 1 is that size. Supplied by the app's client bundle loader.
 */
export declare function useTextZoom(surface: PluginTextZoomSurface): number;
/** A surface's text zoom now, for code outside components. */
export declare function getTextZoom(surface: PluginTextZoomSurface): number;
/** Calls `listener` whenever a text zoom changes. Returns the remover. */
export declare function subscribeTextZoom(listener: () => void): () => void;
/**
 * Sets a surface's text zoom and saves it on this device. Paseo clamps it to 0.5–3 in 5% steps.
 * Pass 1 to return the surface to its Appearance size.
 */
export declare function setTextZoom(surface: PluginTextZoomSurface, zoom: number): void;
/**
 * Lets a pinch on the surface change its text zoom: two fingers on iOS and Android, a trackpad
 * pinch or ctrl+wheel in a browser or the desktop app. The size changes live in 5% steps and is
 * saved when the pinch ends. Returns the function that turns it off; Paseo also turns it off when
 * the plugin stops.
 */
export declare function enablePinchTextZoom(surface: PluginTextZoomSurface): () => void;
