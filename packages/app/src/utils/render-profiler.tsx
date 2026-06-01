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

function isRenderProfileEnabled(): boolean {
  return getSearchParam("renderProfile") === "1";
}

const onRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  globalThis.__PASEO_RENDER_PROFILE__ ??= [];
  globalThis.__PASEO_RENDER_PROFILE__.push({
    id,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
  });
};

export function RenderProfile({ id, children }: { id: string; children: ReactNode }) {
  if (!isRenderProfileEnabled()) {
    return children;
  }

  globalThis.__PASEO_RENDER_PROFILE__ ??= [];
  globalThis.__PASEO_RENDER_PROFILE_REASONS__ ??= {};
  globalThis.__PASEO_RESET_RENDER_PROFILE__ = () => {
    globalThis.__PASEO_RENDER_PROFILE__ = [];
    globalThis.__PASEO_RENDER_PROFILE_REASONS__ = {};
  };

  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}

export function recordRenderProfileReasons(id: string, reasons: string[]) {
  if (!isRenderProfileEnabled() || reasons.length === 0) {
    return;
  }
  globalThis.__PASEO_RENDER_PROFILE_REASONS__ ??= {};
  const counts = (globalThis.__PASEO_RENDER_PROFILE_REASONS__[id] ??= {});
  for (const reason of reasons) {
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
}
