import { describe, expect, it } from "vitest";
import { buildProviderOverride } from "./add.js";

describe("provider add override", () => {
  it("builds a profile that extends a built-in provider", () => {
    expect(
      buildProviderOverride("claude-work", {
        extends: "claude",
        label: "Claude (Work)",
        description: "Work account",
        env: ["ANTHROPIC_API_KEY=sk-ant-123", "ANTHROPIC_BASE_URL=https://proxy/v1"],
      }),
    ).toEqual({
      id: "claude-work",
      override: {
        extends: "claude",
        label: "Claude (Work)",
        description: "Work account",
        env: {
          ANTHROPIC_API_KEY: "sk-ant-123",
          ANTHROPIC_BASE_URL: "https://proxy/v1",
        },
      },
    });
  });

  it("defaults the label to the id and marks the first model as default", () => {
    expect(
      buildProviderOverride("zai", {
        extends: "claude",
        model: ["glm-5-turbo=GLM 5 Turbo", "glm-4.5-air"],
      }),
    ).toEqual({
      id: "zai",
      override: {
        extends: "claude",
        label: "zai",
        models: [
          { id: "glm-5-turbo", label: "GLM 5 Turbo", isDefault: true },
          { id: "glm-4.5-air", label: "glm-4.5-air" },
        ],
      },
    });
  });

  it("keeps the command argv for acp providers", () => {
    expect(
      buildProviderOverride("gemini", {
        extends: "acp",
        label: "Gemini",
        command: ["npx", "-y", "@google/gemini-cli", "--experimental-acp"],
      }).override.command,
    ).toEqual(["npx", "-y", "@google/gemini-cli", "--experimental-acp"]);
  });

  it("rejects ids that do not match the provider id pattern", () => {
    expect(() => buildProviderOverride("Claude_Work", { extends: "claude" })).toThrow(
      /Invalid provider id/,
    );
  });

  it("refuses to shadow a built-in provider id", () => {
    expect(() => buildProviderOverride("claude", { extends: "claude" })).toThrow(/built-in/);
  });

  it("rejects an unknown extends target", () => {
    expect(() => buildProviderOverride("mine", { extends: "gpt" })).toThrow(/Invalid --extends/);
  });

  it("requires a command when extending acp", () => {
    expect(() => buildProviderOverride("mine", { extends: "acp" })).toThrow(
      /--command is required/,
    );
  });

  it("rejects env entries that are not KEY=VALUE", () => {
    expect(() => buildProviderOverride("mine", { extends: "claude", env: ["NOPE"] })).toThrow(
      /expected KEY=VALUE/,
    );
  });
});
