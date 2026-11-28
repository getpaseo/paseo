import type { PluginServerContext } from "@getpaseo/plugin/server";
import { sendBuildAlert } from "./shared/alerts";

export default function contribute(server: PluginServerContext) {
  const unhook = server.addHook("agent.turn.after", async ({ agent, outcome }) => {
    if (outcome.kind !== "failed" || agent.background) {
      return;
    }
    await server.notifications.send({
      title: agent.title ?? "Agent turn failed",
      body: outcome.error.message,
      key: `agent-failed:${agent.id}`,
      open: { type: "agent", agentId: agent.id },
      data: { kind: "agent", agentId: agent.id },
    });
  });

  server.handle(sendBuildAlert, async ({ buildId, title, body, key }) => {
    return await server.notifications.send({
      title,
      body,
      key,
      open: {
        type: "screen",
        screenId: "alert",
        params: { buildId, summary: body },
      },
      data: {
        kind: "build",
        buildId,
        summary: body,
      },
    });
  });

  return () => {
    unhook();
  };
}
