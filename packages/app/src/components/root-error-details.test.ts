import { describe, expect, it } from "vitest";
import { formatCaughtValue } from "./root-error-details";

describe("formatCaughtValue", () => {
  it("preserves details for Error values", () => {
    class RouteRenderError extends Error {
      code = "E_ROUTE_RENDER";
      cause = "workspace route";

      constructor() {
        super("route render exploded");
        this.name = "RouteRenderError";
        this.stack = "RouteRenderError: route render exploded\n    at WorkspaceRoute";
      }
    }

    const details = formatCaughtValue(new RouteRenderError());

    expect(details).toContain("Name: RouteRenderError");
    expect(details).toContain("Message: route render exploded");
    expect(details).toContain("Stack:");
    expect(details).toContain("RouteRenderError: route render exploded");
    expect(details).toContain("Cause:");
    expect(details).toContain("workspace route");
    expect(details).toContain("E_ROUTE_RENDER");
  });

  it("does not duplicate aggregate errors as custom fields", () => {
    const error = new AggregateError([new Error("first failure")], "multiple failures");
    const details = formatCaughtValue(error);

    expect(details).toContain("Errors:");
    expect(details).toContain("first failure");
    expect(details).not.toContain("Fields:");
  });

  it("preserves null aggregate error values", () => {
    class ErrorWithNullableErrors extends Error {
      errors = null;
    }

    const details = formatCaughtValue(new ErrorWithNullableErrors("nullable errors"));

    expect(details).toContain("Errors:\nnull");
    expect(details).not.toContain("Fields:");
  });

  it("does not throw for malformed Error text fields", () => {
    const error = new Error("fallback");
    Object.defineProperties(error, {
      name: { configurable: true, value: null },
      message: { configurable: true, value: 42 },
      stack: { configurable: true, value: { frame: "bad stack" } },
    });

    const details = formatCaughtValue(error);

    expect(details).toContain("Name: null");
    expect(details).toContain("Message: 42");
    expect(details).toContain('"frame": "bad stack"');
  });

  it("marks recursive Error causes", () => {
    const error = new Error("self cause");
    Object.defineProperty(error, "cause", { configurable: true, value: error });

    const details = formatCaughtValue(error);

    expect(details).toContain("Cause:\n[Circular Error]");
  });

  it("returns fallback details when Error properties throw", () => {
    const error = new Error("fallback");
    Object.defineProperty(error, "message", {
      configurable: true,
      get() {
        throw new Error("bad message getter");
      },
    });

    const details = formatCaughtValue(error);

    expect(details).toContain("[Unserializable value]");
    expect(details).toContain("Details unavailable:");
    expect(details).toContain("Error: bad message getter");
  });

  it("renders string thrown values as the string", () => {
    expect(formatCaughtValue("plain failure")).toBe("plain failure");
  });

  it("preserves empty string thrown values", () => {
    expect(formatCaughtValue("")).toBe("");
  });

  it("renders numeric thrown values without extra category text", () => {
    const details = formatCaughtValue(42);

    expect(details).toBe("42");
    expect(details).not.toContain("non-Error");
  });

  it("renders circular objects as JSON with circular markers", () => {
    const value: { label: string; self?: unknown } = { label: "loop" };
    value.self = value;

    expect(formatCaughtValue(value)).toBe('{\n  "label": "loop",\n  "self": "[Circular]"\n}');
  });
});
