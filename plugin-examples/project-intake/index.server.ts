import type { PluginServerContext } from "@getpaseo/plugin/server";
import { join } from "node:path";
import { preferences } from "./shared/preferences";
import { assessProject, resolveProject } from "./shared/contracts";
import { ProjectIntakeService } from "./server/service";
import { decideProjectFit } from "./server/decision";

export default function contribute(server: PluginServerContext) {
  if (!server.dataDirectory)
    throw new Error("Update this host to support isolated plugin data storage.");
  const settings = server.registerSettings(preferences);
  const service = new ProjectIntakeService({
    directory: join(server.dataDirectory, "checks"),
    settings: async () => {
      const state = await settings.read();
      if (state.status !== "ready") throw new Error(state.error);
      return state.values;
    },
    decide: decideProjectFit,
  });
  server.handle(assessProject, (input) => service.assess(input));
  server.handle(resolveProject, (input, { paseo }) => service.resolve(input, paseo));
  return () => {};
}
