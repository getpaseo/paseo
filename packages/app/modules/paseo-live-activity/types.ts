/**
 * Wire contract between the JS controller and ActivityKit.
 *
 * Field names are the Codable keys of `PaseoFleetAttributes.ContentState` in
 * `targets/paseo-live-activity/PaseoFleetAttributes.swift`. Renaming a field
 * here without renaming it there breaks the bridge silently.
 */

export type LiveActivityHeroState = "running" | "needs_you" | "error" | "finished";

export interface LiveActivityContentState {
  heroTitle: string;
  heroState: LiveActivityHeroState;
  /** epoch ms; drives Text(timerInterval:) client-side */
  sinceMs: number;
  phase?: string;
  todoDone?: number;
  todoTotal?: number;
  permissionToolName?: string;
  needsYouCount: number;
  runningCount: number;
  /** opens the exact hero agent; used for widgetURL on Lock Screen/banner/compact/minimal */
  heroDeepLink: string;
  primaryActionLabel?: string;
  primaryActionDeepLink?: string;
  secondaryActionLabel?: string;
  secondaryActionDeepLink?: string;
}

export interface PaseoLiveActivityModule {
  /** false on Android, web, iOS < 16.2, or Activities disabled in Settings */
  isSupported(): boolean;
  /**
   * Idempotent per daemon: replaces this server's activity and leaves activities
   * belonging to other daemons alone. `serverId` becomes the activity's static
   * `PaseoFleetAttributes.serverId`, which is how the native side finds this
   * server's activity again after an app relaunch.
   */
  start(serverId: string, state: LiveActivityContentState): Promise<void>;
  /** no-op when this server has no live activity */
  update(serverId: string, state: LiveActivityContentState): Promise<void>;
  /** pushes this server's final frame, dismisses after dismissAfterSeconds */
  end(
    serverId: string,
    state: LiveActivityContentState,
    dismissAfterSeconds: number,
  ): Promise<void>;
}
