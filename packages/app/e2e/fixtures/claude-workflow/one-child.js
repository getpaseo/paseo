export const meta = {
  name: "paseo-workflow-row-qa",
  description: "Verify the workflow row lifecycle",
  whenToUse: "Paseo real-provider QA only",
  phases: [{ title: "Verify", detail: "one child returns a fixed marker" }],
};

phase("Verify");
let input = args;
if (typeof input === "string") input = JSON.parse(input);
const gatePath = input?.gatePath;
if (typeof gatePath !== "string" || gatePath.length === 0) {
  throw new Error("gatePath is required");
}
const child = await agent(
  `First use Bash to run this command and wait for it to exit:
while [ ! -f ${JSON.stringify(gatePath)} ]; do sleep 0.2; done

Then return exactly this JSON object and do nothing else: {"marker":"PASEO_WORKFLOW_ROW_OK"}`,
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
