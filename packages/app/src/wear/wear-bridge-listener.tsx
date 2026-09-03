import { useWearBridge } from "./use-wear-bridge";

/**
 * Mounts the Wear OS bridge for the app's lifetime.
 *
 * Renders nothing. No-ops on every platform without the native module — iOS, web,
 * and F-Droid builds — so it is safe to mount unconditionally.
 */
export function WearBridgeListener(): null {
  useWearBridge();
  return null;
}
