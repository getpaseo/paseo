type BackgroundAgentAction = "create" | "resume";
type OfflineAction =
  | "create"
  | "resume"
  | "dictation"
  | "import_list";

type AnalyticsEvent =
  | {
      type: "daemon_active_changed";
      daemonId: string;
      previousDaemonId: string | null;
      source?: string;
    }
  | {
    type: "background_agent_action";
    action: BackgroundAgentAction;
    daemonId: string;
    activeDaemonId: string | null;
    isBackground: boolean;
    cwd?: string;
    provider?: string;
    modeId?: string;
    model?: string;
    baseBranch?: string;
  }
  | {
      type: "offline_daemon_action_attempt";
      action: OfflineAction;
      daemonId: string | null;
      activeDaemonId: string | null;
      status: string | null;
      isBackground: boolean;
      reason?: string | null;
    };

export function trackAnalyticsEvent(event: AnalyticsEvent) {
  try {
    const payload = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    console.info("[Analytics]", payload);
  } catch (error) {
    console.error("[Analytics] Failed to emit event", error);
  }
}
