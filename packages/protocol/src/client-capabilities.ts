export const CLIENT_CAPS = {
  // COMPAT(selectiveAgentTimeline): added in v0.1.106. Capable clients receive
  // agent streams only for their explicit viewed set. Remove after 2027-01-12
  // once the supported client floor is >= v0.1.106.
  selectiveAgentTimeline: "selective_agent_timeline",
  reasoningMergeEnum: "reasoning_merge_enum",
  // COMPAT(customModeIcons): added in v0.1.84. Old clients pin AgentModeIcon to
  // a closed enum and crash rendering unknown values; daemon downgrades icons
  // outside the legacy set to "ShieldCheck" when this cap is absent. Drop the
  // gate when floor >= v0.1.84.
  customModeIcons: "custom_mode_icons",
  // COMPAT(terminalReflowableSnapshot): added in v0.1.88. The daemon attaches
  // per-row soft-wrap flags (gridWrapped/scrollbackWrapped) to terminal snapshots
  // only when the client advertises this, so restored content can reflow on resize.
  // Old clients use a strict TerminalState schema and would reject the extra fields.
  // Drop the gate (always send the flags) when floor >= v0.1.88.
  terminalReflowableSnapshot: "terminal_reflowable_snapshot",
  // COMPAT(providerSubagents): added in v0.1.107. The daemon emits provider-owned
  // child descriptors and timelines only to clients that understand the new messages.
  providerSubagents: "provider_subagents",
  // COMPAT(projectUpdates): added in v0.1.109, remove gate after 2027-01-15.
  projectUpdates: "project_updates",
  // COMPAT(compactProviderSnapshots): added in v0.2.X. Capable clients receive
  // provider catalogs with shared thinking sets and may revalidate by content hash.
  // Remove the legacy snapshot encoding after 2027-02-04.
  compactProviderSnapshots: "compact_provider_snapshots",
  // COMPAT(timelineReplacementInvalidation): added in v0.5.0, remove legacy
  // reconstructed timeline replay after 2027-02-21 once the client floor supports invalidation.
  timelineReplacementInvalidation: "timeline_replacement_invalidation",
  browserHost: "browser_host",
  // COMPAT(durableDeliveries): added in v0.7.2; remove after 2027-03-31 once client floor >= v0.7.2 and daemon floor >= v0.7.2.
  durableDeliveries: "durable_deliveries",
  // COMPAT(deliveryPayloadTombstones): added in v0.7.3; remove after 2027-03-31 once client floor >= v0.7.3 and daemon floor >= v0.7.3.
  deliveryPayloadTombstones: "delivery_payload_tombstones",
  // COMPAT(pluginCallerHostApis): added in v0.8.0-beta.1; remove after 2027-04-30
  // once the supported client floor includes caller-scoped plugin host APIs.
  pluginCallerHostApis: "plugin_caller_host_apis",
} as const;

export type ClientCapability = (typeof CLIENT_CAPS)[keyof typeof CLIENT_CAPS];
