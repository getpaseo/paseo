import { requireOptionalNativeModule } from "expo-modules-core";
import { AppState } from "react-native";
import { bindBackgroundConnectionKeeper } from "@/navigation/host-runtime-bootstrap";
import type { HostRuntimeStore } from "@/runtime/host-runtime";

interface ConnectionKeeperModule {
  setEnabled(enabled: boolean): boolean;
  addListener(event: "onBackgroundHeartbeat", listener: () => void): { remove(): void };
}

export function bindPlatformBackgroundConnection(store: HostRuntimeStore): () => void {
  const module = requireOptionalNativeModule<ConnectionKeeperModule>("PaseoConnectionKeeper");
  if (!module) return () => {};
  return bindBackgroundConnectionKeeper(store, AppState, {
    setEnabled: (enabled) => module.setEnabled(enabled),
    subscribeHeartbeat: (listener) => {
      const subscription = module.addListener("onBackgroundHeartbeat", listener);
      return () => subscription.remove();
    },
  });
}
