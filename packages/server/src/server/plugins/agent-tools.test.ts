import { expect, test } from "vitest";
import { z } from "zod";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { serializeAgentTool } from "./agent-tools.js";
import { serializePaseoToolInputParameters } from "../agent/tools/paseo-tool-serialization.js";

test("agent tool schemas survive the process boundary and catalog round trip", () => {
  const input = z
    .object({
      title: z.string().min(1).describe("Issue title"),
      state: z.enum(["open", "closed"]),
      tags: z.array(z.string()).optional(),
      nested: z.object({ enabled: z.boolean() }),
    })
    .describe("Create an issue");
  const tool = defineAgentTool({
    name: "create_issue",
    description: "Create",
    input,
    execute: () => ({ text: "done" }),
  });
  const metadata = JSON.parse(JSON.stringify(serializeAgentTool(tool)));
  const restored = z.fromJSONSchema(metadata.inputSchema);
  expect(
    serializePaseoToolInputParameters({
      ...metadata,
      inputSchema: restored,
      handler: async () => ({ content: [] }),
    }),
  ).toEqual({
    ...metadata.inputSchema,
    additionalProperties: {},
    properties: {
      ...metadata.inputSchema.properties,
      nested: { ...metadata.inputSchema.properties.nested, additionalProperties: {} },
    },
  });
  expect(restored.parse({ title: "Bug", state: "open", nested: { enabled: true } })).toEqual({
    title: "Bug",
    state: "open",
    nested: { enabled: true },
  });
  expect(
    restored.safeParse({ title: "", state: "unknown", nested: { enabled: true } }).success,
  ).toBe(false);
});
