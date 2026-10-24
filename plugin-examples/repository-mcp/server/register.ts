import type { PluginServerContext } from "@getpaseo/plugin/server";
import { repositories } from "../shared/repositories";
import { listRepositories } from "./repositories";
import { connection } from "../shared/connection";

export function registerRepositories(server: PluginServerContext) {
  server.handle(repositories, listRepositories);
  const settings = server.registerSettings(connection);
  const service = server.registerMcpServer({
    id: "repositories",
    label: "Fictional repositories",
    settingsScreenId: "repositories",
    config: null,
  });
  let disposed = false;
  const update: Parameters<typeof settings.subscribe>[0] = (state) => {
    if (disposed) return;
    service.update(
      state.status === "ready" && state.values.url ? { type: "http", url: state.values.url } : null,
    );
  };
  let receivedChange = false;
  const unsubscribe = settings.subscribe((state) => {
    receivedChange = true;
    update(state);
  });
  void settings
    .read()
    .then((state) => {
      if (!receivedChange) update(state);
      return null;
    })
    .catch(() => {
      if (!disposed) service.update(null);
      return null;
    });
  return () => {
    disposed = true;
    unsubscribe();
    service.remove();
  };
}
