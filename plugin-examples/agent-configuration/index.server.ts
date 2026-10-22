import type { PluginServerContext } from "@getpaseo/plugin/server";

export default function contribute(server: PluginServerContext) {
  server.before("agent.create", ({ request }) => {
    if (request.config.provider !== "codex") {
      return request;
    }

    return {
      ...request,
      config: {
        ...request.config,
        providerOptions: {
          ...request.config.providerOptions,
          sandbox_mode: "workspace-write",
          approval_policy: "on-request",
        },
        mcpServers: {
          ...request.config.mcpServers,
          company: {
            type: "http",
            url: "https://tools.example.com/mcp",
          },
        },
      },
    };
  });

  return () => {};
}
