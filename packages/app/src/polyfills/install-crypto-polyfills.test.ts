import { describe, expect, it } from "vitest";
import {
  installCryptoPolyfills,
  type CryptoPolyfillSources,
  type CryptoPolyfillTarget,
} from "./install-crypto-polyfills";

interface RecordingFillRandomValues {
  fill: CryptoPolyfillSources["expoGetRandomValues"];
  calls: number;
}

function recordingFillFromBytes(bytes: Uint8Array): RecordingFillRandomValues {
  const recorder = { calls: 0 } as RecordingFillRandomValues;
  recorder.fill = <T extends ArrayBufferView | null>(array: T): T => {
    recorder.calls += 1;
    if (array && ArrayBuffer.isView(array)) {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
    }
    return array;
  };
  return recorder;
}

const TEST_BYTES = Uint8Array.from([
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
]);

describe("installCryptoPolyfills", () => {
  it("derives randomUUID from the target's native getRandomValues when available", () => {
    const native = recordingFillFromBytes(TEST_BYTES);
    const expo = recordingFillFromBytes(TEST_BYTES);
    const target: CryptoPolyfillTarget = {
      crypto: { getRandomValues: native.fill } as unknown as Crypto,
    };

    installCryptoPolyfills(target, { expoGetRandomValues: expo.fill });

    expect(target.crypto!.randomUUID()).toBe("00112233-4455-4677-8899-aabbccddeeff");
    expect(native.calls).toBe(1);
    expect(expo.calls).toBe(0);
  });

  it("falls back to the injected expo source when the target has no crypto", () => {
    const expo = recordingFillFromBytes(TEST_BYTES);
    const target: CryptoPolyfillTarget = {};

    installCryptoPolyfills(target, { expoGetRandomValues: expo.fill });

    expect(target.crypto!.randomUUID()).toBe("00112233-4455-4677-8899-aabbccddeeff");
    expect(expo.calls).toBe(1);
  });

  it("installs getRandomValues that delegates to the expo source", () => {
    const expo = recordingFillFromBytes(TEST_BYTES);
    const target: CryptoPolyfillTarget = {};

    installCryptoPolyfills(target, { expoGetRandomValues: expo.fill });

    const buf = new Uint8Array(16);
    target.crypto!.getRandomValues(buf);
    expect(Array.from(buf)).toEqual(Array.from(TEST_BYTES));
    expect(expo.calls).toBe(1);
  });

  it("installs Buffer-backed TextEncoder and TextDecoder when missing", () => {
    const expo = recordingFillFromBytes(TEST_BYTES);
    const target: CryptoPolyfillTarget = {};

    installCryptoPolyfills(target, { expoGetRandomValues: expo.fill });

    expect(typeof target.TextEncoder).toBe("function");
    expect(typeof target.TextDecoder).toBe("function");
    const encoded = new target.TextEncoder!().encode("hello");
    expect(Array.from(encoded)).toEqual([104, 101, 108, 108, 111]);
    expect(new target.TextDecoder!().decode(encoded)).toBe("hello");
  });
});
