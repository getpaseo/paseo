import { defineRpc } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const state = defineRpc({
  name: "state",
  input: z.object({}),
  output: z.object({ workspaces: z.number() }),
});

export default function contribute(server: PluginServerContext) {
  let workspaces = 0;
  server.handle(state, () => ({ workspaces }));
  server.on("workspace.created", () => {
    workspaces += 1;
  });
  return () => {};
}
