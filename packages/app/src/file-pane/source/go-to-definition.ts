import type { CodePosition, CodeRange } from "@getpaseo/protocol/messages";

export interface DefinitionTarget {
  path: string;
  line: number;
}

export interface GoToDefinitionCallbacks {
  /**
   * Resolve the symbol at a position. Returns the range to underline and where it leads,
   * or null when nothing resolves there.
   */
  resolve: (
    position: CodePosition,
  ) => Promise<{ originRange?: CodeRange; target: DefinitionTarget } | null>;
  navigate: (target: DefinitionTarget) => void;
}
