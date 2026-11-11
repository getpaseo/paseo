import { STRUCTURED_OUTPUT_TOOL } from "./structured-output-plugin.mjs";

// OpenCode owns this plugin for the lifetime of a location. Paseo supplies only
// live, per-session bindings over the authenticated OpenCode RPC channel.
export async function registerSharedBridge(context) {
  const state = await import(new URL("./state.mjs", import.meta.url).href);
  const { bindings, definitions } = state.stateFor(context.location);
  const registrations = new Map();
  let updating = Promise.resolve();
  async function request(binding, pathname, body, allowMissing = false, signal) {
    const requestSignal = body === undefined ? AbortSignal.timeout(5_000) : signal;
    const response = await fetch(new URL(`/_internal/opencode${pathname}`, binding.baseUrl), {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${binding.token}`, "Content-Type": "application/json" },
      signal: requestSignal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allowMissing && response.status === 404) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = formatErrorDetail(payload?.issues ?? payload?.details);
      const message = payload?.error ?? `Paseo tool bridge returned HTTP ${response.status}`;
      const error = new Error(detail ? `${message}: ${detail}` : message);
      error.status = response.status;
      if (detail) error.details = detail;
      throw error;
    }
    return payload;
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
  async function install(binding) {
    const manifest = await request(binding, "/tools");
    for (const definition of manifest.tools) await installDefinition(definition);
  }
  async function installDefinition(definition) {
    const signature = JSON.stringify(definition);
    const known = definitions.get(definition.name);
    if (known && JSON.stringify(known) !== signature)
      throw new Error(`Conflicting Paseo tool definition: ${definition.name}`);
    const old = registrations.get(definition.name);
    if (old) {
      if (old.signature !== signature)
        throw new Error(`Conflicting Paseo tool definition: ${definition.name}`);
      return;
    }
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
    registrations.set(definition.name, { signature, registration });
    definitions.set(definition.name, definition);
  }
  async function clearUnusedDefinitions() {
    if (bindings.size) return;
    await Promise.all(
      [...registrations.values()].map(({ registration }) => registration.dispose()),
    );
    registrations.clear();
    definitions.clear();
  }
  // Reinstall live tools before this plugin generation is made visible.
  // Definitions are kept in memory, so unavailable owners cannot delay reload.
  for (const definition of definitions.values()) await installDefinition(definition);
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
              let active;
              try {
                active = await request(
                  previous,
                  `/sessions/${encodeURIComponent(input.sessionID)}/context`,
                  undefined,
                  true,
                );
              } catch (error) {
                // Refusal or rejected credentials mean this endpoint no longer
                // serves the previous binding. Other failures are inconclusive.
                if (
                  error?.status !== 401 &&
                  error?.cause?.code !== "ECONNREFUSED" &&
                  error?.code !== "ConnectionRefused"
                )
                  throw error;
              }
              if (active)
                return { error: "OpenCode session is already bound to another Paseo bridge" };
              bindings.delete(input.sessionID);
              await clearUnusedDefinitions();
            }
            await install(input);
            bindings.set(input.sessionID, { baseUrl: input.baseUrl, token: input.token });
            return {};
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
    const scope =
      binding &&
      (await request(binding, `/sessions/${encodeURIComponent(binding.sessionID)}/context?tools`));
    const allowed = new Set((scope?.tools ?? []).map((name) => `paseo_${name}`));
    for (const name of Object.keys(input.tools)) {
      if (name.startsWith("paseo_") && name !== STRUCTURED_OUTPUT_TOOL && !allowed.has(name))
        delete input.tools[name];
    }
  });
  return async () => {
    await filter.dispose();
    await rpc.dispose();
    await Promise.all(
      [...registrations.values()].map(({ registration }) => registration.dispose()),
    );
  };
}

function toOpenCodeContent(part) {
  if (part.type === "image")
    return { type: "file", uri: `data:${part.mimeType};base64,${part.data}`, mime: part.mimeType };
  return part;
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
