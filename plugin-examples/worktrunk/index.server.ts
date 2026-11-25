import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  WAITING_MARKER,
  WORKING_MARKER,
  createWithWorktrunk,
  removeWithWorktrunk,
  restoreWithWorktrunk,
  setActivityMarker,
} from "./server/wt.js";

export default function contribute(server: PluginServerContext) {
  const cleanups = [
    server.registerWorktreeManager({
      create: (request, { signal }) => createWithWorktrunk(request, signal),
      remove: (request, { signal }) => removeWithWorktrunk(request, signal),
      restore: (request, { signal }) => restoreWithWorktrunk(request, signal),
    }),

    server.addHook("agent.turn.before", async ({ agent }, { signal }) => {
      if (agent.background) return;
      await setActivityMarker(agent.cwd, WORKING_MARKER, signal);
    }),
    server.addHook("agent.turn.after", async ({ agent }, { signal }) => {
      if (agent.background) return;
      await setActivityMarker(agent.cwd, WAITING_MARKER, signal);
    }),
    server.addHook("agent.permission.before", async ({ agent }, { signal }) => {
      if (agent.background) return;
      await setActivityMarker(agent.cwd, WAITING_MARKER, signal);
    }),
    server.addHook("agent.close.after", async ({ agent }, { signal }) => {
      if (agent.background) return;
      await setActivityMarker(agent.cwd, null, signal);
    }),
    server.addHook("agent.archive.after", async ({ agent }, { signal }) => {
      if (agent.background) return;
      await setActivityMarker(agent.cwd, null, signal);
    }),
  ];

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
