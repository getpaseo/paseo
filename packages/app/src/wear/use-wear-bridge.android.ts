import { useEffect, useRef } from "react";
import {
  addWearCommandListener,
  drainPendingWearCommands,
  isWearBridgeSupported,
  publishWearLiveVoice,
  publishWearProjectIcon,
  publishWearSnapshot,
  publishWearTranscript,
} from "@getpaseo/expo-wear-bridge";

import { useLiveVoiceRuntimeOptional } from "@/contexts/live-voice-context";
import { readLiveVoiceAvailability } from "@/live-voice/live-voice-availability";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { WearBridge, type NewAgentConfig, type WearLiveVoiceController } from "./wear-bridge";
import type { WearSnapshotInput } from "./wear-snapshot";

/**
 * Republish cadence for changes the store doesn't notify us about — mainly agent
 * age, which is derived from wall-clock time rather than state. Snapshot publishing
 * short-circuits when the payload is unchanged, so an idle tick costs almost nothing.
 */
const AGE_REFRESH_MS = 60_000;

/**
 * Mounts the phone half of the Wear bridge for the lifetime of the app.
 *
 * No-ops entirely when the native module is absent (iOS, web, F-Droid builds), so
 * it is safe to call unconditionally.
 */
export function useWearBridge(): void {
  const bridgeRef = useRef<WearBridge | null>(null);
  // Stable for the provider's lifetime, so this only re-runs if Live Voice is
  // torn down entirely — not on any call state change, which the bridge
  // subscribes to itself.
  const liveVoiceRuntime = useLiveVoiceRuntimeOptional();

  useEffect(() => {
    if (!isWearBridgeSupported) return;

    const readState = (): WearSnapshotInput[] => {
      const sessions = useSessionStore.getState().sessions;
      return Object.entries(sessions).map(([serverId, session]) => ({
        serverId,
        agents: Array.from(session.agents.values()),
        workspaces: session.workspaces,
      }));
    };

    const resolveNewAgentConfig = (
      serverId: string,
      workspaceId: string,
    ): NewAgentConfig | null => {
      const session = useSessionStore.getState().sessions[serverId];
      const workspace = session?.workspaces.get(workspaceId);
      if (!session || !workspace) return null;

      // Reuse whatever provider this workspace used most recently. The watch has no
      // provider picker, and silently defaulting to a provider the user never chose
      // for this workspace would be surprising.
      const candidates = Array.from(session.agents.values())
        .filter((agent) => agent.workspaceId === workspaceId && !agent.archivedAt)
        .sort((left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime());

      const provider = candidates[0]?.provider;
      if (!provider) return null;

      return { provider, cwd: workspace.workspaceDirectory };
    };

    const liveVoice: WearLiveVoiceController | undefined = liveVoiceRuntime
      ? {
          subscribe: liveVoiceRuntime.subscribe,
          getSnapshot: liveVoiceRuntime.getSnapshot,
          readAvailability: readLiveVoiceAvailability,
          // Background mode: a call placed from the wrist is one where the phone
          // is in a pocket, so it has to survive the screen going off.
          start: (serverId) => liveVoiceRuntime.start(serverId, "background"),
          stop: liveVoiceRuntime.stop,
          toggleMute: liveVoiceRuntime.toggleMute,
        }
      : undefined;

    const bridge = new WearBridge({
      transport: {
        publishSnapshot: publishWearSnapshot,
        publishTranscript: publishWearTranscript,
        publishProjectIcon: publishWearProjectIcon,
        publishLiveVoice: publishWearLiveVoice,
        addCommandListener: addWearCommandListener,
        drainPendingCommands: drainPendingWearCommands,
      },
      readState,
      getClient: (serverId) => getHostRuntimeStore().getClient(serverId),
      resolveNewAgentConfig,
      ...(liveVoice ? { liveVoice } : {}),
      logger: {
        warn: (message, error) => console.warn(`[wear] ${message}`, error ?? ""),
      },
    });
    bridgeRef.current = bridge;
    void bridge.start();

    // Any session-store change is a candidate for republishing; the bridge diffs the
    // payload so unrelated changes cost one JSON build and nothing else.
    const unsubscribeStore = useSessionStore.subscribe(() => {
      void bridge.publish();
    });

    const interval = setInterval(() => {
      void bridge.publish();
    }, AGE_REFRESH_MS);

    return () => {
      clearInterval(interval);
      unsubscribeStore();
      bridge.stop();
      bridgeRef.current = null;
    };
  }, [liveVoiceRuntime]);
}
