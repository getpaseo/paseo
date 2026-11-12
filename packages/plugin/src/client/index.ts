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
export type {
  PluginProviderSubagentRef,
  PluginSubagent,
  PluginSubagentMenuProps,
  PluginTabIconProps,
  PluginTabMenuProps,
  PluginTabPresentation,
  PluginWorkspaceTab,
  PluginWorkspaceTabKind,
  PluginWorkspaceTabs,
} from "./workspace-tabs.js";
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
import type { AgentRef, WorkspaceRef } from "../refs.js";
import type {
  PluginSubagent,
  PluginTabPresentation,
  PluginWorkspaceTabs,
} from "./workspace-tabs.js";
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

/**
 * A workspace's open tabs on this device, pane by pane in strip order, and the tab it opens on.
 * Tabs are app state, not daemon state.
 */
export declare function useWorkspaceTabs(workspace: WorkspaceRef): PluginWorkspaceTabs;

/**
 * An agent's subagents, oldest first: Paseo agents it started and the provider's own subagents.
 * Reading them fetches the provider's list when the host supports it. Pass `parentSubagentId`
 * for the children of a provider subagent.
 */
export declare function useSubagents(
  agent: AgentRef,
  options?: { parentSubagentId?: string },
): readonly PluginSubagent[];

/** The label, icon, status and facts line the app shows for a subagent row. */
export declare function useSubagentPresentation(subagent: PluginSubagent): PluginTabPresentation;
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
