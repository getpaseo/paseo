import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readChangedFiles, watchDirectory } from "./server/diff";
import { diffWatch } from "./shared/diff";

export default function contribute(server: PluginServerContext) {
  // The handler runs for as long as the panel is subscribed; a git failure closes it with the error.
  server.handle(diffWatch, async (input, { push, signal }) => {
    const directory = watchDirectory(input.cwd, signal);
    let previous = "";
    while (await directory.settled()) {
      const files = await readChangedFiles(input);
      const current = JSON.stringify(files);
      if (current === previous) continue;
      previous = current;
      await push({ type: "changes", files });
    }
  });
  return () => {};
}
