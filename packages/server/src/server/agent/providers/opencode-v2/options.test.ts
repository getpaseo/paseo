import { describe, expect, test } from "vitest";

import { validateProviderOptions } from "../../provider-options.js";
import { OpenCodeV2ProviderOptionsSchema } from "./options.js";

describe("OpenCodeV2ProviderOptionsSchema", () => {
  test("accepts a top-level permission action", () => {
    expect(OpenCodeV2ProviderOptionsSchema.parse({ permission: "ask" })).toEqual({
      permission: "ask",
    });
    expect(OpenCodeV2ProviderOptionsSchema.parse({ permission: "allow" })).toEqual({
      permission: "allow",
    });
    expect(OpenCodeV2ProviderOptionsSchema.parse({ permission: "deny" })).toEqual({
      permission: "deny",
    });
  });

  test("accepts per-action v2 permission rules", () => {
    const parsed = OpenCodeV2ProviderOptionsSchema.parse({
      permission: {
        shell: "allow",
        edit: { "*": "ask", "**/*.ts": "allow" },
        read: "ask",
        grep: "allow",
        glob: "allow",
        webfetch: "ask",
        websearch: "deny",
        subagent: "ask",
        external_directory: { "*": "deny", "/var/cache/npm/**": "allow" },
        "*": "ask",
      },
    });
    expect(parsed).toMatchObject({
      permission: {
        shell: "allow",
        edit: { "*": "ask", "**/*.ts": "allow" },
        external_directory: { "*": "deny", "/var/cache/npm/**": "allow" },
        "*": "ask",
      },
    });
  });

  test("accepts an empty options object", () => {
    expect(OpenCodeV2ProviderOptionsSchema.parse({})).toEqual({});
  });

  test("rejects unknown top-level keys (strict)", () => {
    expect(() => OpenCodeV2ProviderOptionsSchema.parse({ mcp: {} })).toThrow();
    expect(() => OpenCodeV2ProviderOptionsSchema.parse({ cwd: "/tmp" })).toThrow();
  });

  test("rejects unknown permission action keys (strict)", () => {
    expect(() => OpenCodeV2ProviderOptionsSchema.parse({ permission: { bash: "ask" } })).toThrow();
    expect(() =>
      OpenCodeV2ProviderOptionsSchema.parse({ permission: { todowrite: "ask" } }),
    ).toThrow();
  });

  test("rejects invalid permission values", () => {
    expect(() =>
      OpenCodeV2ProviderOptionsSchema.parse({ permission: { shell: "sometimes" } }),
    ).toThrow();
    expect(() => OpenCodeV2ProviderOptionsSchema.parse({ permission: "sometimes" })).toThrow();
  });

  test("validateProviderOptions reports the exact invalid path", () => {
    expect(() =>
      validateProviderOptions("opencode-v2", OpenCodeV2ProviderOptionsSchema, {
        permission: { shell: { "git status": "sometimes" } },
      }),
    ).toThrow('providerOptions.permission.shell["git status"]');
  });
});
