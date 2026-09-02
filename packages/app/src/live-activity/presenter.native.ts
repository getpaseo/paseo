/**
 * Fleet presenter seam, native implementation. Wraps the local `paseo-live-activity` Expo module
 * (ActivityKit) per the fixed fleet-mode contract. Android has no Live Activities and gets the
 * same no-op behavior as web via the `isSupported()`/`Platform.OS` gate below.
 */

import { Platform } from "react-native";
import PaseoLiveActivityModule, { type LiveActivityContentState } from "paseo-live-activity";
import {
  buildLiveActivityHeroDeepLink,
  buildLiveActivityPermissionPrimaryDeepLink,
  buildLiveActivityPermissionReviewDeepLink,
} from "./deep-link";
import type { FleetHero, FleetSnapshot } from "./fleet-snapshot";
import type { FleetReceipt } from "./presenter";

/** Grace window after the final "finished" frame before ActivityKit dismisses the activity. */
const FINISHED_DISMISS_AFTER_SECONDS = 5;

interface HeroActionLinks {
  primaryActionLabel?: string;
  primaryActionDeepLink?: string;
  secondaryActionLabel?: string;
  secondaryActionDeepLink?: string;
}

/** Opens the exact hero/request: the permission review URL when one is pending, else the hero. */
function heroDeepLinkFor(hero: FleetHero): string {
  const target = { serverId: hero.serverId, agentId: hero.agentId };
  if (hero.permissionRequestId !== undefined) {
    return buildLiveActivityPermissionReviewDeepLink({
      ...target,
      permissionRequestId: hero.permissionRequestId,
    });
  }
  return buildLiveActivityHeroDeepLink(target);
}

/** Presenter action mapping from the fixed fleet-mode contract. */
function heroActionLinks(hero: FleetHero): HeroActionLinks {
  const target = { serverId: hero.serverId, agentId: hero.agentId };
  if (hero.state === "running") {
    return {
      primaryActionLabel: "Open agent",
      primaryActionDeepLink: buildLiveActivityHeroDeepLink(target),
    };
  }
  if (hero.state === "error") {
    return {
      primaryActionLabel: "View error",
      primaryActionDeepLink: buildLiveActivityHeroDeepLink(target),
    };
  }
  if (hero.permissionRequestId === undefined) {
    return {
      primaryActionLabel: "Review",
      primaryActionDeepLink: buildLiveActivityHeroDeepLink(target),
    };
  }
  const reviewTarget = { ...target, permissionRequestId: hero.permissionRequestId };
  if (hero.permissionPrimaryAction === undefined) {
    return {
      primaryActionLabel: "Review",
      primaryActionDeepLink: buildLiveActivityPermissionReviewDeepLink(reviewTarget),
    };
  }
  return {
    primaryActionLabel: hero.permissionPrimaryAction.label,
    primaryActionDeepLink: buildLiveActivityPermissionPrimaryDeepLink({
      ...reviewTarget,
      permissionActionId: hero.permissionPrimaryAction.id,
    }),
    secondaryActionLabel: "Review",
    secondaryActionDeepLink: buildLiveActivityPermissionReviewDeepLink(reviewTarget),
  };
}

function contentStateFromHero(hero: FleetHero, snapshot: FleetSnapshot): LiveActivityContentState {
  return {
    heroTitle: hero.title,
    heroState: hero.state,
    sinceMs: hero.sinceMs,
    phase: hero.phase,
    todoDone: hero.todoDone,
    todoTotal: hero.todoTotal,
    permissionToolName: hero.permissionToolName,
    needsYouCount: snapshot.needsYouCount,
    runningCount: snapshot.runningCount,
    heroDeepLink: heroDeepLinkFor(hero),
    ...heroActionLinks(hero),
  };
}

export function supported(): boolean {
  return Platform.OS === "ios" && PaseoLiveActivityModule.isSupported();
}

export async function start(snapshot: FleetSnapshot): Promise<void> {
  if (!supported() || snapshot.hero === null) {
    return;
  }
  await PaseoLiveActivityModule.start(
    snapshot.hero.serverId,
    contentStateFromHero(snapshot.hero, snapshot),
  );
}

export async function update(snapshot: FleetSnapshot): Promise<void> {
  if (!supported() || snapshot.hero === null) {
    return;
  }
  await PaseoLiveActivityModule.update(
    snapshot.hero.serverId,
    contentStateFromHero(snapshot.hero, snapshot),
  );
}

export async function end(receipt: FleetReceipt): Promise<void> {
  if (!supported()) {
    return;
  }
  const heroDeepLink = buildLiveActivityHeroDeepLink({
    serverId: receipt.serverId,
    agentId: receipt.agentId,
  });
  await PaseoLiveActivityModule.end(
    receipt.serverId,
    {
      heroTitle: receipt.finishedTitle,
      heroState: "finished",
      sinceMs: Date.now(),
      needsYouCount: 0,
      runningCount: 0,
      heroDeepLink,
      primaryActionLabel: "View result",
      primaryActionDeepLink: heroDeepLink,
    },
    FINISHED_DISMISS_AFTER_SECONDS,
  );
}
