import { describe, expect, test, vi } from "vitest";

import { runPairCommand, type PairCommandOutput, type PairingOffer } from "./pair.js";

const disabledOffer: PairingOffer = { relayEnabled: false, url: null, qr: null };
const enabledOffer: PairingOffer = {
  relayEnabled: true,
  url: "https://app.paseo.sh/#offer=test",
  qr: null,
};

interface RecordedPairCommandOutput extends PairCommandOutput {
  stdout: string[];
  stderr: string[];
  successes: string[];
  exitCode: number | undefined;
}

function createRecordedOutput(): RecordedPairCommandOutput {
  return {
    columns: 80,
    stdout: [],
    stderr: [],
    successes: [],
    exitCode: undefined,
    writeStdout(message) {
      this.stdout.push(message);
    },
    writeStderr(message) {
      this.stderr.push(message);
    },
    setExitCode(code) {
      this.exitCode = code;
    },
    success(message) {
      this.successes.push(message);
    },
  };
}

describe("daemon pair workflow", () => {
  test("interactive decline prints direct guidance and creates no pairing output", async () => {
    const resolveOffer = vi.fn(async () => disabledOffer);
    const confirmRelay = vi.fn(async () => false);
    const printDirectGuidance = vi.fn();
    const output = createRecordedOutput();

    await runPairCommand(
      {},
      { resolveOffer, confirmRelay, printDirectGuidance, isInteractive: () => true, output },
    );

    expect(confirmRelay).toHaveBeenCalledOnce();
    expect(printDirectGuidance).toHaveBeenCalledOnce();
    expect(output.stderr.join("")).toContain("No pairing QR was created");
    expect(output.exitCode).toBe(1);
  });

  test("interactive consent enables relay and prints the refreshed offer", async () => {
    const resolveOffer = vi
      .fn<(options: { paseoHome: string; enableRelay?: boolean }) => Promise<PairingOffer>>()
      .mockResolvedValueOnce(disabledOffer)
      .mockResolvedValueOnce(enabledOffer);
    const output = createRecordedOutput();

    await runPairCommand(
      {},
      {
        resolveOffer,
        confirmRelay: async () => true,
        printDirectGuidance: vi.fn(),
        isInteractive: () => true,
        output,
      },
    );

    expect(resolveOffer).toHaveBeenNthCalledWith(2, expect.objectContaining({ enableRelay: true }));
    expect(output.stdout.join("")).toContain(enabledOffer.url ?? "");
    expect(output.successes).toEqual(["Relay enabled"]);
  });

  test("JSON mode never prompts and returns a structured relay-disabled error", async () => {
    const confirmRelay = vi.fn(async () => true);
    const output = createRecordedOutput();

    await runPairCommand(
      { json: true },
      {
        resolveOffer: async () => disabledOffer,
        confirmRelay,
        printDirectGuidance: vi.fn(),
        isInteractive: () => true,
        output,
      },
    );

    expect(confirmRelay).not.toHaveBeenCalled();
    expect(output.stderr.join("")).toContain('"code":"RELAY_DISABLED"');
    expect(output.exitCode).toBe(1);
  });

  test("explicit relay opts in without prompting", async () => {
    const resolveOffer = vi.fn(async () => enabledOffer);
    const confirmRelay = vi.fn(async () => false);
    const output = createRecordedOutput();

    await runPairCommand(
      { relay: true, json: true },
      {
        resolveOffer,
        confirmRelay,
        printDirectGuidance: vi.fn(),
        isInteractive: () => false,
        output,
      },
    );

    expect(resolveOffer).toHaveBeenCalledWith(expect.objectContaining({ enableRelay: true }));
    expect(confirmRelay).not.toHaveBeenCalled();
    expect(output.exitCode).toBeUndefined();
  });

  test("surfaces launch-override rejection", async () => {
    await expect(
      runPairCommand(
        { relay: true },
        {
          resolveOffer: async () => {
            throw new Error("Relay is controlled by a daemon launch override");
          },
          confirmRelay: vi.fn(),
          printDirectGuidance: vi.fn(),
          isInteractive: () => false,
          output: createRecordedOutput(),
        },
      ),
    ).rejects.toThrow("launch override");
  });
});
