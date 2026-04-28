import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAgentModel } from "./model-resolver.js";

vi.mock("./provider-registry.js", () => ({
  buildProviderRegistry: vi.fn(),
  isProviderEnabled: vi.fn((definition: { enabled: boolean }) => definition.enabled === true),
}));

import { buildProviderRegistry } from "./provider-registry.js";

const mockedBuildProviderRegistry = vi.mocked(buildProviderRegistry);
const testLoggerWarn = vi.fn();
const testLogger = { warn: testLoggerWarn } as unknown as Logger;
type ProviderRegistryMock = ReturnType<typeof buildProviderRegistry>;

describe("resolveAgentModel", () => {
  beforeEach(() => {
    mockedBuildProviderRegistry.mockReset();
    testLoggerWarn.mockClear();
  });

  it("returns the trimmed requested model when provided", async () => {
    mockedBuildProviderRegistry.mockReturnValue({
      claude: { enabled: true, fetchModels: vi.fn() },
      codex: { enabled: true, fetchModels: vi.fn() },
      opencode: { enabled: true, fetchModels: vi.fn() },
    } as unknown as ProviderRegistryMock);

    const result = await resolveAgentModel({
      provider: "codex",
      requestedModel: "  gpt-5.1  ",
      cwd: "/tmp",
      logger: testLogger,
    });

    expect(result).toBe("gpt-5.1");
    expect(mockedBuildProviderRegistry).toHaveBeenCalledWith(testLogger);
  });

  it("uses the default model from the provider catalog when no model specified", async () => {
    const fetchModels = vi.fn().mockResolvedValue([
      { id: "claude-3.5-haiku", isDefault: false },
      { id: "claude-3.5-sonnet", isDefault: true },
    ]);
    mockedBuildProviderRegistry.mockReturnValue({
      claude: { enabled: true, fetchModels },
      codex: { enabled: true, fetchModels: vi.fn() },
      opencode: { enabled: true, fetchModels: vi.fn() },
    } as unknown as ProviderRegistryMock);

    const result = await resolveAgentModel({
      provider: "claude",
      cwd: "~/repo",
      logger: testLogger,
    });

    expect(result).toBe("claude-3.5-sonnet");
    expect(fetchModels).toHaveBeenCalledWith({
      cwd: expect.stringMatching(/repo$/),
      force: false,
    });
  });

  it("falls back to the first model when none are flagged as default", async () => {
    const fetchModels = vi.fn().mockResolvedValue([
      { id: "model-a", isDefault: false },
      { id: "model-b", isDefault: false },
    ]);
    mockedBuildProviderRegistry.mockReturnValue({
      claude: { enabled: true, fetchModels: vi.fn() },
      codex: { enabled: true, fetchModels },
      opencode: { enabled: true, fetchModels: vi.fn() },
    } as unknown as ProviderRegistryMock);

    const result = await resolveAgentModel({ provider: "codex", logger: testLogger });

    expect(result).toBe("model-a");
  });

  it("returns undefined when the catalog lookup fails", async () => {
    const fetchModels = vi.fn().mockRejectedValue(new Error("boom"));
    mockedBuildProviderRegistry.mockReturnValue({
      claude: { enabled: true, fetchModels: vi.fn() },
      codex: { enabled: true, fetchModels },
      opencode: { enabled: true, fetchModels: vi.fn() },
    } as unknown as ProviderRegistryMock);

    const result = await resolveAgentModel({ provider: "codex", logger: testLogger });

    expect(result).toBeUndefined();
    expect(testLoggerWarn).toHaveBeenCalled();
  });

  it("returns undefined for a disabled provider without fetching default models", async () => {
    const fetchModels = vi.fn().mockResolvedValue([{ id: "model-a", isDefault: true }]);
    mockedBuildProviderRegistry.mockReturnValue({
      claude: { enabled: true, fetchModels: vi.fn() },
      codex: { enabled: false, fetchModels },
      opencode: { enabled: true, fetchModels: vi.fn() },
    } as unknown as ProviderRegistryMock);

    const result = await resolveAgentModel({ provider: "codex", logger: testLogger });

    expect(result).toBeUndefined();
    expect(fetchModels).not.toHaveBeenCalled();
    expect(testLoggerWarn).toHaveBeenCalled();
  });

  it("returns undefined for a requested model from a disabled provider", async () => {
    const fetchModels = vi.fn();
    mockedBuildProviderRegistry.mockReturnValue({
      claude: { enabled: true, fetchModels: vi.fn() },
      codex: { enabled: false, fetchModels },
      opencode: { enabled: true, fetchModels: vi.fn() },
    } as unknown as ProviderRegistryMock);

    const result = await resolveAgentModel({
      provider: "codex",
      requestedModel: "gpt-5.1",
      logger: testLogger,
    });

    expect(result).toBeUndefined();
    expect(fetchModels).not.toHaveBeenCalled();
    expect(testLoggerWarn).toHaveBeenCalled();
  });
});
