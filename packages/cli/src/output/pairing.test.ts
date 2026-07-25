import { describe, expect, it } from "vitest";
import { formatPairingInstructions } from "./pairing.js";

const QR = "\u001b[47m\u001b[30m      \n ████ \n      \u001b[0m";
const URL = "https://app.paseo.sh/#offer=pairing-offer";

describe("formatPairingInstructions", () => {
  it("prints the QR and an unmodified pairing-link line when the terminal is wide enough", () => {
    const output = formatPairingInstructions({ qr: QR, url: URL, columns: 7 });

    expect(output).toContain(QR);
    expect(output.split("\n")).toContain(URL);
  });

  it("does not print a QR that would reach the terminal edge", () => {
    const output = formatPairingInstructions({ qr: QR, url: URL, columns: 6 });

    expect(output).not.toContain(QR);
    expect(output).toContain("Resize the terminal to at least 7 columns");
    expect(output.split("\n")).toContain(URL);
  });

  it("does not risk printing a QR when terminal width is unknown", () => {
    const output = formatPairingInstructions({ qr: QR, url: URL });

    expect(output).not.toContain(QR);
    expect(output).toContain("terminal width could not be detected");
    expect(output.split("\n")).toContain(URL);
  });
});
