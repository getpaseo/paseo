import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PLUGIN_TOOL_MAX_TIMEOUT_MS,
  assertSafeJson,
  assertSupportedJsonSchema,
  clampPluginToolTimeout,
  isReservedPluginToolName,
  serializePluginToolSchema,
} from "./plugin-tool.js";

describe("plugin tool policy", () => {
  it("serializes bounded Zod input and output schemas", () => {
    expect(
      serializePluginToolSchema(z.object({ value: z.string().min(1) }), "example.input"),
    ).toEqual(
      expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({ value: expect.anything() }),
        required: ["value"],
      }),
    );
  });

  it("rejects dangerous, cyclic, and oversized values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertSafeJson(cyclic, "input")).toThrow(/cyclic/);
    expect(() => assertSafeJson({ constructor: "blocked" }, "input")).toThrow(/dangerous/);
    expect(() => assertSafeJson("x".repeat(100), "input", 10)).toThrow(/byte limit/);
  });

  it("fails closed for scalar roots and unsupported schema keywords", () => {
    expect(() =>
      serializePluginToolSchema(z.string(), "scalar.input", { requireObject: true }),
    ).toThrow(/object schema/);
    expect(() =>
      serializePluginToolSchema(
        z.object({ value: z.string().min(2).max(4) }).strict(),
        "bounded.input",
        { requireObject: true },
      ),
    ).not.toThrow();
    expect(() =>
      assertSupportedJsonSchema(
        { type: "object", properties: {}, $ref: "#/definitions/nope" },
        "unsupported.input",
        { requireObject: true },
      ),
    ).toThrow(/unsupported.*\$ref/);
  });

  it("caps timeouts and reserves Paseo namespaces", () => {
    expect(clampPluginToolTimeout(undefined)).toBe(30_000);
    expect(clampPluginToolTimeout(PLUGIN_TOOL_MAX_TIMEOUT_MS * 2)).toBe(PLUGIN_TOOL_MAX_TIMEOUT_MS);
    expect(isReservedPluginToolName("get_agent_status")).toBe(true);
    expect(isReservedPluginToolName("paseo.internal")).toBe(true);
    expect(isReservedPluginToolName("plugin.internal")).toBe(true);
    expect(isReservedPluginToolName("acme.lookup")).toBe(false);
  });
});
