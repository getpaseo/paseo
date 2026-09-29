import { registerStructuredOutput, STRUCTURED_OUTPUT_TOOL } from "./structured-output-plugin.mjs";

export default {
  id: "paseo",
  async setup(context) {
    const disposeStructuredOutput = await registerStructuredOutput(context);
    const { baseUrl, token } = context.options;
    if (!baseUrl || !token) return disposeStructuredOutput;
    async function request(pathname, body, allowMissing = false) {
      const response = await fetch(new URL(`/_internal/opencode${pathname}`, baseUrl), {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (allowMissing && response.status === 404) return null;
      if (!response.ok) throw new Error(`Paseo tool bridge returned HTTP ${response.status}`);
      return response.json();
    }
    async function scope(sessionID) {
      const visited = new Set();
      while (sessionID && !visited.has(sessionID)) {
        visited.add(sessionID);
        const binding = await request(
          `/sessions/${encodeURIComponent(sessionID)}/context?tools`,
          undefined,
          true,
        );
        if (binding) return { ...binding, sessionID };
        const session = await context.session.get({ sessionID });
        sessionID = session.parentID;
      }
      throw new Error("OpenCode session is not bound to a Paseo agent");
    }
    const manifest = await request("/tools");
    const registration = await context.tool.transform((editor) => {
      for (const definition of manifest.tools) {
        editor.add({
          name: `paseo_${definition.name}`,
          description: definition.description,
          input: definition.inputSchema,
          options: { codemode: false },
          async execute(input, call) {
            const binding = await scope(call.sessionID);
            const result = await request(
              `/sessions/${encodeURIComponent(binding.sessionID)}/tools/${encodeURIComponent(definition.name)}`,
              input,
            );
            return { content: result.content, metadata: { paseoTool: definition.name } };
          },
        });
      }
    });
    const filtering = await context.session.hook("context", async (input) => {
      const binding = await scope(input.sessionID);
      const allowed = new Set(binding.tools.map((name) => `paseo_${name}`));
      for (const name of Object.keys(input.tools)) {
        if (name !== STRUCTURED_OUTPUT_TOOL && name.startsWith("paseo_") && !allowed.has(name))
          delete input.tools[name];
      }
    });
    return async () => {
      await disposeStructuredOutput();
      await filtering.dispose();
      await registration.dispose();
    };
  },
};
