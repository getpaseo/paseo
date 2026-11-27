import { STRUCTURED_OUTPUT_TOOL } from "./structured-output-plugin.mjs";

// A refused fetch proves the previous bridge stopped listening. Runtimes report
// it differently: Node puts the code on `cause`, Bun puts it on the error.
export function isRefused(error) {
  const code = error?.code ?? error?.cause?.code;
  return code === "ECONNREFUSED" || code === "ConnectionRefused";
}

// OpenCode owns this plugin for the lifetime of a location. Paseo supplies only
// live, per-session bindings over the authenticated OpenCode RPC channel.
export async function registerSharedBridge(context) {
  const state = await import(new URL("./state.mjs", import.meta.url).href);
  const { bindings, definitions } = state.stateFor(context.location);
  const registrations = new Map();
  const adopted = new Set();
  // Same-named tools that OpenCode registered before Paseo's MCP tools, by tool name.
  const natives = new Map();
  // MCP tools run only after OpenCode's own permission check, which older servers lack.
  const runsMcpTools = typeof context.permission?.assert === "function";
  let updating = Promise.resolve();
  async function request(binding, pathname, body, allowMissing = false, signal) {
    const requestSignal = signal ?? (body === undefined ? AbortSignal.timeout(5_000) : undefined);
    const response = await fetch(new URL(`/_internal/opencode${pathname}`, binding.baseUrl), {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${binding.token}`, "Content-Type": "application/json" },
      signal: requestSignal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const detail = formatErrorDetail(payload?.issues ?? payload?.details);
      const message = payload?.error ?? `Paseo tool bridge returned HTTP ${response.status}`;
      const error = new Error(detail ? `${message}: ${detail}` : message);
      error.status = response.status;
      if (detail) error.details = detail;
      throw error;
    }
    return await response.json();
  }
  async function find(sessionID) {
    const seen = new Set();
    while (sessionID && !seen.has(sessionID)) {
      seen.add(sessionID);
      const binding = bindings.get(sessionID);
      if (binding) return { ...binding, sessionID };
      sessionID = (await context.session.get({ sessionID })).parentID;
    }
    return null;
  }
  async function readBoundContext(sessionID, binding, query = "") {
    try {
      return await request(
        binding,
        `/sessions/${encodeURIComponent(sessionID)}/context${query}`,
        undefined,
        true,
      );
    } catch (error) {
      // A refusal or rejected credentials means this bridge no longer serves the binding.
      if (error?.status !== 401 && !isRefused(error)) throw error;
      return null;
    }
  }
  async function install(binding) {
    const manifest = await request(
      binding,
      `/tools?sessionID=${encodeURIComponent(binding.sessionID)}`,
    );
    const conflicts = manifest.tools.filter((tool) => {
      const registered = definitions.get(tool.name);
      return registered && JSON.stringify(registered) !== JSON.stringify(tool);
    });
    if (conflicts.length > 0) await retireUnusedDefinitions(conflicts);
    for (const definition of manifest.tools) await installDefinition(definition);
    if (runsMcpTools)
      for (const definition of manifest.mcpTools ?? []) await installMcpTool(definition.name);
  }
  // One registration serves every session that has an MCP tool of this name. The context hook
  // gives each session its own definition, and execution routes to that session's server.
  async function installMcpTool(name) {
    const key = mcpKey(name);
    if (registrations.has(key)) return;
    const registration = await context.tool.transform((editor) => {
      // The user's own OpenCode configuration can register a tool with the same name. Sessions
      // that do not have a Paseo MCP tool of that name keep that tool. OpenCode validates input
      // against the registered schema, so it stays permissive for both tools.
      const native = editor.get?.(name);
      if (native) natives.set(name, native);
      else natives.delete(name);
      editor.add({
        name,
        description: `MCP tool ${name} provided by Paseo`,
        input: { type: "object", additionalProperties: true },
        options: { codemode: false },
        async execute(input, call) {
          const scope = await find(call.sessionID);
          if (!scope || !(await ownsMcpTool(scope, name))) {
            if (native) return withoutOutput(await native.execute(input, call));
            throw new Error(
              scope
                ? `MCP tool ${name} is not available to this session`
                : "OpenCode session is not bound to a Paseo agent",
            );
          }
          await context.permission.assert({
            sessionID: call.sessionID,
            agent: call.agent,
            action: name,
            resources: ["*"],
            save: ["*"],
            metadata: { input: input ?? {} },
            source: { type: "tool", messageID: call.messageID, id: call.id },
          });
          const result = await request(
            scope,
            `/sessions/${encodeURIComponent(scope.sessionID)}/mcp-tools/${encodeURIComponent(name)}`,
            input ?? {},
            false,
            call.signal,
          );
          if (result.isError)
            throw new Error(
              result.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n")
                .trim() || "MCP tool returned an error",
            );
          return {
            content: result.content.map(toOpenCodeContent),
            metadata: { paseoMcpTool: name },
          };
        },
      });
    });
    registrations.set(key, registration);
    definitions.set(key, { mcpTool: name });
  }
  async function ownsMcpTool(scope, name) {
    const own = await request(
      scope,
      `/sessions/${encodeURIComponent(scope.sessionID)}/context?tools`,
    );
    return (own.mcpTools ?? []).some((tool) => tool.name === name);
  }
  // A child session starts its first request right away, so Paseo prepares it, including its
  // environment, before the request is built.
  async function adopt(scope, sessionID) {
    if (scope.sessionID === sessionID || adopted.has(sessionID)) return;
    await request(
      scope,
      `/sessions/${encodeURIComponent(scope.sessionID)}/descendants/${encodeURIComponent(sessionID)}`,
      {},
      true,
      AbortSignal.timeout(10_000),
    );
    adopted.add(sessionID);
  }
  async function retireUnusedDefinitions(conflicts) {
    // A tool name is registered once per location. Another session can still
    // use that definition, even when the session being rebound no longer does.
    const contexts = await Promise.all(
      [...bindings].map(async ([sessionID, binding]) => [
        sessionID,
        await readBoundContext(sessionID, binding, "?tools"),
      ]),
    );
    const inUse = new Set(contexts.flatMap(([, scope]) => (scope ? scope.tools : [])));
    for (const { name } of conflicts) {
      if (inUse.has(name)) throw new Error(`Conflicting Paseo tool definition: ${name}`);
    }
    for (const [sessionID, scope] of contexts) {
      if (!scope) bindings.delete(sessionID);
    }
    for (const { name } of conflicts) {
      await registrations.get(name)?.dispose();
      registrations.delete(name);
      definitions.delete(name);
    }
  }
  async function installDefinition(definition) {
    if (registrations.has(definition.name)) return;
    const registration = await context.tool.transform((editor) => {
      editor.add({
        name: `paseo_${definition.name}`,
        description: definition.description,
        input: definition.inputSchema,
        options: { codemode: false },
        async execute(input, call) {
          const scope = await find(call.sessionID);
          if (!scope) throw new Error("OpenCode session is not bound to a Paseo agent");
          const result = await request(
            scope,
            `/sessions/${encodeURIComponent(scope.sessionID)}/tools/${encodeURIComponent(definition.name)}`,
            input,
            false,
            call.signal,
          );
          return {
            content: result.content.map(toOpenCodeContent),
            metadata: { paseoTool: definition.name },
          };
        },
      });
    });
    registrations.set(definition.name, registration);
    definitions.set(definition.name, definition);
  }
  async function clearUnusedDefinitions() {
    if (bindings.size) return;
    await Promise.all([...registrations.values()].map((registration) => registration.dispose()));
    registrations.clear();
    definitions.clear();
  }
  // Reinstall live tools before this plugin generation is made visible.
  // Definitions are kept in memory, so unavailable owners cannot delay reload.
  for (const definition of definitions.values())
    if (definition.mcpTool === undefined) await installDefinition(definition);
    else if (runsMcpTools) await installMcpTool(definition.mcpTool);
  const object = { type: "object", additionalProperties: true };
  const rpc = await context.rpc.register(
    {
      id: "paseo.bridge",
      methods: {
        bind: { input: object, output: object },
        unbind: { input: object, output: object },
        refresh: { input: object, output: object },
      },
      events: {},
    },
    {
      bind: async (input) => {
        if (
          typeof input.sessionID !== "string" ||
          typeof input.baseUrl !== "string" ||
          typeof input.token !== "string"
        )
          throw new Error("Invalid Paseo bridge binding");
        const next = updating
          .catch(() => undefined)
          .then(async () => {
            const previous = bindings.get(input.sessionID);
            if (
              previous &&
              (previous.baseUrl !== input.baseUrl || previous.token !== input.token)
            ) {
              const active = await readBoundContext(input.sessionID, previous);
              if (active)
                return { error: "OpenCode session is already bound to another Paseo bridge" };
              bindings.delete(input.sessionID);
              await clearUnusedDefinitions();
            }
            await install(input);
            bindings.set(input.sessionID, { baseUrl: input.baseUrl, token: input.token });
            return { features: { mcpTools: runsMcpTools } };
          });
        updating = next;
        return await next;
      },
      unbind: async (input) => {
        const next = updating
          .catch(() => undefined)
          .then(async () => {
            const binding = bindings.get(input.sessionID);
            if (binding && binding.token === input.token && binding.baseUrl === input.baseUrl)
              bindings.delete(input.sessionID);
            await clearUnusedDefinitions();
            return {};
          });
        updating = next;
        await next;
        return {};
      },
      refresh: async () => {
        await context.provider.reload();
        await context.model.reload();
        await context.agent.reload();
        await context.command.reload();
        await context.skill.reload();
        return {};
      },
    },
  );
  const filter = await context.session.hook("context", async (input) => {
    const binding = await find(input.sessionID);
    if (binding) await adopt(binding, input.sessionID);
    const scope =
      binding &&
      (await request(binding, `/sessions/${encodeURIComponent(binding.sessionID)}/context?tools`));
    const allowed = new Set((scope?.tools ?? []).map((name) => `paseo_${name}`));
    const mcpTools = new Map((scope?.mcpTools ?? []).map((tool) => [tool.name, tool]));
    for (const name of Object.keys(input.tools)) {
      if (definitions.has(mcpKey(name))) {
        const own = mcpTools.get(name);
        const native = natives.get(name);
        if (own) input.tools[name] = { description: own.description, input: own.inputSchema };
        else if (native)
          input.tools[name] = { description: native.description, input: native.input };
        else delete input.tools[name];
        continue;
      }
      if (name.startsWith("paseo_") && name !== STRUCTURED_OUTPUT_TOOL && !allowed.has(name))
        delete input.tools[name];
    }
    // The instructions of Paseo-hosted MCP servers go with every request of the session and its
    // descendants. OpenCode loads instruction entries before this hook runs, so an entry written
    // when a child is adopted would miss the child's first request.
    if (scope?.mcpInstructions) input.system.push({ type: "text", text: scope.mcpInstructions });
  });
  return async () => {
    await filter.dispose();
    await rpc.dispose();
    await Promise.all([...registrations.values()].map((registration) => registration.dispose()));
  };
}

// Paseo's MCP tool declares no output schema, so a same-named tool's output becomes content.
function withoutOutput({ output, ...result }) {
  if (result.content !== undefined || output === undefined) return result;
  return {
    ...result,
    content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }],
  };
}

function mcpKey(name) {
  return `mcp:${name}`;
}

function toOpenCodeContent(part) {
  if (part.type === "image")
    return { type: "file", uri: `data:${part.mimeType};base64,${part.data}`, mime: part.mimeType };
  if (part.type === "text") return part;
  return { type: "text", text: JSON.stringify(part) };
}

function formatErrorDetail(details) {
  if (!Array.isArray(details)) return typeof details === "string" ? details : "";
  return details
    .map((issue) => {
      const path = Array.isArray(issue?.path) && issue.path.length ? issue.path.join(".") : "input";
      return `${path}: ${issue?.message ?? "Invalid value"}`;
    })
    .join("; ");
}
