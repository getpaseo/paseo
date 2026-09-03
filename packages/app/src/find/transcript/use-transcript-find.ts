import { useRef, type RefObject } from "react";
import type { StreamLayoutItem } from "@/agent-stream/layout";
import type { StreamViewportHandle } from "@/agent-stream/strategy";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import type { FindResult } from "@/find/engine";
import { EMPTY_FIND_RESULT } from "@/find/model";

export interface UseTranscriptFindInput {
  /** Loaded rows in render order, which is DOM order on web. */
  history: readonly StreamLayoutItem[];
  liveHead: readonly StreamLayoutItem[];
  viewportRef: RefObject<StreamViewportHandle | null>;
  /** The container that holds both the stream and the find bar. */
  getRoot: () => HTMLElement | null;
}

export interface UseTranscriptFindResult {
  isOpen: boolean;
  query: string;
  result: FindResult;
  setQuery: (query: string) => void;
  next: () => void;
  previous: () => void;
  close: () => void;
  inputRef: RefObject<EditingTextInputHandle | null>;
  onViewportReady: (ready: boolean) => void;
}

function noop(): void {}

/**
 * Find is web-only (keyboard/availability.ts), so the base module is inert and the
 * transcript view renders no bar on native. See use-transcript-find.web.ts.
 */
export function useTranscriptFind(_input: UseTranscriptFindInput): UseTranscriptFindResult {
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  return {
    isOpen: false,
    query: "",
    result: EMPTY_FIND_RESULT,
    setQuery: noop,
    next: noop,
    previous: noop,
    close: noop,
    inputRef,
    onViewportReady: noop,
  };
}
