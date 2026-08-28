/**
 * Fleet presenter seam, native implementation. Wraps the local `paseo-live-activity` Expo module
 * (ActivityKit) per the fixed fleet-mode contract. Android has no Live Activities and gets the
 * same no-op behavior as web via the `isSupported()`/`Platform.OS` gate below.
 */

import { Platform } from "react-native";
import PaseoLiveActivityModule, { type LiveActivityContentState } from "paseo-live-activity";
import type { FleetHero, FleetSnapshot } from "./fleet-snapshot";
import type { FleetReceipt } from "./presenter";

/** Grace window after the final "finished" frame before ActivityKit dismisses the activity. */
const FINISHED_DISMISS_AFTER_SECONDS = 5;

function contentStateFromHero(hero: FleetHero, snapshot: FleetSnapshot): LiveActivityContentState {
  return {
    heroTitle: hero.title,
    heroState: hero.state,
    sinceMs: hero.sinceMs,
    phase: hero.phase,
    todoDone: hero.todoDone,
    todoTotal: hero.todoTotal,
    permissionToolName: hero.permissionToolName,
    permissionDetail: hero.permissionDetail,
    needsYouCount: snapshot.needsYouCount,
    runningCount: snapshot.runningCount,
  };
}

export function supported(): boolean {
  return Platform.OS === "ios" && PaseoLiveActivityModule.isSupported();
}

export async function start(snapshot: FleetSnapshot): Promise<void> {
  if (!supported() || snapshot.hero === null) {
    return;
  }
  await PaseoLiveActivityModule.start(contentStateFromHero(snapshot.hero, snapshot));
}

export async function update(snapshot: FleetSnapshot): Promise<void> {
  if (!supported() || snapshot.hero === null) {
    return;
  }
  await PaseoLiveActivityModule.update(contentStateFromHero(snapshot.hero, snapshot));
}

export async function end(receipt: FleetReceipt): Promise<void> {
  if (!supported()) {
    return;
  }
  await PaseoLiveActivityModule.end(
    {
      heroTitle: receipt.finishedTitle,
      heroState: "finished",
      sinceMs: Date.now(),
      needsYouCount: 0,
      runningCount: 0,
    },
    FINISHED_DISMISS_AFTER_SECONDS,
  );
}
