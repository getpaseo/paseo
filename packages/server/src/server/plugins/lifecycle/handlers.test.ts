import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginHookHandlers } from "./index.js";
import { randomUUID } from "node:crypto";
import type { PluginBeforeRequests, PluginMcpBindRequest } from "@getpaseo/plugin/server";
import { validateBeforeResult } from "./index.js";
import {
  attestManagedMcpContribution,
  captureManagedMcpServers,
  createMcpOpening,
  MANAGED_MCP_INERT_AUTHORIZATION,
  validateManagedMcpConfig,
} from "./managed-mcp.js";

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

function contributedMcp(): PluginBeforeRequests["agent.create"] {
  return {
    config: {
      provider: "omp",
      cwd: "/project",
      mcpServers: {
        memory: {
          type: "http",
          url: "https://memory.test/mcp",
          headers: { Authorization: MANAGED_MCP_INERT_AUTHORIZATION },
        },
      },
    },
    managedMcpServers: { memory: { bindPluginId: "bots" } },
  };
}

test("managed MCP provenance comes from the contributing frame, not a matching caller server", () => {
  const previous = { config: { provider: "omp", cwd: "/project" } };
  const contributed = contributedMcp();
  attestManagedMcpContribution(previous, contributed, "memory-owner");
  const owned = captureManagedMcpServers(contributed)!;
  expect(owned.memory?.ownerPluginId).toBe("memory-owner");
  validateManagedMcpConfig({ ...contributed.config, managedMcpServers: owned });
  expect(() =>
    attestManagedMcpContribution({ config: contributed.config }, contributedMcp(), "impostor"),
  ).toThrow("newly contributed server");
  const conflict = structuredClone(contributed);
  conflict.config.mcpServers!.memory = { type: "http", url: "https://other.test/mcp" };
  expect(() => attestManagedMcpContribution(contributed, conflict, "other")).toThrow("Conflicting");
});

test.each([
  { type: "sse", url: "https://memory.test/mcp" },
  { type: "stdio", command: "mcp" },
  {
    type: "http",
    url: "https://memory.test/mcp",
    headers: { authorization: MANAGED_MCP_INERT_AUTHORIZATION },
  },
  {
    type: "http",
    url: "https://memory.test/mcp",
    headers: { Authorization: MANAGED_MCP_INERT_AUTHORIZATION, authorization: "competing" },
  },
  {
    type: "http",
    url: "https://memory.test/mcp",
    headers: { Authorization: MANAGED_MCP_INERT_AUTHORIZATION, Cookie: "cookie" },
  },
  {
    type: "http",
    url: "https://memory.test/mcp",
    headers: { Authorization: MANAGED_MCP_INERT_AUTHORIZATION, "Proxy-Authorization": "proxy" },
  },
  {
    type: "http",
    url: "https://memory.test/mcp/agents",
    headers: { Authorization: MANAGED_MCP_INERT_AUTHORIZATION },
  },
  {
    type: "http",
    url: "https://memory.test/mcp/%61gents",
    headers: { Authorization: MANAGED_MCP_INERT_AUTHORIZATION },
  },
  {
    type: "http",
    url: "https://user:password@memory.test/mcp",
    headers: { Authorization: MANAGED_MCP_INERT_AUTHORIZATION },
  },
] as const)("managed MCP rejects invalid transport, URL or header authority: %j", (server) => {
  const next = contributedMcp();
  next.config.mcpServers!.memory = server;
  expect(() =>
    attestManagedMcpContribution(
      { config: { provider: "omp", cwd: "/project" } },
      next,
      "memory-owner",
    ),
  ).toThrow();
});

