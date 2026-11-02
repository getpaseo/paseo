export const CLIENT_CAPS = {
  terminalChunkedReplay: "terminal_chunked_replay",
  binaryChunkingV1: "binary_chunking_v1",
  helloRejection: "hello_rejection",
  // COMPAT(ownedSubscriptions): added in v0.8.0, remove legacy ownership after 2027-03-09.
  ownedSubscriptions: "owned_subscriptions",
  // Clients outside the Paseo app version series can explicitly accept provider IDs.
  // COMPAT(explicitEventSubscriptions): added in v0.8.0, remove legacy broadcasts after 2027-03-08.
  explicitEventSubscriptions: "explicit_event_subscriptions",
  allProviders: "all_providers",
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
  // COMPAT(projectedSubagentTimeline): added after v0.8.0, remove gates after 2027-03-14; retain wire capability.
  projectedSubagentTimeline: "projected_subagent_timeline",
  // COMPAT(projectUpdates): added in v0.1.109, remove gate after 2027-01-15.
  projectUpdates: "project_updates",
  // COMPAT(compactProviderSnapshots): added in v0.2.X. Capable clients receive
  // provider catalogs with shared thinking sets and may revalidate by content hash.
  // Remove the legacy snapshot encoding after 2027-02-04.
  compactProviderSnapshots: "compact_provider_snapshots",
  providerSnapshotReferences: "provider_snapshot_references",
  // COMPAT(timelineReplacementInvalidation): added in v0.5.0, remove legacy
  // reconstructed timeline replay after 2027-02-21 once the client floor supports invalidation.
  timelineReplacementInvalidation: "timeline_replacement_invalidation",
  // COMPAT(timelineNotifications): added in v0.7.2. The daemon omits notification
  // timeline items for older clients whose strict timeline union rejects them.
  // Remove after 2027-03-03 once the supported client floor is >= v0.7.2.
  timelineNotifications: "timeline_notifications",
  // COMPAT(pluginTimelineItems): added in v0.8.0, remove after 2027-03-07 once client floor >= v0.8.0.
  pluginTimelineItems: "plugin_timeline_items",
  workspaceSetupObservation: "workspace_setup_observation",
  // COMPAT(workspaceSetupBlocked): added in v0.8.0, remove after 2027-03-07 once client floor >= v0.8.0.
  workspaceSetupBlocked: "workspace_setup_blocked",
  // COMPAT(goalControlEvents): added in v0.13.0. The daemon omits goal.paused,
  // goal.resumed, goal.retried and usage.recorded from goal.inspect events for older
  // clients whose strict event union rejects them. Remove after 2027-04-26.
  goalControlEvents: "goal_control_events",
  // COMPAT(goalAcknowledgeEvents): added in v0.13.0. The daemon omits goal.acknowledged
  // from goal.inspect events for older clients whose strict event union rejects it.
  // Remove after 2027-04-26.
  goalAcknowledgeEvents: "goal_acknowledge_events",
  // COMPAT(goalManagementEvents): added in v0.13.1. The daemon omits goal.renamed,
  // goal.priority_set, goal.archived and goal.unarchived from goal.inspect events for
  // older clients whose strict event union rejects them. Remove after 2027-04-26.
  goalManagementEvents: "goal_management_events",
  // COMPAT(goalConfigEdit): added in v0.13.3. The daemon omits goal.config_updated and
  // goal.reopened from goal.inspect events, and sends an "auto" permission policy as "wait",
  // for older clients whose strict schemas reject them. Remove after 2027-04-27.
  goalConfigEdit: "goal_config_edit",
  // COMPAT(goalUsageBreakdown): added in v0.13.3. The daemon leaves usageByRole,
  // usageBreakdown and usageBreakdownTruncated out of goals sent to older clients, which
  // cannot show them. Remove after 2027-04-27.
  goalUsageBreakdown: "goal_usage_breakdown",
  // COMPAT(goalIntegrationRetry): added in v0.13.10. The daemon omits
  // changeset.integration_retried from goal.inspect events for older clients whose strict
  // event union rejects it. Remove after 2027-04-27.
  goalIntegrationRetry: "goal_integration_retry",
  // COMPAT(goalPlanRevision): added in v0.13.13. The daemon omits plan.revision_proposed,
  // plan.revision_approved and plan.revision_rejected from goal.inspect events for older
  // clients whose strict event union rejects them. Remove after 2027-04-28.
  goalPlanRevision: "goal_plan_revision",
  // COMPAT(goalLeadInterventions): added in v0.13.13. The daemon omits intervention.requested
  // and intervention.resolved from goal.inspect events for older clients whose strict event
  // union rejects them. Remove after 2027-04-28.
  goalLeadInterventions: "goal_lead_interventions",
  // COMPAT(goalRecovery): added in v0.13.13. The daemon omits recovery.started,
  // recovery.decided and recovery.resolved from goal.inspect events, and recovery and guidance
  // from goal payloads, for older clients whose strict event union rejects them. Remove after
  // 2027-04-28.
  goalRecovery: "goal_recovery",
  // COMPAT(goalAccept): added in v0.13.14. The daemon omits goal.accepted from goal.inspect
  // events, and Goal.accepted and each criterion's `waived` from goal payloads, for older
  // clients whose strict event union rejects the event. Such a client shows an accepted goal
  // as plain completed with its waived criteria unverified. Remove after 2027-04-28.
  goalAccept: "goal_accept",
  // COMPAT(goalUserWait): added in v0.13.14. The daemon omits wait.started and wait.ended from
  // goal.inspect events for older clients whose strict event union rejects them. Remove after
  // 2027-04-28.
  goalUserWait: "goal_user_wait",
  browserHost: "browser_host",
} as const;

export type ClientCapability = (typeof CLIENT_CAPS)[keyof typeof CLIENT_CAPS];
