type OfflineAction = "create" | "resume" | "dictation" | "import_list";

type AnalyticsEvent =
  | {
      type: "daemon_active_changed";
      daemonId: string;
      previousDaemonId: string | null;
      source?: string;
    }
  | {
      type: "offline_daemon_action_attempt";
      action: OfflineAction;
      daemonId: string | null;
      status: string | null;
      reason?: string | null;
    };

export function trackAnalyticsEvent(_event: AnalyticsEvent) {
  // Placeholder until a real analytics sink is wired in.
}
