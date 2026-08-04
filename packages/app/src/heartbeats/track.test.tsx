/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import type { AgentHeartbeatRow } from "./select";
import { HeartbeatsTrack } from "./track";

// jsdom has no matchMedia; reanimated reads it at import time to check for
// reduced motion, and the tooltip on a track row's actions pulls it in.
vi.hoisted(() => {
  if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    window.matchMedia = () =>
      ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }) as unknown as MediaQueryList;
  }
});

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6, lg: 8, "2xl": 16 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    iconSize: { sm: 14, md: 16 },
    opacity: { 50: 0.5 },
    shadow: { md: {} },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      border: "#444",
      borderAccent: "#555",
      destructive: "#f00",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme, rt: { breakpoint: "lg" } }),
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({
      uniProps,
      ...rest
    }: { uniProps?: (theme: unknown) => Record<string, unknown> } & Record<string, unknown>) =>
      React.createElement(Component, { ...rest, ...(uniProps ? uniProps(theme) : {}) }),
}));

vi.stubGlobal("React", React);

function makeRow(overrides: Partial<AgentHeartbeatRow> = {}): AgentHeartbeatRow {
  return {
    key: "host-1:schedule-1",
    serverId: "host-1",
    scheduleId: "schedule-1",
    title: "Watch the build",
    cadence: "Every 15 minutes",
    ...overrides,
  };
}

function renderTrack(track: React.ComponentProps<typeof HeartbeatsTrack>["track"]) {
  const handlers = {
    onOpenHeartbeat: vi.fn(),
    onDeleteHeartbeat: vi.fn(),
    onUpdateHost: vi.fn(),
  };
  render(<HeartbeatsTrack track={track} {...handlers} />);
  return handlers;
}

describe("HeartbeatsTrack", () => {
  // The copy assertions below are the English strings.
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(cleanup);

  it("lists the heartbeats and opens one when its row is pressed", () => {
    const handlers = renderTrack({ kind: "heartbeats", rows: [makeRow()] });

    fireEvent.click(screen.getByTestId("heartbeats-track-header"));
    expect(screen.getByText("Watch the build")).toBeTruthy();
    expect(screen.getByText("Every 15 minutes")).toBeTruthy();

    fireEvent.click(screen.getByTestId("heartbeats-track-row-host-1:schedule-1"));
    expect(handlers.onOpenHeartbeat).toHaveBeenCalledWith(makeRow());
  });

  it("asks for a host update instead of listing heartbeats whose activity the host hides", () => {
    const handlers = renderTrack({ kind: "host-update-required" });

    expect(screen.queryByTestId("heartbeats-track")).toBeNull();
    expect(screen.queryByText("Watch the build")).toBeNull();

    const updateRow = screen.getByTestId("heartbeats-track-host-update");
    expect(updateRow.textContent).toContain("Update the host to show heartbeat activity");

    fireEvent.click(updateRow);
    expect(handlers.onUpdateHost).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenHeartbeat).not.toHaveBeenCalled();
  });
});
