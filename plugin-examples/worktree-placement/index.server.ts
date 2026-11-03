import { basename, dirname, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";

export default function contribute(server: PluginServerContext) {
  return server.addHook("worktree.create.before", async ({ request }) => ({
    ...request,
    path: join(
      dirname(request.sourceCheckout),
      `${basename(request.sourceCheckout)}.${request.branch.replaceAll("/", "-")}`,
    ),
  }));
}
