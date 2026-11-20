import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { validateBeforeResult, PluginHookHandlers } from "./index.js";

const paseo = createPaseoApi(
  new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "lifecycle-unit" }),
);

test("older hook results preserve the host's session support facts", async () => {
  const input = {
    agentId: "agent",
    workspaceId: null,
    provider: "work-claude",
    cwd: "/project",
    title: null,
    labels: {},
    tools: [],
    mcpServers: {},
    env: {},
    reason: "resume" as const,
    purpose: "interactive" as const,
    openSupport: {
      adapter: { kind: "builtin" as const, id: "claude" },
      instructions: "supported" as const,
      mcpHttp: "supported" as const,
      exactMcpPreapproval: "supported" as const,
      attachedTools: { delivery: "mcp" as const, enabled: true, disabledTools: [] },
      restrictions: {
        mcpConfiguration: "mutable" as const,
        processEnvironment: "mutable" as const,
      },
      providerOptions: ["additionalDirectories"],
    },
  };
  const { openSupport, ...olderResult } = input;
  const result = await validateBeforeResult("agent.open.before", input, olderResult);
  expect(result).toMatchObject({ provider: "work-claude", openSupport });
});

test("session support facts stay immutable inside the hook callback", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("agent.open.before", ({ request }) => {
    expect(Object.isFrozen(request.openSupport)).toBe(true);
    expect(Object.isFrozen(request.openSupport?.adapter)).toBe(true);
    expect(Object.isFrozen(request.openSupport?.attachedTools.disabledTools)).toBe(true);
    expect(Object.isFrozen(request.openSupport?.restrictions)).toBe(true);
    expect(Object.isFrozen(request.openSupport?.providerOptions)).toBe(true);
    return request;
  });
  await hooks.invoke(
    "operation",
    "agent.open.before",
    {
      agentId: "agent",
      workspaceId: null,
      provider: "work-claude",
      cwd: "/project",
      reason: "resume",
      purpose: "interactive",
      title: null,
      labels: {},
      tools: [],
      mcpServers: {},
      env: {},
      openSupport: {
        adapter: { kind: "builtin", id: "claude" },
        instructions: "supported",
        mcpHttp: "supported",
        exactMcpPreapproval: "supported",
        attachedTools: { delivery: "mcp", enabled: true, disabledTools: [] },
        restrictions: { mcpConfiguration: "mutable", processEnvironment: "mutable" },
        providerOptions: ["additionalDirectories"],
      },
    },
    paseo,
  );
});

test("hooks cannot replace host-owned support with a more permissive descriptor", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("agent.open.before", async ({ request }) => ({
    ...request,
    openSupport: { ...request.openSupport!, mcpHttp: "supported" },
  }));
  await expect(
    hooks.invoke(
      "operation",
      "agent.open.before",
      {
        agentId: "agent",
        workspaceId: null,
        provider: "plugin-provider",
        cwd: "/project",
        reason: "resume",
        purpose: "interactive",
        title: null,
        labels: {},
        tools: [],
        mcpServers: {},
        env: {},
        openSupport: {
          adapter: { kind: "plugin", id: "plugin-provider" },
          instructions: "unknown",
          mcpHttp: "unknown",
          exactMcpPreapproval: "unknown",
          attachedTools: { delivery: "unknown", enabled: true, disabledTools: [] },
          restrictions: { mcpConfiguration: "unknown", processEnvironment: "unknown" },
          providerOptions: [],
        },
      },
      paseo,
    ),
  ).rejects.toThrow("agent.open.before hooks cannot change host-owned openSupport");
});

test("launch lifetime survives hook completion and disposal aborts before awaiting cleanup", async () => {
  const hooks = new PluginHookHandlers(() => {});
  let launchSignal: AbortSignal | undefined;
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  const events: string[] = [];
  hooks.addHook("agent.open.before", async ({ request }, { launch }) => {
    launchSignal = launch.signal;
    launch.onDispose(async () => {
      events.push(launch.signal.aborted ? "aborted-before-cleanup" : "not-aborted");
      await cleanup;
      events.push("cleanup-finished");
    });
    return request;
  });
  await hooks.invoke(
    "hook",
    "agent.open.before",
    {
      agentId: "agent",
      launchId: "launch-one",
      workspaceId: null,
      provider: "claude",
      cwd: "/project",
      reason: "resume",
      purpose: "interactive",
      title: null,
      labels: {},
      tools: [],
      mcpServers: {},
      env: {},
    },
    paseo,
  );
  expect(launchSignal?.aborted).toBe(false);
  const disposal = hooks.disposeLaunch("launch-one");
  expect(events).toEqual(["aborted-before-cleanup"]);
  finishCleanup();
  await disposal;
  await hooks.disposeLaunch("launch-one");
  expect(events).toEqual(["aborted-before-cleanup", "cleanup-finished"]);
});

