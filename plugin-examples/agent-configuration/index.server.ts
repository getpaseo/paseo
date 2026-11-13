import type { PluginServerContext } from "@getpaseo/plugin/server";

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.create.before", async ({ request }) => {
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
      },
    };
  });

  server.addHook("agent.open.before", async ({ request }) => {
    // Background agents are short-lived helpers; keep the company tools for the agents users open.
    if (request.provider !== "codex" || request.background) {
      return;
    }

    return {
      ...request,
      mcpServers: {
        ...request.mcpServers,
        company: {
          type: "http",
          url: "https://tools.example.com/mcp",
        },
      },
    };
  });

  return () => {};
}
