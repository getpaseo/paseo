import { watchdog } from "@/watchdog";
import type { DaemonClientTrace } from "@getpaseo/client/internal/daemon-client";
import { requireOptionalNativeModule } from "expo-modules-core";
import { isProfileBuild } from "@/constants/build-profile";

interface PaseoNativeTraceModule {
  beginSection(name: string): void;
  endSection(): void;
}

const traceModule = requireOptionalNativeModule<PaseoNativeTraceModule>("PaseoNativeTrace");

const nativeSink: DaemonClientTrace | null =
  isProfileBuild && traceModule
    ? {
        isEnabled: () => true,
        beginSection: (name, args) => traceModule.beginSection(formatSectionName(name, args)),
        endSection: () => traceModule.endSection(),
      }
    : null;

function formatSectionName(name: string, args?: Record<string, string>): string {
  if (!args) {
    return name;
  }
  const fields = Object.entries(args).map(([key, value]) => `${key}=${value}`);
  return `${name}|${fields.join(";")}`;
}

const instantSinks: ((name: string, args?: Record<string, string>) => void)[] = [];
if (watchdog) instantSinks.push(watchdog.record);
if (nativeSink)
  instantSinks.push((name, args) => {
    nativeSink.beginSection(name, args);
    nativeSink.endSection();
  });
export function traceInstant(name: string, args?: Record<string, string>): void {
  for (const write of instantSinks) write(name, args);
}

/** Each client owns its section stack; overlapping hosts never share span identity. */
export function createPerformanceTrace(context: Record<string, string>): DaemonClientTrace {
  const sinks = [watchdog?.trace(context), nativeSink].filter(
    (sink): sink is DaemonClientTrace => sink != null,
  );
  return {
    isEnabled: () => sinks.length > 0,
    beginSection(name, args) {
      for (const sink of sinks) sink.beginSection(name, args);
    },
    endSection() {
      for (const sink of sinks) sink.endSection();
    },
  };
}