test("managed MCP cannot change URL, transport or exact tool policy when reopening", () => {
  const request = contributedMcp();
  attestManagedMcpContribution({ config: { provider: "omp", cwd: "/project" } }, request, "owner");
  const config = { ...request.config, managedMcpServers: captureManagedMcpServers(request) };
  for (const server of [
    {
      type: "http" as const,
      url: "https://new.test/mcp",
      headers: { Authorization: MANAGED_MCP_INERT_AUTHORIZATION },
    },
    { type: "sse" as const, url: "https://memory.test/mcp" },
  ]) {
    expect(() => validateManagedMcpConfig({ ...config, mcpServers: { memory: server } })).toThrow();
  }
  expect(() =>
    validateManagedMcpConfig({
      ...config,
      toolPolicy: {
        preapproved: [{ kind: "mcp", server: "memory", tool: "write" }],
      },
    }),
  ).toThrow("configuration changed");
  expect(() => validateManagedMcpConfig(request.config)).toThrow("no host-attested owner");
});

function bindRequest(): PluginMcpBindRequest {
  return {
    agentId: randomUUID(),
    provider: "omp",
    workspaceId: "workspace",
    cwd: "/project",
    reason: "refresh",
    purpose: "interactive",
    env: { PASEO_MEMORY_BOOTSTRAP_REF: "opaque-reference", REGION: "eu" },
    opening: { id: randomUUID(), digest: "a".repeat(64) },
    bootstrapEnvKeys: ["PASEO_MEMORY_BOOTSTRAP_REF"],
  };
}

test("bind admits only its opening and remove-only declared bootstrap overrides", () => {
  const request = bindRequest();
  const binding = {
    openingId: request.opening.id,
    sessionEpoch: 1,
    bindRequestId: "committed-bind",
  };
  expect(
    validateBeforeResult("agent.mcp_bind", request, {
      ...request,
      binding,
      env: { REGION: "eu" },
    }),
  ).toMatchObject({ binding, env: { REGION: "eu" } });
  for (const patch of [
    { provider: "other" },
    { opening: { ...request.opening, id: randomUUID() } },
    { env: {} },
    { env: { REGION: "us" } },
    { env: { ...request.env, TOKEN: "credential" } },
    { binding: { ...binding, sessionEpoch: 0 } },
    { binding: { ...binding, sessionEpoch: Number.MAX_SAFE_INTEGER + 1 } },
  ]) {
    expect(() =>
      validateBeforeResult("agent.mcp_bind", request, { ...request, ...patch }),
    ).toThrow();
  }
});

test("authorization cannot alter bound identity, epoch, URL or add headers", () => {
  const session = bindRequest();
  const binding = {
    openingId: session.opening.id,
    sessionEpoch: 1,
    bindRequestId: "committed-bind",
  };
  const { env: _env, bootstrapEnvKeys: _keys, binding: _binding, ...identity } = session;
  const request = {
    session: identity,
    binding,
    server: { name: "memory", url: "https://memory.test/mcp" },
  };
  expect(
    validateBeforeResult("agent.mcp_authorization", request, {
      ...request,
      authorization: "Bearer valid-generation",
    }).authorization,
  ).toBe("Bearer valid-generation");
  for (const patch of [
    { server: { name: "memory", url: "https://other.test/mcp" } },
    { binding: { ...binding, sessionEpoch: 2 } },
    { headers: { Cookie: "cookie" } },
    { authorization: "Bearer secret\r\nCookie: injection" },
  ]) {
    expect(() =>
      validateBeforeResult("agent.mcp_authorization", request, { ...request, ...patch }),
    ).toThrow();
  }
});

test("opening digest is canonical for the same intent, but physical openings never reuse identity", () => {
  const request = bindRequest();
  const config = contributedMcp().config;
  const first = createMcpOpening(config, request);
  const retryBody = createMcpOpening(
    { cwd: config.cwd, mcpServers: config.mcpServers, provider: config.provider },
    request,
  );
  expect(retryBody.digest).toBe(first.digest);
  expect(retryBody.id).not.toBe(first.id);
  expect(createMcpOpening(config, { ...request, agentId: randomUUID() }).digest).not.toBe(
    first.digest,
  );
});
