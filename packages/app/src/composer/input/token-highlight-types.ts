import type { RefObject } from "react";
import type { ComposerSigils } from "@/composer/tokens/sigils";
import type { ComposerTokenCatalog } from "@/composer/tokens/tokens";

export interface ComposerTokenHighlightProps {
  /**
   * False when the draft has no token, or on native. The component renders nothing
   * and installs no observers, so the untokenised path costs nothing — the gate
   * lives here rather than at the call site to keep the composer's render simple.
   */
  enabled: boolean;
  value: string;
  sigils: ComposerSigils;
  tokenCatalog: ComposerTokenCatalog;
  /** The underlying `<textarea>` on web; unused on native. */
  textareaRef: RefObject<unknown>;
}
