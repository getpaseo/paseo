import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isPlatform } from "../test-utils/platform.js";
import { encodeFrame, FrameDecoder, TerminalWorkerFrameError } from "./terminal-worker-frames.js";
import { connectTerminalWorker, TerminalWorkerConnectError } from "./terminal-worker-client.js";
import { launchTerminalWorker } from "./terminal-worker-launch.js";
import { terminalWorkerRecordPath } from "./terminal-worker-record.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("terminal worker frames", () => {
  it("decodes frames split across chunks and several frames in one chunk", () => {
    const first = encodeFrame({ type: "a", data: new Map([["k", 1]]) });
    const second = encodeFrame({ type: "b" });
    const joined = Buffer.concat([first, second]);
    const decoder = new FrameDecoder();
    expect(decoder.push(joined.subarray(0, 3))).toEqual([]);
    expect(decoder.push(joined.subarray(3, first.length + 2))).toEqual([
      { type: "a", data: new Map([["k", 1]]) },
    ]);
    expect(decoder.push(joined.subarray(first.length + 2))).toEqual([{ type: "b" }]);
  });

  it("rejects a frame header announcing an oversized payload", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(0xffffffff, 0);
    expect(() => new FrameDecoder().push(header)).toThrow(TerminalWorkerFrameError);
  });
});

describe("terminal worker authentication", () => {
  it("closes a connection with the wrong secret and accepts the record's secret", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "tw-auth-"));
    temporaryDirs.push(paseoHome);
    const { record, recordPath } = await launchTerminalWorker({
      paseoHome,
      paseoVersion: "0.0.0-test",
    });
    expect(recordPath).toBe(terminalWorkerRecordPath(paseoHome, record.pid));
    if (!isPlatform("win32")) {
      expect(statSync(recordPath).mode & 0o777).toBe(0o600);
      expect(statSync(record.socketPath).mode & 0o777).toBe(0o600);
    }

    await expect(
      connectTerminalWorker({ socketPath: record.socketPath, secret: "wrong-secret" }),
    ).rejects.toBeInstanceOf(TerminalWorkerConnectError);

    const connection = await connectTerminalWorker({
      socketPath: record.socketPath,
      secret: record.secret,
    });
    expect(connection.workerPid).toBe(record.pid);
    // With no terminals, a worker whose controller leaves exits and removes its record.
    connection.disconnect();
    await waitUntil(() => !existsSync(recordPath), 10_000);
  });
});
