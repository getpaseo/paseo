import { useEffect } from "react";
import { bindPlatformBackgroundConnection } from "@/runtime/background-connection";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export function useBackgroundConnection(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    return bindPlatformBackgroundConnection(getHostRuntimeStore());
  }, [enabled]);
}
