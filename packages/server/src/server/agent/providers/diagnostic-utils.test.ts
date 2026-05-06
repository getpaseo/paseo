import { describe, expect, test } from "vitest";

import { toDiagnosticErrorMessage } from "./diagnostic-utils.js";

describe("toDiagnosticErrorMessage", () => {
  test("returns message for plain Error", () => {
    expect(toDiagnosticErrorMessage(new Error("boom"))).toBe("boom");
  });

  test("includes stderr, stdout, code, and signal from execFile-style Error", () => {
    const error = new Error("Command failed: opencode --version") as Error & {
      stderr: string;
      stdout: string;
      code: number;
      signal: string;
    };
    error.stderr = "permission denied\n";
    error.stdout = "partial output";
    error.code = 127;
    error.signal = "SIGTERM";

    const message = toDiagnosticErrorMessage(error);
    expect(message).toContain("Command failed: opencode --version");
    expect(message).toContain("exit code: 127");
    expect(message).toContain("signal: SIGTERM");
    expect(message).toContain("stderr: permission denied");
    expect(message).toContain("stdout: partial output");
  });

  test("preserves multi-line stderr on a real Error", () => {
    const error = new Error("Command failed") as Error & { stderr: string };
    error.stderr = "line one\nline two\nline three";
    const message = toDiagnosticErrorMessage(error);
    expect(message).toContain("stderr: line one\nline two\nline three");
  });

  test("recursively formats Error cause", () => {
    const inner = new Error("inner failure") as Error & { stderr: string };
    inner.stderr = "inner stderr";
    const outer = new Error("outer failure", { cause: inner });
    const message = toDiagnosticErrorMessage(outer);
    expect(message).toContain("outer failure");
    expect(message).toContain("caused by: inner failure");
    expect(message).toContain("stderr: inner stderr");
  });

  test("serializes plain objects rather than returning {}", () => {
    expect(toDiagnosticErrorMessage({ foo: "bar" })).toBe('{"foo":"bar"}');
  });

  test("returns trimmed string when given a string", () => {
    expect(toDiagnosticErrorMessage("oops")).toBe("oops");
    expect(toDiagnosticErrorMessage("  spaced  ")).toBe("spaced");
  });

  test("returns Unknown error for null and undefined", () => {
    expect(toDiagnosticErrorMessage(null)).toBe("Unknown error");
    expect(toDiagnosticErrorMessage(undefined)).toBe("Unknown error");
  });

  test("returns Unknown error for an Error with no message and no extras", () => {
    const error = new Error("");
    expect(toDiagnosticErrorMessage(error)).toBe("Unknown error");
  });

  test("truncates very long stderr", () => {
    const long = "x".repeat(5000);
    const error = new Error("big") as Error & { stderr: string };
    error.stderr = long;
    const message = toDiagnosticErrorMessage(error);
    expect(message).toContain("…(truncated)");
    expect(message.length).toBeLessThan(long.length + 200);
  });

  test("returns Unknown error for empty plain object after serialization fallback", () => {
    expect(toDiagnosticErrorMessage({})).toBe("Unknown error");
  });
});
