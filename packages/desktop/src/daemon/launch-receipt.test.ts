import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasDesktopDaemonLaunchReceipt, recordDesktopDaemonLaunch } from "./launch-receipt";

describe("desktop daemon launch receipt", () => {
  let directory: string;
  const instance = { pid: 1234, startedAt: "2026-11-17T00:00:00.000Z" };
  let input: Parameters<typeof recordDesktopDaemonLaunch>[0];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "paseo-launch-receipt-"));
    input = { filePath: path.join(directory, "launch.json"), home: "/home/paseo", instance };
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("retains the exact launched instance across application sessions", () => {
    recordDesktopDaemonLaunch(input);

    expect(JSON.parse(readFileSync(input.filePath, "utf8"))).toEqual({
      home: input.home,
      ...instance,
    });
    expect(hasDesktopDaemonLaunchReceipt(input)).toBe(true);
  });

  it("does not authorize a different home, PID, or start time", () => {
    recordDesktopDaemonLaunch(input);

    expect(hasDesktopDaemonLaunchReceipt({ ...input, home: "/home/other" })).toBe(false);
    expect(hasDesktopDaemonLaunchReceipt({ ...input, instance: { ...instance, pid: 5678 } })).toBe(
      false,
    );
    expect(
      hasDesktopDaemonLaunchReceipt({
        ...input,
        instance: { ...instance, startedAt: "2026-11-17T01:00:00.000Z" },
      }),
    ).toBe(false);
  });

  it.each([
    "garbage",
    "null",
    JSON.stringify({ home: "/home/paseo", pid: 1234 }),
    JSON.stringify({ home: "/home/paseo", ...instance, startedAt: "invalid" }),
    JSON.stringify({ home: "/home/paseo", ...instance, desktopManaged: true }),
  ])("does not authorize an invalid receipt %s", (contents) => {
    writeFileSync(input.filePath, contents);

    expect(hasDesktopDaemonLaunchReceipt(input)).toBe(false);
  });

  it("does not authorize a missing receipt", () => {
    expect(hasDesktopDaemonLaunchReceipt(input)).toBe(false);
  });

  it("does not conceal receipt read failures", () => {
    expect(() => hasDesktopDaemonLaunchReceipt({ ...input, filePath: directory })).toThrow();
  });

  it.skipIf(process.platform === "win32")("keeps its receipt private", () => {
    recordDesktopDaemonLaunch(input);

    expect(statSync(input.filePath).mode & 0o777).toBe(0o600);
  });
});
