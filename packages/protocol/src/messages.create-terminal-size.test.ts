import { describe, expect, it } from "vitest";
import { CreateTerminalRequestSchema } from "./messages";

// The optional size field stays accepted permanently: released v0.1.107 clients send it, newer
// app clients don't, and programmatic callers may. These tests pin that contract.
describe("CreateTerminalRequest size", () => {
  const base = {
    type: "create_terminal_request" as const,
    cwd: "/work/repo",
    requestId: "req-1",
  };

  it("parses a request without a size (old client / back-compat)", () => {
    const parsed = CreateTerminalRequestSchema.parse({ ...base });
    expect(parsed).toEqual(base);
  });

  it("parses a request carrying a viewport size", () => {
    const parsed = CreateTerminalRequestSchema.parse({ ...base, size: { rows: 55, cols: 136 } });
    expect(parsed.size).toEqual({ rows: 55, cols: 136 });
  });

  it("rejects a non-positive or non-integer size", () => {
    expect(() =>
      CreateTerminalRequestSchema.parse({ ...base, size: { rows: 0, cols: 80 } }),
    ).toThrow();
    expect(() =>
      CreateTerminalRequestSchema.parse({ ...base, size: { rows: 24, cols: -1 } }),
    ).toThrow();
    expect(() =>
      CreateTerminalRequestSchema.parse({ ...base, size: { rows: 24.5, cols: 80 } }),
    ).toThrow();
  });
});
