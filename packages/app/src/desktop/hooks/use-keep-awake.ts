import { useEffect, useMemo, useState } from "react";
import { getIsElectron, isWeb } from "@/constants/platform";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";

interface BatteryManagerLike {
  level: number;
  addEventListener(type: "levelchange", listener: () => void): void;
  removeEventListener(type: "levelchange", listener: () => void): void;
}

function getBatteryManager(): Promise<BatteryManagerLike> | null {
  if (!isWeb || typeof navigator === "undefined") {
    return null;
  }
  const getBattery = (navigator as unknown as { getBattery?: () => Promise<BatteryManagerLike> })
    .getBattery;
  return typeof getBattery === "function" ? getBattery.call(navigator) : null;
}

// Only the renderer knows both "is any agent running" (daemon session state)
// and the battery level (navigator.getBattery() — Electron's main process has
// no battery API). Main re-derives the low-battery cutoff itself from the
// reported level rather than trusting a boolean, so a stale renderer signal
// can never keep the machine awake below 10%. See packages/desktop/src/features/keep-awake.ts.
export function useKeepAwake(): void {
  const { agents } = useAggregatedAgents();
  const { settings } = useDesktopSettings();
  const keepAwakeEnabled = settings.power.keepAwakeWhileAgentsRunning;

  // A host that has dropped its connection leaves its last-known agent status
  // (e.g. "running") sitting unchanged in the session store — only a full host
  // removal clears it. Require the owning host to be currently "online" so a
  // stale "running" reading from a disconnected host can't hold the block.
  const serverIds = useMemo(
    () => Array.from(new Set(agents.map((agent) => agent.serverId))),
    [agents],
  );
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const hasRunningAgent = agents.some(
    (agent) => agent.status === "running" && connectionStatuses.get(agent.serverId) === "online",
  );
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);

  useEffect(() => {
    if (!getIsElectron()) {
      return;
    }

    let manager: BatteryManagerLike | null = null;
    let disposed = false;
    const handleLevelChange = () => {
      if (manager) {
        setBatteryLevel(manager.level);
      }
    };

    void getBatteryManager()?.then((resolved) => {
      if (disposed) {
        return undefined;
      }
      manager = resolved;
      setBatteryLevel(resolved.level);
      resolved.addEventListener("levelchange", handleLevelChange);
      return undefined;
    });

    return () => {
      disposed = true;
      manager?.removeEventListener("levelchange", handleLevelChange);
    };
  }, []);

  useEffect(() => {
    if (!getIsElectron()) {
      return;
    }
    invokeDesktopCommand("desktop_set_keep_awake", {
      enabled: keepAwakeEnabled && hasRunningAgent,
      batteryLevel,
    }).catch((error) => {
      console.warn("[useKeepAwake] Failed to update keep-awake state", error);
    });
  }, [keepAwakeEnabled, hasRunningAgent, batteryLevel]);
}
