import { useEffect } from "react";

import {
  getReadAloudSnapshot,
  stopReadAloud,
  useReadAloudSnapshot,
} from "@/read-aloud/read-aloud-store";
import { useReadAloudServerId } from "@/read-aloud/use-read-aloud-host";

/**
 * Stop playback when the route leaves the host that started it.
 *
 * The Stop control lives in a turn footer, so navigating to another workspace
 * unmounts it while the module-level playback keeps going — audio with no way
 * to stop it, and every button on the new route showing idle because none of
 * them owns the old turn id.
 *
 * Mounted once at the app root. Per-button cleanup would be wrong: footers
 * unmount during ordinary list virtualization, which must not stop playback.
 */
export function useReadAloudRouteGuard(): void {
  const routeServerId = useReadAloudServerId();
  const { ownerServerId } = useReadAloudSnapshot();

  useEffect(() => {
    if (!ownerServerId) {
      return;
    }
    if (routeServerId === ownerServerId) {
      return;
    }
    // Re-read rather than trusting the closed-over value: the effect can run a
    // tick after a read already finished on its own.
    if (getReadAloudSnapshot().ownerServerId !== ownerServerId) {
      return;
    }
    stopReadAloud();
  }, [ownerServerId, routeServerId]);
}
