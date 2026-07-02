import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import { mcpInputSchemaToTypeBox } from "./mcp-schema.js";

describe("mcpInputSchemaToTypeBox", () => {
  it("converts an object schema with required and optional properties", () => {
    const schema = mcpInputSchemaToTypeBox({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
    expect(Value.Check(schema, { a: "x" })).toBe(true);
    expect(Value.Check(schema, { a: "x", b: 1 })).toBe(true);
    expect(Value.Check(schema, { b: 1 })).toBe(false); // missing required "a"
    expect(Value.Check(schema, { a: 1 })).toBe(false); // wrong type for "a"
  });

  it("converts enums to a closed set", () => {
    const schema = mcpInputSchemaToTypeBox({
      type: "object",
      properties: { mode: { type: "string", enum: ["read", "write"] } },
      required: ["mode"],
    });
    expect(Value.Check(schema, { mode: "read" })).toBe(true);
    expect(Value.Check(schema, { mode: "delete" })).toBe(false);
  });

  it("converts arrays with typed items", () => {
    const schema = mcpInputSchemaToTypeBox({
      type: "object",
      properties: { tags: { type: "array", items: { type: "number" } } },
      required: ["tags"],
    });
    expect(Value.Check(schema, { tags: [1, 2] })).toBe(true);
    expect(Value.Check(schema, { tags: ["x"] })).toBe(false);
  });

  it("converts nested objects", () => {
    const schema = mcpInputSchemaToTypeBox({
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      required: ["filter"],
    });
    expect(Value.Check(schema, { filter: { name: "a" } })).toBe(true);
    expect(Value.Check(schema, { filter: {} })).toBe(false);
  });

  it("accepts any object when the schema is missing or empty", () => {
    expect(Value.Check(mcpInputSchemaToTypeBox(undefined), { anything: 1 })).toBe(true);
    expect(Value.Check(mcpInputSchemaToTypeBox({}), { anything: 1 })).toBe(true);
  });

  it("treats a property-only schema (no declared type) as an object", () => {
    const schema = mcpInputSchemaToTypeBox({
      properties: { q: { type: "string" } },
      required: ["q"],
    });
    expect(Value.Check(schema, { q: "hi" })).toBe(true);
    expect(Value.Check(schema, {})).toBe(false);
  });

  it("preserves descriptions", () => {
    const schema = mcpInputSchemaToTypeBox({
      type: "object",
      description: "the tool input",
      properties: {},
    }) as Record<string, unknown>;
    expect(schema.description).toBe("the tool input");
  });
});
