import type { HostRuntimeStore } from "@/runtime/host-runtime";

export function bindPlatformBackgroundConnection(_store: HostRuntimeStore): () => void {
  return () => {};
}
