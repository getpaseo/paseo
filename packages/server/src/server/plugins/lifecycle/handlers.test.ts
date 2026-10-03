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

test("advertises actual lifecycle events without guessing unsupported names", () => {
  const hooks = new PluginHookHandlers(() => {});
  expect(hooks.supportsLifecycleEvent("agent.user_message_accepted")).toBe(true);
  expect(hooks.supportsLifecycleEvent("agent.human_approved")).toBe(false);
  expect(hooks.catalog().events).toEqual([]);
  hooks.on("agent.user_message_accepted", () => {});
  expect(hooks.catalog().events).toEqual(["agent.user_message_accepted"]);
});

test("creation origin is immutable and separate from the editable request", async () => {
  const hooks = new PluginHookHandlers(() => {});
  expect(hooks.supportsBeforeHookOrigin("agent.create")).toBe(true);
  expect(hooks.supportsBeforeHookOrigin("agent.session_open")).toBe(false);
  hooks.before("agent.create", ({ request }, context) => {
    expect(context.origin).toEqual({ kind: "agent", agentId: "actual-caller" });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.origin)).toBe(true);
    expect(() => Reflect.set(context.origin!, "kind", "plugin")).not.toThrow();
    expect(context.origin?.kind).toBe("agent");
    return { ...request, env: { origin: "plugin" } };
  });
  const output = await hooks.invoke(
    "origin",
    "before",
    "agent.create",
    {
      config: { provider: "codex", cwd: "/project" },
    },
    paseo,
    { kind: "agent", agentId: "actual-caller" },
  );
  expect(output).toMatchObject({ env: { origin: "plugin" } });
});
