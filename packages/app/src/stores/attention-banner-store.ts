import { create } from "zustand";

export interface AttentionBannerPayload {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

export interface AttentionBannerState {
  banner: (AttentionBannerPayload & { id: number; extraCount: number }) | null;
  show: (payload: AttentionBannerPayload) => void;
  dismiss: () => void;
}

let nextId = 1;

export const useAttentionBannerStore = create<AttentionBannerState>((set, get) => ({
  banner: null,
  show: (payload) => {
    const current = get().banner;
    set({
      banner: {
        id: nextId++,
        title: payload.title,
        body: payload.body,
        data: payload.data,
        // If a banner was already showing, count how many earlier ones were replaced.
        extraCount: current ? current.extraCount + 1 : 0,
      },
    });
  },
  dismiss: () => set({ banner: null }),
}));
