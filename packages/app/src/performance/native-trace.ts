import type { DaemonClientTrace } from "@getpaseo/client/internal/daemon-client";
import { requireOptionalNativeModule } from "expo-modules-core";
import { isProfileBuild } from "@/constants/build-profile";

interface PaseoNativeTraceModule {
  beginSection(name: string): void;
  endSection(): void;
}

const traceModule = requireOptionalNativeModule<PaseoNativeTraceModule>("PaseoNativeTrace");

export const nativePerformanceTrace: DaemonClientTrace = {
  isEnabled() {
    return isProfileBuild && traceModule !== null;
  },
  beginSection(name, args) {
    traceModule?.beginSection(formatSectionName(name, args));
  },
  endSection() {
    traceModule?.endSection();
  },
};

function formatSectionName(name: string, args?: Record<string, string>): string {
  if (!args) {
    return name;
  }
  const fields = Object.entries(args).map(([key, value]) => `${key}=${value}`);
  return `${name}|${fields.join(";")}`;
}

export function traceInstant(name: string, args?: Record<string, string>): void {
  if (!nativePerformanceTrace.isEnabled()) {
    return;
  }
  nativePerformanceTrace.beginSection(name, args);
  nativePerformanceTrace.endSection();
}
