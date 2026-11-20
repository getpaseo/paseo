import { expect, test } from "vitest";
import { z } from "zod";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { PluginAgentTools, serializeAgentTool } from "./agent-tools.js";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
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

test("same-name tools remain bound to their launch and disposed launches never use newer handlers", async () => {
  const tools = new PluginAgentTools();
  const paseo = createPaseoApi(
    new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "launch-tools" }),
  );
  const agent = {
    id: "agent",
    workspaceId: null,
    parentAgentId: null,
    provider: "claude",
    cwd: "/project",
    title: null,
    background: false,
    metadata: {},
  };
  const original = defineAgentTool({
    name: "notes",
    description: "Read notes",
    input: z.object({}),
    execute: () => ({ text: "original" }),
  });
  const replacement = defineAgentTool({
    name: "notes",
    description: "Read notes",
    input: z.object({}),
    execute: () => ({ text: "replacement" }),
  });
  tools.attach(agent.id, [original], "original-launch");
  tools.attach(agent.id, [replacement], "replacement-launch");
  expect(await tools.call("old-call", agent, "notes", {}, paseo, "original-launch")).toEqual({
    text: "original",
  });
  expect(await tools.call("new-call", agent, "notes", {}, paseo, "replacement-launch")).toEqual({
    text: "replacement",
  });
  tools.detach(agent.id, "replacement-launch");
  expect(await tools.call("old-after", agent, "notes", {}, paseo, "original-launch")).toEqual({
    text: "original",
  });
  expect(await tools.call("disposed", agent, "notes", {}, paseo, "replacement-launch")).toEqual({
    isError: true,
    text: "Agent tool not attached: notes",
  });
  expect(
    await tools.call(
      "other-agent",
      { ...agent, id: "other" },
      "notes",
      {},
      paseo,
      "original-launch",
    ),
  ).toEqual({
    isError: true,
    text: "Agent tool not attached: notes",
  });
  tools.close();
});
