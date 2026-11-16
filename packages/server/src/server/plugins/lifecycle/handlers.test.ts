import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { validateBeforeResult, PluginHookHandlers } from "./index.js";

const paseo = createPaseoApi(
  new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "lifecycle-unit" }),
);

test("removing an old registration twice preserves a newer registration for the same hook", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const remove = hooks.addHook("workspace.create.before", async ({ request }) => {
    return { ...request, title: "old" };
  });
  remove();
  hooks.addHook("workspace.create.before", async ({ request }) => {
    return { ...request, title: "new" };
  });
  remove();
  const output = await hooks.invoke(
    "operation",
    "workspace.create.before",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  expect(output).toEqual({ source: { kind: "directory", path: "/project" }, title: "new" });
});

test("before hooks compose returned requests and preserve the original input", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("workspace.create.before", async ({ request }) => {
    return { ...request, title: "first" };
  });
  hooks.addHook("workspace.create.before", async () => {
    return;
  });
  hooks.addHook("workspace.create.before", async ({ request }) => {
    return { ...request, title: request.title + ":second" };
  });
  const input = { source: { kind: "directory", path: "/project" } };
  expect(await hooks.invoke("operation", "workspace.create.before", input, paseo)).toEqual({
    source: { kind: "directory", path: "/project" },
    title: "first:second",
  });
  expect(input).toEqual({ source: { kind: "directory", path: "/project" } });
});

test("teardown aborts an active callback and removes its registrations", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("workspace.create.before", async (_input, context) => {
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
    "workspace.create.before",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  hooks.close();
  await expect(invocation).rejects.toThrow("Hook aborted");
  expect(hooks.catalog()).toEqual([]);
});

test("session-open hooks reject changes to session identity instead of silently ignoring them", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("agent.open.before", async ({ request }) => {
    return { ...request, provider: "another-provider" };
  });
  await expect(
    hooks.invoke(
      "operation",
      "agent.open.before",
      {
        agentId: "agent",
        workspaceId: "workspace",
        provider: "claude",
        cwd: "/project",
        reason: "resume",
        purpose: "interactive",
        env: {},
        title: null,
        labels: {},
        metadata: {},
        tools: [],
        mcpServers: {},
      },
      paseo,
    ),
  ).rejects.toThrow("agent.open.before hooks can only change env");
});

test("a create hook that omits metadata passes on what an earlier hook added", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("agent.create.before", async ({ request }) => ({
    ...request,
    metadata: { ...request.metadata, "new.plugin": { ticket: 42 } },
  }));
  hooks.addHook("agent.create.before", async ({ request }) => ({
    config: request.config,
    env: request.env,
  }));
  const seen: unknown[] = [];
  hooks.addHook("agent.create.before", async ({ request }) => {
    seen.push(request.metadata);
  });
  const result = await hooks.invoke(
    "operation",
    "agent.create.before",
    { config: { provider: "codex", cwd: "/project" }, env: {}, metadata: { original: true } },
    paseo,
  );
  expect(result).toMatchObject({ metadata: { original: true, "new.plugin": { ticket: 42 } } });
  expect(seen).toEqual([{ original: true, "new.plugin": { ticket: 42 } }]);
});

test("a workspace create hook that omits metadata passes on what an earlier hook added", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("workspace.create.before", async ({ request }) => ({
    ...request,
    metadata: { ...request.metadata, "new.plugin": { ticket: 42 } },
  }));
  hooks.addHook("workspace.create.before", async ({ request }) => ({ source: request.source }));
  const seen: unknown[] = [];
  hooks.addHook("workspace.create.before", async ({ request }) => {
    seen.push(request.metadata);
  });
  const result = await hooks.invoke(
    "operation",
    "workspace.create.before",
    { source: { kind: "directory", path: "/project" }, metadata: { original: true } },
    paseo,
  );
  expect(result).toMatchObject({ metadata: { original: true, "new.plugin": { ticket: 42 } } });
  expect(seen).toEqual([{ original: true, "new.plugin": { ticket: 42 } }]);

  const replacing = new PluginHookHandlers(() => {});
  replacing.addHook("workspace.create.before", async ({ request }) => ({
    ...request,
    metadata: {},
  }));
  await expect(
    replacing.invoke(
      "operation",
      "workspace.create.before",
      { source: { kind: "directory", path: "/project" }, metadata: { original: true } },
      paseo,
    ),
  ).resolves.toMatchObject({ metadata: {} });
});

test("a session-open hook that returns its own object without metadata or background leaves them unchanged", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("agent.open.before", async ({ request }) => ({
    agentId: request.agentId,
    workspaceId: request.workspaceId,
    provider: request.provider,
    cwd: request.cwd,
    reason: request.reason,
    purpose: request.purpose,
    title: request.title,
    labels: request.labels,
    tools: request.tools,
    env: { HOOK: "1" },
    mcpServers: request.mcpServers,
  }));
  const result = await hooks.invoke(
    "operation",
    "agent.open.before",
    {
      agentId: "agent",
      workspaceId: null,
      provider: "codex",
      cwd: "/project",
      title: null,
      background: true,
      labels: {},
      metadata: { "linear.issue": { id: "ENG-1" } },
      tools: [],
      mcpServers: {},
      env: {},
      reason: "resume",
      purpose: "interactive",
    },
    paseo,
  );
  expect(result).toMatchObject({
    env: { HOOK: "1" },
    background: true,
    metadata: { "linear.issue": { id: "ENG-1" } },
  });
});

