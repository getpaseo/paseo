import { useEffect, useMemo, useState } from "react";
import type { RecentlyDoneRecency } from "@/hooks/sidebar-status-view-model";
import { useNowTick } from "@/hooks/use-now-tick";
import { useAppSettings } from "@/hooks/use-settings";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import {
  resolveRecencyTiming,
  resolveServerClockOffsetMs,
} from "@/components/sidebar/recently-done-recency";

const CLOCK_CALIBRATION_INTERVAL_MS = 60_000;
const EMPTY_CLOCK_OFFSETS = new Map<string, number>();

/** Returns `undefined` and schedules no timer while the sidebar cannot render the group. */
export function useRecentlyDoneRecency(active: boolean): RecentlyDoneRecency | undefined {
  const { recentlyDoneWindowMinutes } = useAppSettings().settings.appearance;
  const isStatusMode = useSidebarViewStore((state) => state.groupMode === "status");
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const { windowMs, tickIntervalMs } = resolveRecencyTiming({
    active,
    isStatusMode,
    recentlyDoneWindowMinutes,
  });
  const clientNow = useNowTick(tickIntervalMs);
  const [serverClockOffsetMsByServerId, setServerClockOffsetMsByServerId] =
    useState<ReadonlyMap<string, number>>(EMPTY_CLOCK_OFFSETS);

  useEffect(() => {
    if (tickIntervalMs === null) {
      setServerClockOffsetMsByServerId(EMPTY_CLOCK_OFFSETS);
      return;
    }

    let cancelled = false;
    async function calibrate(): Promise<void> {
      const samples = await Promise.all(
        serverIds.map(async (serverId) => {
          const client = getHostRuntimeStore().getClient(serverId);
          if (!client) return null;
          try {
            const pong = await client.ping();
            return [
              serverId,
              resolveServerClockOffsetMs({
                clientSentAt: pong.clientSentAt,
                clientReceivedAt: Date.now(),
                serverReceivedAt: pong.serverReceivedAt,
                serverSentAt: pong.serverSentAt,
              }),
            ] as const;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      setServerClockOffsetMsByServerId(
        new Map(samples.filter((sample): sample is readonly [string, number] => sample !== null)),
      );
    }

    void calibrate();
    const calibrationTimer = setInterval(() => void calibrate(), CLOCK_CALIBRATION_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(calibrationTimer);
    };
  }, [serverIds, tickIntervalMs]);

  return useMemo(
    () => (windowMs > 0 ? { windowMs, clientNow, serverClockOffsetMsByServerId } : undefined),
    [clientNow, serverClockOffsetMsByServerId, windowMs],
  );
}
