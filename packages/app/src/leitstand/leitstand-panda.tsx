import { PandaOSLogo } from "@/components/icons/pandaos-logo";
import { PandaLoader } from "@/components/panda-loader";
import { PANDA_GRID } from "@/components/panda-sprite";
import type { PandaMood } from "./inbox-model";

/**
 * The Leitstand's status panda. Until the mood sprites land, a working panda stands for "run" and
 * the plain mark for every other mood.
 */
export function LeitstandPanda({ mood, size }: { mood: PandaMood; size: number }) {
  if (mood === "run") {
    return <PandaLoader pixel={size / PANDA_GRID} />;
  }
  return <PandaOSLogo size={size} />;
}
