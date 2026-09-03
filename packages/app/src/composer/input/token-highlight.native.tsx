import type { ComposerTokenHighlightProps } from "./token-highlight-types";

export type { ComposerTokenHighlightProps };

/**
 * Native TextInput cannot safely render styled spans: Android rejects `value`
 * together with children, while iOS ignores the children. Keep the controlled
 * plain-text path until native has a real attributed-input implementation.
 */
export function ComposerTokenHighlightLayer(_props: ComposerTokenHighlightProps): null {
  return null;
}
