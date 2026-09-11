import { describe, expect, test } from "vitest";
import { ProviderOverridesSchema } from "./provider-config.js";

const TOO_MANY_DENIED_TOOLS = Array.from({ length: 513 }, () => "tool");

describe("ProviderOverridesSchema", () => {
  test("preserves provider options and settings for plugin-derived profiles", () => {
    expect(
      ProviderOverridesSchema.parse({
        "omp-work": {
          extends: "omp-plugin",
          label: "OMP work",
          providerOptions: { env: { OMP_HOME: "/srv/omp" } },
          settings: { approval: "ask" },
        },
      }),
    ).toEqual({
      "omp-work": {
        extends: "omp-plugin",
        label: "OMP work",
        providerOptions: { env: { OMP_HOME: "/srv/omp" } },
        settings: { approval: "ask" },
      },
    });
  });

  test("accepts an installed plugin's same-ID override without extends", () => {
    expect(
      ProviderOverridesSchema.parse({
        "omp-plugin": {
          providerOptions: { command: ["/opt/omp"] },
          models: [{ id: "configured", label: "Configured" }],
        },
      }),
    ).toEqual({
      "omp-plugin": {
        providerOptions: { command: ["/opt/omp"] },
        models: [{ id: "configured", label: "Configured" }],
      },
    });
  });

  test("bounds generic denied tool configuration", () => {
    const profile = {
      extends: "plugin-base",
      label: "OMP plugin",
      disallowedTools: ["shell", "shell", "web_search"],
    };
    expect(ProviderOverridesSchema.parse({ "omp-plugin": profile })).toEqual({
      "omp-plugin": profile,
    });
    expect(() =>
      ProviderOverridesSchema.parse({
        "omp-plugin": { ...profile, disallowedTools: ["x".repeat(257)] },
      }),
    ).toThrow();
    expect(() =>
      ProviderOverridesSchema.parse({
        "omp-plugin": {
          ...profile,
          disallowedTools: TOO_MANY_DENIED_TOOLS,
        },
      }),
    ).toThrow();
  });
});
