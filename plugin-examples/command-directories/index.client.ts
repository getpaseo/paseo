import type { PluginClientContext } from "@getpaseo/plugin/client";
import { listCommandsRpc, resolveCommandRpc } from "./shared/commands";
import { configuredCommandDirectories } from "./shared/config";

export default function contribute(client: PluginClientContext) {
  client.addSlashCommandProvider({
    id: "configured-directories",
    context: "agent",
    async list({ workspace, rpc }) {
      const result = await rpc(listCommandsRpc, {
        workspaceDirectory: workspace.directory,
        projectRootPath: workspace.projectRootPath,
        directories: configuredCommandDirectories,
      });
      return result.commands;
    },
    async onSubmit({ command, args, workspace, agent, paseo, rpc }) {
      const result = await rpc(resolveCommandRpc, {
        workspaceDirectory: workspace.directory,
        projectRootPath: workspace.projectRootPath,
        directories: configuredCommandDirectories,
        name: command.name,
        args,
      });
      await paseo.agents.ref(agent.id).send(result.prompt);
    },
  });
  return () => {};
}
