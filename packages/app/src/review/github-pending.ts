import { create } from "zustand";

export interface GithubPendingReview {
  reviewId: string;
  count: number;
}

interface GithubPendingReviewStore {
  pending: Record<string, GithubPendingReview>;
  setPending: (key: string, next: GithubPendingReview | null) => void;
}

export function githubPendingReviewKey(input: {
  serverId: string;
  cwd: string;
  prNumber: number;
}): string {
  return `${input.serverId}:${input.cwd}:${input.prNumber}`;
}

export const useGithubPendingReviewStore = create<GithubPendingReviewStore>((set) => ({
  pending: {},
  setPending: (key, next) => {
    set((state) => {
      const pending = { ...state.pending };
      if (next) pending[key] = next;
      else delete pending[key];
      return { pending };
    });
  },
}));
