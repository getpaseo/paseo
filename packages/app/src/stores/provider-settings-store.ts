import { create } from "zustand";

interface ProviderSettingsTarget {
  serverId: string;
  provider: string;
}

interface ProviderSettingsStoreState {
  serverId: string | null;
  provider: string | null;
  open: (target: ProviderSettingsTarget) => void;
  close: () => void;
}

export const useProviderSettingsStore = create<ProviderSettingsStoreState>()((set) => ({
  serverId: null,
  provider: null,
  open: ({ serverId, provider }) => {
    set({ serverId, provider });
  },
  close: () => {
    set({ serverId: null, provider: null });
  },
}));
