/**
 * How long a pane holds off rendering while it waits for the plugin list.
 *
 * `usePlugins` reports loading until `server_info` lands, which for a host that
 * never answers is forever, so every wait on it is bounded. Both waiters —
 * the explorer sidebar's remembered plugin tab and the file pane's preview
 * renderer — share this one, because two copies of the same deadline drift.
 */
import { useEffect, useState } from "react";

/**
 * Long enough for a healthy local daemon's `server_info` plus one RPC, short
 * enough that a dead host does not leave a blank pane. Pinned by a test: a
 * larger value is the unbounded hold again, wearing a number.
 */
export const PLUGIN_LIST_WAIT_MS = 2_000;

/**
 * `waiting`, until the deadline expires.
 *
 * `key` restarts the deadline: `waiting` does not flip false between two hosts
 * that are both still connecting, or between two files opened while the list is
 * in flight, so without it the first one spends the budget and everything after
 * it skips the wait entirely.
 */
export function useBoundedPluginListWait(input: { waiting: boolean; key: string }): boolean {
  const { waiting, key } = input;
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  // Reset during render rather than in the effect below. The effect runs after
  // the render that first saw the new key has already committed, and one commit
  // is all it takes to mount the fallback pane and fire its RPCs — the exact
  // flicker these waits exist to prevent. React documents this shape for
  // resetting state when a prop changes; the extra render pass is discarded.
  const [waitedForKey, setWaitedForKey] = useState(key);
  if (waitedForKey !== key) {
    setWaitedForKey(key);
    setWaitedTooLong(false);
  }
  // The `waiting` false -> true case is safe to reset here: nothing renders the
  // stale deadline in the meantime, because `waiting` is false throughout.
  useEffect(() => {
    setWaitedTooLong(false);
    if (!waiting) {
      return;
    }
    const timer = setTimeout(() => setWaitedTooLong(true), PLUGIN_LIST_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting, key]);
  return waiting && !waitedTooLong;
}
