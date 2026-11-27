import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import { createPluginClientStateSource } from "./source";
import { workspace } from "./fixtures";

setFlagsFromString("--expose_gc");
const collectGarbage: () => void = runInNewContext("gc");
setFlagsFromString("--no-expose_gc");

function observeHost() {
  const hostId = "removed-plugin-host";
  let hosts = [hostId];
  const store = useSessionStore.getState();
  store.initializeSession(hostId, null);
  store.setWorkspaces(hostId, new Map([[workspace.id, { ...workspace }]]));
  const source = createPluginClientStateSource(undefined, {
    hosts: { getSnapshot: () => hosts, subscribe: () => () => {} },
  });
  const release = source.subscribe(() => source.getSnapshot());
  source.getSnapshot();
  const reference = new WeakRef(useSessionStore.getState().sessions[hostId]!.workspaces);
  const remove = () => {
    hosts = [];
    store.clearSession(hostId);
  };
  return { reference, release, remove };
}

it("releases removed hosts' projected data while other plugin readers remain", async () => {
  const { reference, release, remove } = observeHost();
  remove();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await setImmediate();
      collectGarbage();
    }
    expect(reference.deref()).toBeUndefined();
  } finally {
    release();
  }
});

it("releases previous projections when the last plugin reader leaves", async () => {
  const { reference, release, remove } = observeHost();
  release();
  remove();
  for (let attempt = 0; attempt < 3; attempt++) {
    await setImmediate();
    collectGarbage();
  }
  expect(reference.deref()).toBeUndefined();
});
