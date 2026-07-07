/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Text } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootErrorBoundary } from "./root-error-boundary";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 2: 8, 4: 16, 6: 24, 8: 32 },
    borderRadius: { md: 6, lg: 8 },
    fontSize: { xs: 11, sm: 13, base: 15, xl: 22 },
    fontWeight: { semibold: "600" },
    colors: {
      accent: "#20744A",
      accentForeground: "#fff",
      borderAccent: "#333",
      destructive: "#dc2626",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface0: "#000",
      surface1: "#111",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RootErrorBoundary", () => {
  it("renders full details for Error values and can retry", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let shouldThrow = true;

    class RouteRenderError extends Error {
      code = "E_ROUTE_RENDER";
      cause = "workspace route";

      constructor() {
        super("route render exploded");
        this.name = "RouteRenderError";
        this.stack = "RouteRenderError: route render exploded\n    at WorkspaceRoute";
      }
    }

    function ThrowOnce() {
      if (shouldThrow) {
        throw new RouteRenderError();
      }
      return <Text>Recovered app</Text>;
    }

    render(
      <RootErrorBoundary>
        <ThrowOnce />
      </RootErrorBoundary>,
    );

    expect(screen.getByTestId("root-error-boundary").textContent).toContain(
      "Paseo ran into a problem.",
    );
    const details = screen.getByTestId("root-error-boundary").textContent ?? "";
    expect(details).toContain("Name: RouteRenderError");
    expect(details).toContain("Message: route render exploded");
    expect(details).toContain("Stack:");
    expect(details).toContain("RouteRenderError: route render exploded");
    expect(details).toContain("Cause:");
    expect(details).toContain("workspace route");
    expect(details).toContain("E_ROUTE_RENDER");
    expect(consoleError).toHaveBeenCalledWith(
      "[RootErrorBoundary] Unhandled render error",
      expect.objectContaining({ error: expect.stringContaining("route render exploded") }),
    );

    shouldThrow = false;
    fireEvent.click(screen.getByTestId("root-error-boundary-retry"));

    expect(screen.getByText("Recovered app")).toBeTruthy();
  });

  it("renders non-Error thrown values", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    function ThrowString(): React.ReactNode {
      throw "plain failure";
    }

    render(
      <RootErrorBoundary>
        <ThrowString />
      </RootErrorBoundary>,
    );

    expect(screen.getByTestId("root-error-boundary").textContent).toContain("plain failure");
  });

  it("renders numeric thrown values without extra category text", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    function ThrowNumber(): React.ReactNode {
      throw 42;
    }

    render(
      <RootErrorBoundary>
        <ThrowNumber />
      </RootErrorBoundary>,
    );

    const details = screen.getByTestId("root-error-boundary").textContent ?? "";
    expect(details).toContain("42");
    expect(details).not.toContain("non-Error");
  });
});
