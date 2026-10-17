export type {
  PluginHostProps,
  PluginSurfaceProps,
  PluginScreenProps,
  PluginPopoverProps,
  PluginScreenParams,
  PluginOpenScreenInput,
  PluginScreenLocation,
  PluginSidebarItemProps,
  PluginSidebarItemContribution,
  PluginIconProps,
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
export { usePaseo } from "./paseo-context.js";
export { useAgent, useWorkspace } from "./client-state.js";
export { useRpc } from "./rpc-context.js";
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
/** A Remote SSH host to register with `addRemoteSshHost`. */
export interface PluginRemoteSshHostInput {
  /** `ssh://user@host[:port][?daemonPort=N]`, the form Settings → Add host → Remote SSH accepts. */
  readonly target: string;
  /** Host label; defaults to the daemon's hostname. */
  readonly label?: string;
  /** Daemon password when the remote daemon requires one. */
  readonly password?: string;
}
/**
 * Register a Remote SSH host or update the host with the same address. Connects first and saves
 * the host under the server ID the daemon reports; nothing is saved when the connection fails.
 * Desktop only. Supplied by the app's client bundle loader.
 */
export declare function addRemoteSshHost(
  input: PluginRemoteSshHostInput,
): Promise<PluginHostSummary>;
/** Remove a configured host. Rejects an unknown ID and the host this installation runs on. */
export declare function removeHost(serverId: string): Promise<void>;
/** Open an absolute HTTP(S) URL using the client platform’s external opener. */
export declare function openExternalUrl(url: string): Promise<void>;
