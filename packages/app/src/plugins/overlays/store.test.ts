import { describe, expect, it } from "vitest";
import type { PluginOverlayProps } from "@getpaseo/plugin/client";
import { createPluginOverlayStore } from "./store";

function Box(_props: PluginOverlayProps) {
  return null;
}

function Menu(_props: PluginOverlayProps) {
  return null;
}

/** Runs scheduled mounts only when the test says the frame has passed. */
function manualSchedule() {
  const pending = new Set<() => void>();
  return {
    schedule(run: () => void) {
      pending.add(run);
      return () => pending.delete(run);
    },
    flush() {
      const runs = [...pending];
      pending.clear();
      for (const run of runs) run();
    },
  };
}

function setup() {
  const frames = manualSchedule();
  const store = createPluginOverlayStore(frames.schedule);
  const mounted = () =>
    store.getSnapshot().map((entry) => ({
      serverId: entry.serverId,
      pluginId: entry.pluginId,
      Component: entry.Component,
    }));
  return { store, frames, mounted };
}

describe("plugin overlay store", () => {
  it("mounts an overlay on the next frame, newest last", () => {
    const { store, frames, mounted } = setup();
    store.open({ serverId: "host", pluginId: "todo", Component: Box });
    expect(mounted()).toEqual([]);

    frames.flush();
    store.open({ serverId: "host", pluginId: "todo", Component: Menu });
    frames.flush();

    expect(mounted()).toEqual([
      { serverId: "host", pluginId: "todo", Component: Box },
      { serverId: "host", pluginId: "todo", Component: Menu },
    ]);
  });

  it("closes from the handle or the rendered component, once", () => {
    const { store, frames, mounted } = setup();
    const first = store.open({ serverId: "host", pluginId: "todo", Component: Box });
    store.open({ serverId: "host", pluginId: "todo", Component: Menu });
    frames.flush();

    first.close();
    first.close();
    expect(mounted()).toEqual([{ serverId: "host", pluginId: "todo", Component: Menu }]);

    store.getSnapshot()[0]?.close();
    expect(mounted()).toEqual([]);
  });

  it("never mounts an overlay closed before its frame", () => {
    const { store, frames, mounted } = setup();
    store.open({ serverId: "host", pluginId: "todo", Component: Box }).close();
    frames.flush();
    expect(mounted()).toEqual([]);
  });

  it("notifies subscribers with a fresh snapshot", () => {
    const { store, frames } = setup();
    const snapshots: unknown[] = [];
    const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));
    const handle = store.open({ serverId: "host", pluginId: "todo", Component: Box });
    frames.flush();
    handle.close();
    unsubscribe();

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).not.toBe(snapshots[1]);
  });

  it("rejects anything that is not a component", () => {
    const { store } = setup();
    expect(() =>
      store.open({
        serverId: "host",
        pluginId: "todo",
        Component: "Box" as unknown as typeof Box,
      }),
    ).toThrow("Plugin overlay needs a component");
  });
});
