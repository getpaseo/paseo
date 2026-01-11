import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAgentModel } from "./model-resolver.js";

vi.mock("./provider-registry.js", () => ({
  fetchProviderModels: vi.fn(),
}));

import { fetchProviderModels } from "./provider-registry.js";

const mockedFetch = vi.mocked(fetchProviderModels);

describe("resolveAgentModel", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it("returns the trimmed requested model when provided", async () => {
    const result = await resolveAgentModel({
      provider: "codex",
      requestedModel: "  gpt-5.1  ",
      cwd: "/tmp",
    });

    expect(result).toBe("gpt-5.1");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("uses the default model from the provider catalog when no model specified", async () => {
    mockedFetch.mockResolvedValue([
      { id: "claude-3.5-haiku", isDefault: false } as any,
      { id: "claude-3.5-sonnet", isDefault: true } as any,
    ]);

    const result = await resolveAgentModel({ provider: "claude", cwd: "~/repo" });

    expect(result).toBe("claude-3.5-sonnet");
    expect(mockedFetch).toHaveBeenCalledWith("claude", {
      cwd: expect.stringMatching(/repo$/),
    });
  });

  it("falls back to the first model when none are flagged as default", async () => {
    mockedFetch.mockResolvedValue([
      { id: "model-a", isDefault: false } as any,
      { id: "model-b", isDefault: false } as any,
    ]);

    const result = await resolveAgentModel({ provider: "codex" });

    expect(result).toBe("model-a");
  });

  it("returns undefined when the catalog lookup fails", async () => {
    mockedFetch.mockRejectedValue(new Error("boom"));

    const result = await resolveAgentModel({ provider: "codex" });

    expect(result).toBeUndefined();
  });
});
