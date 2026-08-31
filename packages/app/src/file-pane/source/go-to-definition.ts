import type { CodePosition, CodeRange } from "@getpaseo/protocol/messages";

export interface DefinitionTarget {
  path: string;
  line: number;
}

/** What a position resolved to: the range to underline and where it leads. */
export type ResolvedDefinition = { originRange?: CodeRange; target: DefinitionTarget } | null;

export interface GoToDefinitionCallbacks {
  resolve: (position: CodePosition) => Promise<ResolvedDefinition>;
  navigate: (target: DefinitionTarget) => void;
}
