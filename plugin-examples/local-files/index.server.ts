import type { PluginServerContext } from "@getpaseo/plugin/server";
import { importFile, inspectDestination, reviewedTarget } from "./shared/contracts";
import { inspect, install } from "./server/destination";

export default function contribute(server: PluginServerContext) {
  server.handle(inspectDestination, async (input, { paseo }) => {
    const { projects } = await paseo.projects.list();
    return inspect(projects, input);
  });

  server.handle(importFile, async (frame, { paseo }) => {
    const separator = frame.subarray(0, 4096).indexOf(10);
    if (separator < 0 || frame.byteLength - separator - 1 > 1024 * 1024) {
      throw new Error("Invalid local file transfer size.");
    }
    const input = reviewedTarget.parse(
      JSON.parse(Buffer.from(frame.subarray(0, separator)).toString("utf8")),
    );
    const { projects } = await paseo.projects.list();
    return install(projects, input, frame.subarray(separator + 1));
  });

  return () => {};
}
