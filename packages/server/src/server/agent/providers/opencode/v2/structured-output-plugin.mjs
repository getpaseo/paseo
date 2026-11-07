import Ajv from "ajv";

export const STRUCTURED_OUTPUT_TOOL = "paseo_structured_output";

export async function registerStructuredOutput(context) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  async function schemaFor(sessionID) {
    const history = await context.session.context({ sessionID });
    const prompt = history.findLast((message) => message.type === "user");
    return prompt?.metadata?.paseoOutputSchema;
  }
  const tools = await context.tool.transform((editor) => {
    editor.add({
      name: STRUCTURED_OUTPUT_TOOL,
      description: "Submit the final answer in the required structured format.",
      input: {
        type: "object",
        properties: { value: {} },
        required: ["value"],
        additionalProperties: false,
      },
      options: { codemode: false },
      async execute(input, call) {
        const schema = await schemaFor(call.sessionID);
        if (schema === undefined) throw new Error("This turn has no structured-output request");
        const validate = ajv.compile(schema);
        if (!validate(input.value))
          throw new Error(`Invalid structured output: ${ajv.errorsText(validate.errors)}`);
        return {
          content:
            "Final structured answer accepted. End this turn without additional text or tool calls.",
          metadata: { paseoStructuredOutput: input.value },
        };
      },
    });
  });
  const hook = await context.session.hook("context", async (input) => {
    const schema = await schemaFor(input.sessionID);
    if (schema === undefined) {
      delete input.tools[STRUCTURED_OUTPUT_TOOL];
      return;
    }
    const tool = input.tools[STRUCTURED_OUTPUT_TOOL];
    if (!tool) throw new Error("Structured-output tool is unavailable");
    tool.input = {
      type: "object",
      properties: { value: schema },
      required: ["value"],
      additionalProperties: false,
    };
    input.system.push({
      type: "text",
      text: `Complete the user's task, then submit the final answer using ${STRUCTURED_OUTPUT_TOOL}. Its value must satisfy the tool schema. Do not finish with an ordinary text answer. After the tool accepts the value, end the turn without additional text or tool calls.`,
    });
  });
  return async () => {
    await hook.dispose();
    await tools.dispose();
  };
}
