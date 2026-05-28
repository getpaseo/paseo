import { describe, expect, it } from "vitest";
import { readDesktopSystemIdleTimeMs, type DesktopIpcInvoker } from "./idle";

function fakeInvoker(result: () => Promise<unknown>): DesktopIpcInvoker {
  return <T>() => result() as Promise<T>;
}

describe("readDesktopSystemIdleTimeMs", () => {
  it("returns the millisecond value reported by the desktop idle command", async () => {
    const invokedCommands: string[] = [];
    const invoke: DesktopIpcInvoker = async <T>(command: string) => {
      invokedCommands.push(command);
      return 4_200 as T;
    };

    const idleTimeMs = await readDesktopSystemIdleTimeMs(invoke);

    expect(idleTimeMs).toBe(4_200);
    expect(invokedCommands).toEqual(["desktop_get_system_idle_time"]);
  });

  it("returns null when the desktop IPC rejects", async () => {
    const idleTimeMs = await readDesktopSystemIdleTimeMs(
      fakeInvoker(async () => {
        throw new Error("ipc failed");
      }),
    );

    expect(idleTimeMs).toBeNull();
  });

  it("returns null when the desktop IPC returns null", async () => {
    const idleTimeMs = await readDesktopSystemIdleTimeMs(fakeInvoker(async () => null));

    expect(idleTimeMs).toBeNull();
  });

  it("returns null when the desktop IPC returns NaN", async () => {
    const idleTimeMs = await readDesktopSystemIdleTimeMs(fakeInvoker(async () => Number.NaN));

    expect(idleTimeMs).toBeNull();
  });

  it("returns null when the desktop IPC returns a negative value", async () => {
    const idleTimeMs = await readDesktopSystemIdleTimeMs(fakeInvoker(async () => -1));

    expect(idleTimeMs).toBeNull();
  });

  it("returns zero when the desktop IPC returns zero", async () => {
    const idleTimeMs = await readDesktopSystemIdleTimeMs(fakeInvoker(async () => 0));

    expect(idleTimeMs).toBe(0);
  });
});
