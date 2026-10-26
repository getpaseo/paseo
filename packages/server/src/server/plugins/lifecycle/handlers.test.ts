import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginHookHandlers } from "./index.js";

const paseo = createPaseoApi(
  new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "lifecycle-unit" }),
);

test("removing an old registration twice preserves a newer registration for the same hook", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const remove = hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "old" };
  });
  remove();
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "new" };
  });
  remove();
  const output = await hooks.invoke(
    "operation",
    "before",
    "workspace.create",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  expect(output).toEqual({ source: { kind: "directory", path: "/project" }, title: "new" });
});

test("before hooks compose returned requests and preserve the original input", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "first" };
  });
  hooks.before("workspace.create", () => {
    return;
  });
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: request.title + ":second" };
  });
  const input = { source: { kind: "directory", path: "/project" } };
  expect(await hooks.invoke("operation", "before", "workspace.create", input, paseo)).toEqual({
    source: { kind: "directory", path: "/project" },
    title: "first:second",
  });
  expect(input).toEqual({ source: { kind: "directory", path: "/project" } });
});

test("teardown aborts an active callback and removes its registrations", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", async (_input, context) => {
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => {
          reject(new Error("Hook aborted"));
        },
        { once: true },
      );
    });
  });
  const invocation = hooks.invoke(
    "operation",
    "before",
    "workspace.create",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  hooks.close();
  await expect(invocation).rejects.toThrow("Hook aborted");
  expect(hooks.catalog()).toEqual({ events: [], before: [] });
});

test("session-open hooks reject changes to session identity instead of silently ignoring them", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.session_open", ({ request }) => {
    return { ...request, provider: "another-provider" };
  });
  await expect(
    hooks.invoke(
      "operation",
      "before",
      "agent.session_open",
      {
        agentId: "agent",
        workspaceId: "workspace",
        provider: "claude",
        cwd: "/project",
        reason: "resume",
        purpose: "interactive",
        env: {},
      },
      paseo,
    ),
  ).rejects.toThrow("agent.session_open hooks can only change env");
});

test("agent.create hooks read the initial prompt but cannot change it", async () => {
  const input = {
    config: { provider: "claude", cwd: "/project" },
    initialPrompt: "Review PR 42",
  };
  const reader = new PluginHookHandlers(() => {});
  reader.before("agent.create", ({ request }) => {
    return {
      ...request,
      config: { ...request.config, title: `Routed: ${request.initialPrompt}` },
    };
  });
  expect(await reader.invoke("operation", "before", "agent.create", input, paseo)).toEqual({
    config: { provider: "claude", cwd: "/project", title: "Routed: Review PR 42" },
    initialPrompt: "Review PR 42",
  });

  const writer = new PluginHookHandlers(() => {});
  writer.before("agent.create", ({ request }) => {
    return { ...request, initialPrompt: "Something else" };
  });
  await expect(writer.invoke("operation", "before", "agent.create", input, paseo)).rejects.toThrow(
    "agent.create hooks cannot change the initial prompt",
  );
});

test("agent.create hooks that return a request without the initial prompt keep it", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.create", ({ request }) => {
    return { config: { ...request.config, title: "Fresh request" } };
  });
  expect(
    await hooks.invoke(
      "operation",
      "before",
      "agent.create",
      { config: { provider: "claude", cwd: "/project" }, initialPrompt: "Review PR 42" },
      paseo,
    ),
  ).toEqual({
    config: { provider: "claude", cwd: "/project", title: "Fresh request" },
    initialPrompt: "Review PR 42",
  });
});
