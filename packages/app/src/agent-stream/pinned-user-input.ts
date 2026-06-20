import type { StreamItem } from "@/types/stream";

export interface PinnedUserInputCandidate {
  item: Extract<StreamItem, { kind: "user_message" }>;
  top: number;
  bottom: number;
}

export interface PinnedUserInputState {
  item: Extract<StreamItem, { kind: "user_message" }>;
}

export interface SelectPinnedUserInputInput {
  enabled: boolean;
  candidates: PinnedUserInputCandidate[];
  viewportTop: number;
  viewportBottom: number;
}

export interface CollectEstimatedPinnedUserInputCandidatesInput {
  items: StreamItem[];
  estimateHeight: (item: StreamItem) => number;
  initialTop?: number;
}

function isCandidateVisible(input: {
  candidate: PinnedUserInputCandidate;
  viewportTop: number;
  viewportBottom: number;
}): boolean {
  return input.candidate.bottom > input.viewportTop && input.candidate.top < input.viewportBottom;
}

export function collectEstimatedPinnedUserInputCandidates(
  input: CollectEstimatedPinnedUserInputCandidatesInput,
): PinnedUserInputCandidate[] {
  const candidates: PinnedUserInputCandidate[] = [];
  let top = input.initialTop ?? 0;
  for (const item of input.items) {
    const height = input.estimateHeight(item);
    if (item.kind === "user_message") {
      candidates.push({
        item,
        top,
        bottom: top + height,
      });
    }
    top += height;
  }
  return candidates;
}

export function findEstimatedStreamItemTop(input: {
  items: StreamItem[];
  itemId: string;
  estimateHeight: (item: StreamItem) => number;
  initialTop?: number;
}): number | null {
  let top = input.initialTop ?? 0;
  for (const item of input.items) {
    if (item.id === input.itemId) {
      return top;
    }
    top += input.estimateHeight(item);
  }
  return null;
}

export function selectPinnedUserInput(
  input: SelectPinnedUserInputInput,
): PinnedUserInputState | null {
  if (!input.enabled) {
    return null;
  }
  if (input.viewportBottom <= input.viewportTop) {
    return null;
  }

  const viewportMidpoint = input.viewportTop + (input.viewportBottom - input.viewportTop) / 2;
  let relevant: PinnedUserInputCandidate | null = null;
  for (const candidate of input.candidates) {
    if (candidate.top <= viewportMidpoint) {
      relevant = candidate;
    } else {
      break;
    }
  }

  if (!relevant) {
    return null;
  }
  if (
    isCandidateVisible({
      candidate: relevant,
      viewportTop: input.viewportTop,
      viewportBottom: input.viewportBottom,
    })
  ) {
    return null;
  }

  return { item: relevant.item };
}
