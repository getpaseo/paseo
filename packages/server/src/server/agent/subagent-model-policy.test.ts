import { describe, expect, test } from "vitest";

import { projectSubagentModels, resolveSubagentModel } from "./subagent-model-policy.js";

const models = [
  { provider: "codex", id: "gpt-default", label: "Default", isDefault: true },
  { provider: "codex", id: "gpt-small", label: "Small" },
];

describe("subagent model policy", () => {
  test("leaves an unrestricted provider catalog unchanged", () => {
    expect(projectSubagentModels({ provider: "codex", models, policy: undefined })).toEqual(models);
    expect(
      resolveSubagentModel({
        provider: "codex",
        requestedModel: "gpt-small",
        models,
        policy: undefined,
      }),
    ).toBeUndefined();
  });

  test("filters allowed available models and projects guidance", () => {
    expect(
      projectSubagentModels({
        provider: "codex",
        models,
        policy: {
          subagentAllowedModels: ["gpt-small", "stale-model"],
          subagentModelGuidance: {
            "gpt-small": "Use for bounded edits.",
            "stale-model": "Must not be projected.",
          },
        },
      }),
    ).toEqual([
      {
        provider: "codex",
        id: "gpt-small",
        label: "Small",
        whenToUse: "Use for bounded edits.",
      },
    ]);
  });

  test("treats an empty allowlist as unrestricted and preserves guidance", () => {
    expect(
      projectSubagentModels({
        provider: "codex",
        models,
        policy: {
          subagentAllowedModels: [],
          subagentModelGuidance: { "gpt-small": "Use for bounded edits." },
        },
      }),
    ).toEqual([models[0], { ...models[1], whenToUse: "Use for bounded edits." }]);
    expect(
      resolveSubagentModel({
        provider: "codex",
        requestedModel: undefined,
        models,
        policy: { subagentAllowedModels: [] },
      }),
    ).toBeUndefined();
  });

  test("supports guidance without an allowlist", () => {
    expect(
      projectSubagentModels({
        provider: "codex",
        models,
        policy: { subagentModelGuidance: { "gpt-default": "Use for broad work." } },
      }),
    ).toEqual([{ ...models[0], whenToUse: "Use for broad work." }, models[1]]);
  });

  test("preserves slashes that belong to a model ID", () => {
    const namespacedModels = [
      { provider: "opencode", id: "anthropic/claude-sonnet", label: "Sonnet" },
    ];
    expect(
      projectSubagentModels({
        provider: "opencode",
        models: namespacedModels,
        policy: { subagentAllowedModels: ["anthropic/claude-sonnet"] },
      }),
    ).toEqual(namespacedModels);
  });

  test("rejects explicit disallowed models and disallowed provider defaults", () => {
    const policy = { subagentAllowedModels: ["gpt-small"] };
    expect(() =>
      resolveSubagentModel({ provider: "codex", requestedModel: "gpt-default", models, policy }),
    ).toThrow("not allowed");
    expect(() =>
      resolveSubagentModel({ provider: "codex", requestedModel: undefined, models, policy }),
    ).toThrow("not allowed");
  });
});
