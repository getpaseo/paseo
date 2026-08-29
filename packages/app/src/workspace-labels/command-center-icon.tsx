import type { WorkspaceLabelColor } from "@getpaseo/protocol/workspace-labels";
import type { CommandCenterIcon } from "@/command-center/contributions";
import { WorkspaceLabelDot } from "./swatch";

// One stable component per color for the life of the module — `getCommandCenterIcon` in
// `@/command-center/icon` does the same thing keyed by lucide component identity. A label's dot
// has no lucide component to key off, so the cache is keyed by color name instead.
const cache = new Map<WorkspaceLabelColor, CommandCenterIcon>();

/** The color dot a label's row draws everywhere else, adapted to the command center's icon shape. */
export function getLabelCommandCenterIcon(color: WorkspaceLabelColor): CommandCenterIcon {
  const cached = cache.get(color);
  if (cached) return cached;
  function LabelCommandCenterIcon() {
    return <WorkspaceLabelDot color={color} />;
  }
  cache.set(color, LabelCommandCenterIcon);
  return LabelCommandCenterIcon;
}