test.each([{ title: "Changed" }, { labels: { changed: "true" } }, { background: true }])(
  "session-open targeting metadata is read-only: %j",
  async (patch) => {
    const hooks = new PluginHookHandlers(() => {});
    hooks.addHook("agent.open.before", async ({ request }) => ({ ...request, ...patch }));
    await expect(
      hooks.invoke(
        "operation",
        "agent.open.before",
        {
          agentId: "agent",
          workspaceId: null,
          provider: "codex",
          cwd: "/project",
          title: "Original",
          background: false,
          labels: {},
          metadata: {},
          tools: [],
          mcpServers: {},
          env: {},
          reason: "create",
          purpose: "interactive",
        },
        paseo,
      ),
    ).rejects.toThrow("agent.open.before hooks can only change env, tools, and mcpServers");
  },
);

test("new request-changing registrations compose with legacy registrations in registration order", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", ({ request }) => ({ ...request, title: "legacy" }));
  hooks.addHook("workspace.create.before", async ({ request }) => ({
    ...request,
    title: request.title + ":new",
  }));
  hooks.before("workspace.create", ({ request }) => ({
    ...request,
    title: request.title + ":last",
  }));
  expect(
    await hooks.invoke(
      "operation",
      "workspace.create.before",
      {
        source: { kind: "directory", path: "/project" },
      },
      paseo,
    ),
  ).toEqual({ source: { kind: "directory", path: "/project" }, title: "legacy:new:last" });
});

test.each(["agent.session_open", "agent.create.prepare", "nonsense"])(
  "addHook rejects unsupported name %s at registration",
  (name) => {
    const hooks = new PluginHookHandlers(() => {});
    // @ts-expect-error Runtime validation also protects untyped plugins.
    expect(() => hooks.addHook(name, async () => {})).toThrow(name);
  },
);

test.each([
  ["workspace.create", "workspace.create.before"],
  ["workspace.created", "workspace.create.after"],
  ["workspace.archived", "workspace.archive.after"],
  ["agent.create", "agent.create.before"],
  ["agent.created", "agent.create.after"],
  ["agent.session_open", "agent.open.before"],
  ["agent.closed", "agent.close.after"],
  ["agent.archived", "agent.archive.after"],
  ["agent.turn_started", "agent.turn.before"],
  ["agent.turn_ended", "agent.turn.after"],
  ["agent.permission_requested", "agent.permission.before"],
  ["agent.permission_resolved", "agent.permission.after"],
] as const)("legacy %s registers only %s across the process boundary", (oldName, newName) => {
  const hooks = new PluginHookHandlers(() => {});
  const handler = async () => {};
  const remove =
    oldName === "workspace.create" || oldName === "agent.create" || oldName === "agent.session_open"
      ? hooks.before(oldName, handler)
      : hooks.on(oldName, handler);
  hooks.addHook(newName, async () => {});
  expect(hooks.catalog()).toEqual([newName]);
  remove();
  expect(hooks.catalog()).toEqual([newName]);
  hooks.close();
  expect(hooks.catalog()).toEqual([]);
});

test("legacy notifications and addHook share payloads, registration order, and cleanup", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const received: unknown[] = [];
  const remove = hooks.on("workspace.created", (event) => {
    received.push(["old", event]);
  });
  hooks.addHook("workspace.create.after", async (event) => {
    received.push(["new", event]);
  });
  const payload = {
    workspace: {
      id: "workspace",
      projectId: "project",
      cwd: "/project",
      name: null,
      archivedAt: null,
    },
  };
  await hooks.invoke("first", "workspace.create.after", payload, paseo);
  remove();
  remove();
  await hooks.invoke("second", "workspace.create.after", payload, paseo);
  expect(received).toEqual([
    ["old", payload],
    ["new", payload],
    ["new", payload],
  ]);
});

test("a waiting after hook propagates failures and stops later handlers", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const received: string[] = [];
  hooks.addHook("worktree.create.after", async ({ worktree }) => {
    received.push(worktree.path);
    throw new Error("cannot initialize worktree");
  });
  hooks.addHook("worktree.create.after", async () => {
    received.push("unexpected later handler");
  });
  await expect(
    hooks.invoke(
      "worktree",
      "worktree.create.after",
      {
        worktree: { path: "/worktree", branch: "feature", sourceCheckout: "/source" },
      },
      paseo,
    ),
  ).rejects.toThrow("cannot initialize worktree");
  expect(received).toEqual(["/worktree"]);
});

test("checkout-branch hooks reject a branch-off baseRef", async () => {
  const request = {
    kind: "checkout-branch" as const,
    repoRoot: "/repo",
    sourceCheckout: "/repo",
    branch: "feature",
    slug: "feature",
    path: "/work/feature",
  };
  await expect(
    validateBeforeResult("worktree.create.before", request, { ...request, baseRef: "main" }),
  ).rejects.toThrow(/baseRef/);
});
