export { OwnedSubscriptions, type OwnedSubscription, type SubscriptionObserver } from "./owned.js";
import { CLIENT_CAPS, type ClientCapability } from "@getpaseo/protocol/client-capabilities";

// Protocol support belongs to the installed client. Only browser hosting needs
// a resource supplied by the caller. Keep this exhaustive as the protocol evolves.
export const DEFAULT_CLIENT_CAPABILITIES = {
  [CLIENT_CAPS.ownedSubscriptions]: true,
  [CLIENT_CAPS.allProviders]: true,
  [CLIENT_CAPS.selectiveAgentTimeline]: true,
  [CLIENT_CAPS.reasoningMergeEnum]: true,
  [CLIENT_CAPS.customModeIcons]: true,
  [CLIENT_CAPS.terminalReflowableSnapshot]: true,
  [CLIENT_CAPS.providerSubagents]: true,
  [CLIENT_CAPS.projectUpdates]: true,
  [CLIENT_CAPS.compactProviderSnapshots]: true,
  [CLIENT_CAPS.providerSnapshotReferences]: true,
  [CLIENT_CAPS.timelineReplacementInvalidation]: true,
  [CLIENT_CAPS.timelineNotifications]: true,
  [CLIENT_CAPS.pluginTimelineItems]: true,
  [CLIENT_CAPS.workspaceSetupBlocked]: true,
  [CLIENT_CAPS.explicitEventSubscriptions]: true,
} satisfies Record<Exclude<ClientCapability, typeof CLIENT_CAPS.browserHost>, true>;

/** Calling releases demand; ready acknowledges the initial daemon membership. */
export type TimelineSubscription = (() => void) & {
  readonly ready: Promise<void>;
  readonly subscriptionId: string | null;
  release(): Promise<void>;
};
