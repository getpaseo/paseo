/**
 * Per-daemon-connection Live Activity mount point. Non-iOS builds resolve to this no-op stub so
 * `SessionProvider` can call `useLiveActivity` without subscribing to session store state.
 * iOS resolves `use-live-activity.ios.ts`, which delegates to the controller implementation.
 */

import type { UseLiveActivityOptions } from "./use-live-activity-controller";

export type { UseLiveActivityOptions };

export function useLiveActivity(_options: UseLiveActivityOptions): void {}
