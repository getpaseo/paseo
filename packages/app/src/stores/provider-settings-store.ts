import { create } from "zustand";

interface ProviderSettingsTarget {
  serverId: string;
  provider: string;
}

interface ProviderSettingsStoreState {
  serverId: string | null;
  provider: string | null;
  visible: boolean;
  open: (target: ProviderSettingsTarget) => void;
  close: () => void;
}

export const useProviderSettingsStore = create<ProviderSettingsStoreState>()((set) => ({
  serverId: null,
  provider: null,
  visible: false,
  open: ({ serverId, provider }) => {
    set({ serverId, provider, visible: true });
  },
  close: () => {
    set({ visible: false });
  },
}));
