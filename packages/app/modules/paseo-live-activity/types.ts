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
  permissionDetail?: string;
  needsYouCount: number;
  runningCount: number;
}

export interface PaseoLiveActivityModule {
  /** false on Android, web, iOS < 16.2, or Activities disabled in Settings */
  isSupported(): boolean;
  /** idempotent: replaces any existing Paseo activity */
  start(state: LiveActivityContentState): Promise<void>;
  /** no-op when no activity is live */
  update(state: LiveActivityContentState): Promise<void>;
  /** pushes final frame, dismisses after dismissAfterSeconds */
  end(state: LiveActivityContentState, dismissAfterSeconds: number): Promise<void>;
}
