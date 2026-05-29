import { describe, expect, it } from "vitest";

import { bufferToWorkerBytes, workerBytesToBuffer } from "./worker-bytes.js";

describe("local speech worker bytes", () => {
  it("turns Buffer views into process-local byte payloads", () => {
    const source = Buffer.from([0, 1, 2, 3, 4]).subarray(1, 5);
    expect(source.byteOffset % 2).toBe(1);

    const received = workerBytesToBuffer(bufferToWorkerBytes(source));

    expect(received).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(received.byteOffset).toBe(0);
  });
});
