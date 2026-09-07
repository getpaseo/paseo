import type { PluginServerContext } from "@getpaseo/plugin/server";
import { latestOutputText, shellCommand } from "./server/inspect";

export default function contribute(server: PluginServerContext) {
  server.before("workspace.create", ({ request }) => {
    if (request.title === "Isolated lifecycle example" && request.source.kind === "directory") {
      return {
        ...request,
        source: {
          kind: "worktree",
          cwd: request.source.path,
          action: "branch-off",
          branchName: "lifecycle-example",
        },
      };
    }
    return request;
  });

  server.on("agent.turn_ended", async (event, context) => {
    if (event.outcome.kind === "canceled") {
      return;
    }
    const text = latestOutputText(event.timeline);
    if (/out of credits/i.test(text)) {
      const agent = context.paseo.agents.ref(event.agent.id);
      console.log("Sending a follow-up after out of credits", event.agent.id);
      await agent.send("Try again.");
    }
  });

  server.on("agent.permission_requested", async (event, context) => {
    const command = shellCommand(event.request);
    if (command === null) {
      return;
    }

    const agent = context.paseo.agents.ref(event.agent.id);
    if (/\brm\s+-rf\b/.test(command)) {
      await agent.respondToPermission({
        requestId: event.request.id,
        response: {
          behavior: "deny",
          message: "Recursive deletion is blocked by the example plugin.",
        },
      });
      return;
    }

    if (command.trim() === "git status") {
      await agent.respondToPermission({
        requestId: event.request.id,
        response: { behavior: "allow" },
      });
    }
  });

  server.before("agent.create", ({ request }) => {
    return {
      ...request,
      env: {
        ...request.env,
        PASEO_HOOK_CREATE_EXAMPLE: "created",
      },
    };
  });

  server.before("agent.create", ({ request }) => {
    if (request.config.provider === "codex") {
      return {
        ...request,
        config: {
          ...request.config,
          provider: "claude",
          model: "haiku",
          modeId: "default",
          providerOptions: undefined,
        },
      };
    }
    return request;
  });

  server.before("agent.session_open", ({ request }) => {
    return {
      ...request,
      env: {
        ...request.env,
        PASEO_HOOK_OPEN_EXAMPLE: "opened",
      },
    };
  });

  return () => {};
}
