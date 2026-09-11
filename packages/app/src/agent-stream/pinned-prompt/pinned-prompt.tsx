import type { ReadingSignalSource } from "../reading-signal";
import type { PinnedPromptResolution } from "./model";

export interface PinnedPromptProps {
  pinnedId: ReadingSignalSource<string | null>;
  promptById: ReadonlyMap<string, PinnedPromptResolution>;
  onJumpToPrompt: (itemId: string) => void;
}

// Pinning needs the reading position, which only the web viewport measures. Native navigates the
// transcript by scrolling, so there is no header to render.
export function PinnedPrompt(_props: PinnedPromptProps): null {
  return null;
}
