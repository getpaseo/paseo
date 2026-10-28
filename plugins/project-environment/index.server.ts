import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import path from "node:path";
import { listVariables, saveVariable, removeVariable } from "./shared/environment";
import { EnvironmentBroker, toolInstructions } from "./server/broker";
import { projectScope } from "./server/store";

export default function contribute(server: PluginServerContext) {
  const home = process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
  const broker = new EnvironmentBroker(path.join(home, "plugin-data", "project-environment"));
  const ready = broker.start();
  void ready.catch(() =>
    console.error(
      "Project environment broker failed to start; open its panel to inspect availability.",
    ),
  );
  function start() {
    return ready;
  }
  server.before("agent.create", async ({ request }) => {
    await start();
    const scope = await projectScope(request.config.cwd);
    const url = await broker.endpoint(scope);
    const systemPrompt = [request.config.systemPrompt, toolInstructions]
      .filter(Boolean)
      .join("\n\n");
    return {
      ...request,
      config: {
        ...request.config,
        systemPrompt,
        mcpServers: { ...request.config.mcpServers, project_environment: { type: "http", url } },
      },
    };
  });
  // Resume existing MCP connections at the same port after plugin/daemon reload.
  server.before("agent.session_open", async () => {
    await start();
  });
  server.handle(listVariables, async ({ workspaceId }, { paseo }) => {
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    if (!workspace) throw new Error("Workspace is unavailable");
    await start();
    const variables = await broker.store.read(await projectScope(workspace.workspaceDirectory));
    return { variables: variables.map(({ name, description }) => ({ name, description })) };
  });
  server.handle(saveVariable, async ({ workspaceId, variable }, { paseo }) => {
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    if (!workspace) throw new Error("Workspace is unavailable");
    await start();
    await broker.store.save(await projectScope(workspace.workspaceDirectory), variable);
    return {};
  });
  server.handle(removeVariable, async ({ workspaceId, name }, { paseo }) => {
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    if (!workspace) throw new Error("Workspace is unavailable");
    await start();
    await broker.store.remove(await projectScope(workspace.workspaceDirectory), name);
    return {};
  });
  return async () => {
    await ready.catch(() => {});
    await broker.close();
  };
}
