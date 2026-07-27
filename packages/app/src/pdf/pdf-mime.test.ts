import { describe, expect, it } from "vitest";
import { hasPdfExtension, isPdfFile } from "./pdf-mime";

describe("isPdfFile", () => {
  it("detects the pdf mime, including a parameterized one", () => {
    expect(isPdfFile({ mimeType: "application/pdf" })).toBe(true);
    expect(isPdfFile({ mimeType: "APPLICATION/PDF" })).toBe(true);
    expect(isPdfFile({ mimeType: " application/pdf ; charset=binary" })).toBe(true);
  });

  it("does not claim other binaries or a missing mime", () => {
    expect(isPdfFile({ mimeType: "application/octet-stream" })).toBe(false);
    expect(isPdfFile({ mimeType: "text/plain" })).toBe(false);
    expect(isPdfFile({})).toBe(false);
    expect(isPdfFile(null)).toBe(false);
    expect(isPdfFile(undefined)).toBe(false);
  });
});

describe("hasPdfExtension", () => {
  it("detects .pdf paths regardless of case", () => {
    expect(hasPdfExtension("docs/report.pdf")).toBe(true);
    expect(hasPdfExtension("REPORT.PDF")).toBe(true);
  });

  it("does not match other paths", () => {
    expect(hasPdfExtension("report.pdf.txt")).toBe(false);
    expect(hasPdfExtension("src/index.ts")).toBe(false);
  });
});
