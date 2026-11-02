import type { PluginServerContext } from "@getpaseo/plugin/server";
import { latestOutputText, shellCommand } from "./server/inspect";

export default function contribute(server: PluginServerContext) {
  server.addHook("workspace.create.before", async ({ request }) => {
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

  server.addHook("agent.turn.after", async (event, context) => {
    if (event.outcome.kind === "canceled") {
      return;
    }
    const agent = context.paseo.agents.ref(event.agent.id);
    const page = await agent.timeline.refetch({ direction: "tail", limit: 20 });
    const text = latestOutputText(page.entries.map(({ item }) => item));
    if (/out of credits/i.test(text)) {
      console.log("Sending a follow-up after out of credits", event.agent.id);
      await agent.send("Try again.");
    }
  });

  server.addHook("agent.permission.before", async (event, context) => {
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

  server.addHook("agent.create.before", async ({ request }) => {
    return {
      ...request,
      env: {
        ...request.env,
        PASEO_HOOK_CREATE_EXAMPLE: "created",
      },
    };
  });

  server.addHook("agent.create.before", async ({ request }) => {
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

  server.addHook("agent.open.before", async ({ request }) => {
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
