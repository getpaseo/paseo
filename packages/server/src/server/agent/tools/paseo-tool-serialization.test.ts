import { describe, expect, test } from "vitest";

import { serializePaseoToolInputParameters } from "./paseo-tool-serialization.js";

describe("Paseo tool input serialization", () => {
  test("preserves built-in JSON schemas without applying plugin admission policy", () => {
    const schema = {
      type: "object",
      properties: {},
      additionalProperties: {},
      $ref: "#/definitions/provider-owned",
    };
    const tool = {
      name: "provider_tool",
      description: "Provider-owned tool.",
      inputSchemaJson: schema,
      handler: async () => ({ content: [] }),
    };

    expect(serializePaseoToolInputParameters(tool)).toBe(schema);
  });

  test("keeps plugin schemas on the exact supported subset", () => {
    const tool = {
      name: "acme.lookup",
      description: "Plugin tool.",
      source: "plugin" as const,
      inputSchemaJson: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      handler: async () => ({ content: [] }),
    };

    expect(serializePaseoToolInputParameters(tool)).toEqual(tool.inputSchemaJson);
    expect(() =>
      serializePaseoToolInputParameters({
        ...tool,
        inputSchemaJson: { type: "object", $ref: "#/definitions/unsupported" },
      }),
    ).toThrow(/unsupported.*\$ref/);
  });
});
