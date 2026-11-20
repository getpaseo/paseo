import { requireOptionalNativeModule } from "expo-modules-core";
import Constants from "expo-constants";
import { resolveAppVersion } from "@/utils/app-version";
import { createRecorder } from "./internal/recorder";

interface NativeRecorder {
  startRecorder(metadata: Record<string, string>): number;
  record(name: string, fields: Record<string, string>): void;
  heartbeat(): void;
}

const native =
  Constants.expoConfig?.extra?.watchdogBuild === true
    ? requireOptionalNativeModule<NativeRecorder>("PaseoNativeTrace")
    : null;
export const watchdog = native
  ? createRecorder(
      (name, fields) => native.record(name, fields),
      () => performance.now(),
    )
  : null;
let started = false;

export function startWatchdog(): void {
  if (!native || !watchdog || started) return;
  started = true;
  const heartbeatMs = native.startRecorder({
    version: resolveAppVersion() ?? "unknown",
    build: String(Constants.expoConfig?.extra?.diagnosticRevision ?? "unknown"),
    builtAt: String(Constants.expoConfig?.extra?.diagnosticBuildTime ?? "unknown"),
    reactProfiling: "true",
  });
  setInterval(() => native.heartbeat(), heartbeatMs);
  setInterval(() => watchdog.flushRenders(), 1000);
}
