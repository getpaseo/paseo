import { describe, expect, it } from "vitest";
import * as QRCode from "qrcode";
import { renderPairingQr } from "./pairing-qr.js";

const ESCAPE = String.fromCharCode(0x1b);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");

describe("renderPairingQr", () => {
  it("renders a theme-independent QR code with a four-module quiet zone", async () => {
    const url = "https://app.paseo.sh/#offer=test-pairing-offer";
    const qr = await renderPairingQr(url);
    const styledLines = qr.split("\n");
    const visibleLines = qr.replace(ANSI_PATTERN, "").split("\n");
    const moduleCount = QRCode.create(url).modules.size;

    expect(
      styledLines.every(
        (line) => line.startsWith(`${ESCAPE}[47m${ESCAPE}[30m`) && line.endsWith(`${ESCAPE}[0m`),
      ),
    ).toBe(true);
    expect(visibleLines.every((line) => line.length === moduleCount + 8)).toBe(true);
    expect(visibleLines.slice(0, 2).every((line) => line.trim() === "")).toBe(true);
    expect(visibleLines.slice(-2).every((line) => line.trim() === "")).toBe(true);
    expect(visibleLines.every((line) => line.startsWith("    ") && line.endsWith("    "))).toBe(
      true,
    );
  });
});
