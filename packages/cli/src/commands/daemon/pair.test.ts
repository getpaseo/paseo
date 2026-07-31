import { afterEach, describe, expect, test, vi } from "vitest";

import { runPairCommand, type PairingOffer } from "./pair.js";

const disabledOffer: PairingOffer = { relayEnabled: false, url: null, qr: null };
const enabledOffer: PairingOffer = {
  relayEnabled: true,
  url: "https://app.paseo.sh/#offer=test",
  qr: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("daemon pair workflow", () => {
  test("interactive decline prints direct guidance and creates no pairing output", async () => {
    const resolveOffer = vi.fn(async () => disabledOffer);
    const confirmRelay = vi.fn(async () => false);
    const printDirectGuidance = vi.fn();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runPairCommand(
      {},
      { resolveOffer, confirmRelay, printDirectGuidance, isInteractive: () => true },
    );

    expect(confirmRelay).toHaveBeenCalledOnce();
    expect(printDirectGuidance).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("No pairing QR was created"));
    expect(process.exitCode).toBe(1);
  });

  test("interactive consent enables relay and prints the refreshed offer", async () => {
    const resolveOffer = vi
      .fn<(options: { paseoHome: string; enableRelay?: boolean }) => Promise<PairingOffer>>()
      .mockResolvedValueOnce(disabledOffer)
      .mockResolvedValueOnce(enabledOffer);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runPairCommand(
      {},
      {
        resolveOffer,
        confirmRelay: async () => true,
        printDirectGuidance: vi.fn(),
        isInteractive: () => true,
      },
    );

    expect(resolveOffer).toHaveBeenNthCalledWith(2, expect.objectContaining({ enableRelay: true }));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining(enabledOffer.url ?? ""));
  });

  test("JSON mode never prompts and returns a structured relay-disabled error", async () => {
    const confirmRelay = vi.fn(async () => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runPairCommand(
      { json: true },
      {
        resolveOffer: async () => disabledOffer,
        confirmRelay,
        printDirectGuidance: vi.fn(),
        isInteractive: () => true,
      },
    );

    expect(confirmRelay).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"code":"RELAY_DISABLED"'));
    expect(process.exitCode).toBe(1);
  });

  test("explicit relay opts in without prompting", async () => {
    const resolveOffer = vi.fn(async () => enabledOffer);
    const confirmRelay = vi.fn(async () => false);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runPairCommand(
      { relay: true, json: true },
      { resolveOffer, confirmRelay, printDirectGuidance: vi.fn(), isInteractive: () => false },
    );

    expect(resolveOffer).toHaveBeenCalledWith(expect.objectContaining({ enableRelay: true }));
    expect(confirmRelay).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
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
        },
      ),
    ).rejects.toThrow("launch override");
  });
});
