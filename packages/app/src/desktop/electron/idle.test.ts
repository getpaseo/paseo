import { afterEach, describe, expect, it, vi } from "vitest";

const { invokeDesktopCommandMock } = vi.hoisted(() => ({
  invokeDesktopCommandMock: vi.fn<() => Promise<unknown>>(async () => 12_000),
}));

vi.mock("@/desktop/electron/invoke", () => ({
  invokeDesktopCommand: invokeDesktopCommandMock,
}));

import { getDesktopSystemIdleTimeMs } from "./idle";

describe("getDesktopSystemIdleTimeMs", () => {
  afterEach(() => {
    invokeDesktopCommandMock.mockReset();
    vi.restoreAllMocks();
  });

  it("invokes the desktop idle command and returns the millisecond value", async () => {
    invokeDesktopCommandMock.mockResolvedValueOnce(4_200);

    const idleTimeMs = await getDesktopSystemIdleTimeMs();

    expect(invokeDesktopCommandMock).toHaveBeenCalledWith("desktop_get_system_idle_time");
    expect(idleTimeMs).toBe(4_200);
  });

  it("returns null and logs once when IPC rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("ipc failed");
    invokeDesktopCommandMock.mockRejectedValueOnce(error);

    const idleTimeMs = await getDesktopSystemIdleTimeMs();

    expect(idleTimeMs).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[DesktopIdle] Failed to read system idle time", error);
  });

  it("returns null and logs once when IPC returns null", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeDesktopCommandMock.mockResolvedValueOnce(null);

    const idleTimeMs = await getDesktopSystemIdleTimeMs();

    expect(idleTimeMs).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[DesktopIdle] Invalid system idle time", null);
  });

  it("returns null and logs once when IPC returns NaN", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeDesktopCommandMock.mockResolvedValueOnce(Number.NaN);

    const idleTimeMs = await getDesktopSystemIdleTimeMs();

    expect(idleTimeMs).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[DesktopIdle] Invalid system idle time", Number.NaN);
  });

  it("returns null and logs once when IPC returns a negative value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeDesktopCommandMock.mockResolvedValueOnce(-1);

    const idleTimeMs = await getDesktopSystemIdleTimeMs();

    expect(idleTimeMs).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[DesktopIdle] Invalid system idle time", -1);
  });

  it("returns 0 when IPC returns zero", async () => {
    invokeDesktopCommandMock.mockResolvedValueOnce(0);

    const idleTimeMs = await getDesktopSystemIdleTimeMs();

    expect(idleTimeMs).toBe(0);
  });
});
