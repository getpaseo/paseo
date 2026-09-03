import { useMemo } from "react";
import { useSettings } from "@/hooks/use-settings";
import { resolveComposerSigils, type ComposerSigils } from "./sigils";

/**
 * The composer's active trigger characters.
 *
 * Resolution happens here rather than at the storage layer so a stored pair that
 * has gone stale (a choice removed from the allowlist, or two settings written
 * to the same character by different clients) still yields a usable pair.
 */
export function useComposerSigils(): ComposerSigils {
  const command = useSettings((settings) => settings.commandTriggerSigil);
  const skill = useSettings((settings) => settings.skillTriggerSigil);
  return useMemo(() => resolveComposerSigils({ command, skill }), [command, skill]);
}