test("failed launch cleanup stays rejected without rerunning callbacks and bulk disposal reports it", async () => {
  const hooks = new PluginHookHandlers(() => {});
  let cleanups = 0;
  let launchSignal: AbortSignal | undefined;
  hooks.addHook("agent.open.before", async ({ request }, { launch }) => {
    launchSignal = launch.signal;
    launch.onDispose(() => {
      cleanups++;
      throw new Error("Allocated resource cleanup failed");
    });
    return request;
  });
  await hooks.invoke(
    "hook",
    "agent.open.before",
    {
      agentId: "agent",
      launchId: "failed-launch",
      workspaceId: null,
      provider: "claude",
      cwd: "/project",
      reason: "create",
      purpose: "interactive",
      title: null,
      labels: {},
      tools: [],
      mcpServers: {},
      env: {},
    },
    paseo,
  );

  const disposal = hooks.disposeLaunch("failed-launch");
  const failure: unknown = await disposal.catch((error: unknown) => error);
  expect(failure).toMatchObject({
    message: "Plugin launch cleanup failed",
    errors: [{ message: "Allocated resource cleanup failed" }],
  });
  expect(hooks.disposeLaunch("failed-launch")).toBe(disposal);
  await expect(hooks.disposeLaunch("failed-launch")).rejects.toBe(failure);
  expect(launchSignal?.aborted).toBe(true);
  expect(cleanups).toBe(1);
  await expect(hooks.installLaunch("failed-launch")).rejects.toThrow("disposed");
  await expect(hooks.disposeLaunches()).rejects.toMatchObject({
    message: "Plugin launch cleanup failed",
    errors: [failure],
  });
  expect(cleanups).toBe(1);
});

test("open hooks contribute launch-only grants and options beside immutable caller configuration", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("agent.open.before", async ({ request }) => ({
    ...request,
    providerOptions: { additionalDirectories: ["/linked"] },
    mcpServers: { notes: { type: "http", url: "http://127.0.0.1:1/notes" } },
    toolPolicy: { preapproved: [{ kind: "mcp", server: "notes", tool: "read" }] },
  }));
  expect(
    await hooks.invoke(
      "hook",
      "agent.open.before",
      {
        agentId: "agent",
        launchId: "launch",
        workspaceId: null,
        provider: "claude",
        cwd: "/project",
        reason: "resume",
        purpose: "interactive",
        title: null,
        labels: {},
        tools: [],
        mcpServers: {},
        env: {},
        baseConfig: {
          provider: "claude",
          cwd: "/project",
          systemPrompt: "Caller instructions",
          providerOptions: { additionalDirectories: ["/caller"] },
        },
      },
      paseo,
    ),
  ).toMatchObject({
    baseConfig: {
      systemPrompt: "Caller instructions",
      providerOptions: { additionalDirectories: ["/caller"] },
    },
    providerOptions: { additionalDirectories: ["/linked"] },
    toolPolicy: { preapproved: [{ kind: "mcp", server: "notes", tool: "read" }] },
  });
});

test("installed notification and retained references keep the original launch alive until its last user releases", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const events: string[] = [];
  let originalSignal: AbortSignal | undefined;
  hooks.addHook("agent.open.before", async ({ request }, { launch }) => {
    if (launch.id === "original") originalSignal = launch.signal;
    else launch.retainPrevious();
    launch.onInstalled(() => {
      events.push(`installed:${launch.id}`);
    });
    launch.onDispose(({ installed }) => {
      events.push(`disposed:${launch.id}:${installed}`);
    });
    return request;
  });
  const request = {
    agentId: "agent",
    workspaceId: null,
    provider: "claude",
    cwd: "/project",
    reason: "resume",
    purpose: "interactive",
    title: null,
    labels: {},
    tools: [],
    mcpServers: {},
    env: {},
  };
  await hooks.invoke("first", "agent.open.before", { ...request, launchId: "original" }, paseo);
  await hooks.installLaunch("original");
  await hooks.installLaunch("original");
  await hooks.invoke(
    "second",
    "agent.open.before",
    {
      ...request,
      launchId: "replacement",
      previousContribution: { launchId: "original", mcpServers: {}, env: {} },
    },
    paseo,
  );
  await hooks.disposeLaunch("original");
  expect(originalSignal?.aborted).toBe(false);
  await hooks.disposeLaunch("replacement");
  expect(originalSignal?.aborted).toBe(true);
  expect(events).toEqual([
    "installed:original",
    "disposed:replacement:false",
    "disposed:original:true",
  ]);
});

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
    ).rejects.toThrow(
      "agent.open.before hooks can only change env, tools, mcpServers, and appendSystemPrompt",
    );
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

test("session-open instructions compose, survive old hooks, and are ignored for history", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("agent.open.before", async ({ request }) => ({
    ...request,
    appendSystemPrompt: [...(request.appendSystemPrompt ?? []), "first"],
  }));
  hooks.addHook("agent.open.before", async ({ request }) => {
    const { appendSystemPrompt: _ignored, ...oldRequest } = request;
    return oldRequest;
  });
  hooks.addHook("agent.open.before", async ({ request }) => ({
    ...request,
    appendSystemPrompt: [...(request.appendSystemPrompt ?? []), "second"],
  }));
  const input = {
    agentId: "agent",
    workspaceId: null,
    provider: "codex",
    cwd: "/project",
    reason: "resume",
    purpose: "interactive",
    env: {},
    title: null,
    labels: {},
    metadata: {},
    tools: [],
    mcpServers: {},
  };
  const interactive = await hooks.invoke("interactive", "agent.open.before", input, paseo);
  expect(interactive).toMatchObject({ appendSystemPrompt: ["first", "second"] });
  const history = await hooks.invoke(
    "history",
    "agent.open.before",
    { ...input, purpose: "history" },
    paseo,
  );
  expect(history).not.toHaveProperty("appendSystemPrompt");
});
