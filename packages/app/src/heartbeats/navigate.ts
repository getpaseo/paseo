import { router, type Href } from "expo-router";
import { buildSchedulesRoute, buildSettingsHostSectionRoute } from "@/utils/host-routes";

/**
 * Open one heartbeat on the Schedules screen. The route names the host as well
 * as the schedule, so a schedule id from one daemon cannot resolve against
 * another's.
 */
export function navigateToHeartbeat(target: { serverId: string; scheduleId: string }): void {
  router.push(buildSchedulesRoute(target) as Href);
}

/**
 * Open the host's own settings section, where the daemon version and its update
 * control live. Where a user goes when a host is too old for a feature.
 */
export function navigateToHostUpdate(serverId: string): void {
  router.push(buildSettingsHostSectionRoute(serverId, "host") as Href);
}
