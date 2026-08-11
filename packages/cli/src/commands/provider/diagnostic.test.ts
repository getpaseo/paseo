import { describe, expect, it, vi } from "vitest";

import { providerDiagnosticSchema, runDiagnosticCommand } from "./diagnostic.js";

const { getProviderDiagnostic, close, connectToDaemon } = vi.hoisted(() => {
  const mockGetProviderDiagnostic = vi.fn(async (provider: string) => ({
    provider,
    diagnostic: "Status: available\nResolved path: /usr/local/bin/claude",
  }));
  const mockClose = vi.fn(async () => undefined);
  const mockConnectToDaemon = vi.fn(async () => ({
    getProviderDiagnostic: mockGetProviderDiagnostic,
    close: mockClose,
  }));
  return {
    getProviderDiagnostic: mockGetProviderDiagnostic,
    close: mockClose,
    connectToDaemon: mockConnectToDaemon,
  };
});

vi.mock("../../utils/client.js", () => ({ connectToDaemon }));

describe("runDiagnosticCommand", () => {
  it("requests the normalized provider from the selected daemon", async () => {
    const result = await runDiagnosticCommand(" Claude ", { host: "devbox:6767" }, {} as never);

    expect(connectToDaemon).toHaveBeenCalledWith({ host: "devbox:6767" });
    expect(getProviderDiagnostic).toHaveBeenCalledWith("claude");
    expect(result.data).toEqual({
      provider: "claude",
      diagnostic: "Status: available\nResolved path: /usr/local/bin/claude",
    });
    expect(providerDiagnosticSchema.renderHuman?.(result)).toBe(
      "Status: available\nResolved path: /usr/local/bin/claude",
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
