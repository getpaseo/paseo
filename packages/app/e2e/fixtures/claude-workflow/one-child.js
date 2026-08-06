export const meta = {
  name: "paseo-workflow-row-qa",
  description: "Verify the workflow row lifecycle",
  whenToUse: "Paseo real-provider QA only",
  phases: [{ title: "Verify", detail: "one child returns a fixed marker" }],
};

phase("Verify");
const child = await agent(
  'Return exactly this JSON object and do nothing else: {"marker":"PASEO_WORKFLOW_ROW_OK"}',
  {
    label: "workflow-row-child",
    phase: "Verify",
    schema: {
      type: "object",
      required: ["marker"],
      properties: { marker: { type: "string" } },
    },
  },
);
return { child };
