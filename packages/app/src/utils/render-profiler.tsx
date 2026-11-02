import { watchdog } from "@/watchdog";
import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

export interface RenderProfileSample {
  id: string;
  phase: "mount" | "update" | "nested-update";
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
}

declare global {
  var __PASEO_RENDER_PROFILE__: RenderProfileSample[] | undefined;
  var __PASEO_RENDER_PROFILE_REASONS__: Record<string, Record<string, number>> | undefined;
  var __PASEO_RESET_RENDER_PROFILE__: (() => void) | undefined;
  var __PASEO_RENDER_PROFILE_ENABLED__: boolean | undefined;
}

function getSearchParam(name: string): string | null {
  const location = Reflect.get(globalThis, "location");
  if (!location || typeof location !== "object") {
    return null;
  }
  const search = Reflect.get(location, "search");
  if (typeof search !== "string") {
    return null;
  }
  return new URLSearchParams(search).get(name);
}

interface RenderSink {
  isEnabled(): boolean;
  render(sample: RenderProfileSample): void;
  reasons(id: string, reasons: string[]): void;
}

function createBrowserSink(): RenderSink {
  return {
    isEnabled: () =>
      globalThis.__PASEO_RENDER_PROFILE_ENABLED__ === true ||
      getSearchParam("renderProfile") === "1",
    render(sample) {
      globalThis.__PASEO_RENDER_PROFILE__ ??= [];
      globalThis.__PASEO_RESET_RENDER_PROFILE__ ??= () => {
        globalThis.__PASEO_RENDER_PROFILE__ = [];
        globalThis.__PASEO_RENDER_PROFILE_REASONS__ = {};
      };
      // Browser QA compares cumulative commit counts until an explicit reset.
      globalThis.__PASEO_RENDER_PROFILE__.push(sample);
    },
    reasons(id, reasons) {
      globalThis.__PASEO_RENDER_PROFILE_REASONS__ ??= {};
      const counts = (globalThis.__PASEO_RENDER_PROFILE_REASONS__[id] ??= {});
      for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
    },
  };
}

// Choose the destination once. Browser QA can still enable capture at runtime.
const sink: RenderSink = watchdog
  ? { isEnabled: () => true, render: watchdog.render, reasons: () => {} }
  : createBrowserSink();

export const isRenderProfileEnabled = sink.isEnabled;
const onRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => sink.render({ id, phase, actualDuration, baseDuration, startTime, commitTime });

export function RenderProfile({ id, children }: { id: string; children: ReactNode }) {
  if (!sink.isEnabled()) return children;
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}

export function recordRenderProfileReasons(id: string, reasons: string[]) {
  if (sink.isEnabled()) sink.reasons(id, reasons);
}
