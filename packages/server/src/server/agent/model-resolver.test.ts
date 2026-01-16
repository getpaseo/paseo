import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAgentModel } from "./model-resolver.js";

vi.mock("./provider-registry.js", () => ({
  buildProviderRegistry: vi.fn(),
}));

import { buildProviderRegistry } from "./provider-registry.js";

const mockedBuildProviderRegistry = vi.mocked(buildProviderRegistry);
const testLogger = { warn: vi.fn() } as any;

describe("resolveAgentModel", () => {
  beforeEach(() => {
    mockedBuildProviderRegistry.mockReset();
    testLogger.warn.mockClear();
  });

  it("returns the trimmed requested model when provided", async () => {
    const result = await resolveAgentModel({
      provider: "codex",
      requestedModel: "  gpt-5.1  ",
      cwd: "/tmp",
      logger: testLogger,
    });

    expect(result).toBe("gpt-5.1");
    expect(mockedBuildProviderRegistry).not.toHaveBeenCalled();
  });

  it("uses the default model from the provider catalog when no model specified", async () => {
    const fetchModels = vi.fn().mockResolvedValue([
      { id: "claude-3.5-haiku", isDefault: false },
      { id: "claude-3.5-sonnet", isDefault: true },
    ]);
    mockedBuildProviderRegistry.mockReturnValue({
      claude: { fetchModels },
      codex: { fetchModels: vi.fn() },
      opencode: { fetchModels: vi.fn() },
    } as any);

    const result = await resolveAgentModel({ provider: "claude", cwd: "~/repo", logger: testLogger });

    expect(result).toBe("claude-3.5-sonnet");
    expect(fetchModels).toHaveBeenCalledWith({
      cwd: expect.stringMatching(/repo$/),
    });
  });

  it("falls back to the first model when none are flagged as default", async () => {
    const fetchModels = vi.fn().mockResolvedValue([
      { id: "model-a", isDefault: false },
      { id: "model-b", isDefault: false },
    ]);
    mockedBuildProviderRegistry.mockReturnValue({
      claude: { fetchModels: vi.fn() },
      codex: { fetchModels },
      opencode: { fetchModels: vi.fn() },
    } as any);

    const result = await resolveAgentModel({ provider: "codex", logger: testLogger });

    expect(result).toBe("model-a");
  });

  it("returns undefined when the catalog lookup fails", async () => {
    const fetchModels = vi.fn().mockRejectedValue(new Error("boom"));
    mockedBuildProviderRegistry.mockReturnValue({
      claude: { fetchModels: vi.fn() },
      codex: { fetchModels },
      opencode: { fetchModels: vi.fn() },
    } as any);

    const result = await resolveAgentModel({ provider: "codex", logger: testLogger });

    expect(result).toBeUndefined();
    expect(testLogger.warn).toHaveBeenCalled();
  });
});
