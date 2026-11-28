import { describe, expect, test } from "vitest";
import type { TerminalDefaultColors } from "@getpaseo/protocol/messages";
import type { ClientMessage, TerminalSession } from "./terminal.js";
import {
  applyTerminalPalette,
  claimInitialTerminalPaletteOwner,
} from "./terminal-palette-ownership.js";

const LIGHT: TerminalDefaultColors = {
  foreground: "#1a1a1e",
  background: "#ffffff",
  cursor: "#1a1a1e",
};

const DARK: TerminalDefaultColors = {
  foreground: "#fafafa",
  background: "#181b1a",
  cursor: "#fafafa",
};

const ALT_DARK: TerminalDefaultColors = {
  foreground: "#fafafa",
  background: "#161820",
  cursor: "#fafafa",
};

function createTerminal(initialColors?: TerminalDefaultColors): {
  terminal: TerminalSession;
  appliedPalettes: TerminalDefaultColors[];
} {
  const appliedPalettes: TerminalDefaultColors[] = [];
  let defaultColors: TerminalDefaultColors | undefined = initialColors;
  const terminal = {
    getDefaultColors: () => defaultColors,
    send: (message: ClientMessage) => {
      if (message.type !== "palette") {
        return;
      }
      defaultColors = message.defaultColors;
      appliedPalettes.push(message.defaultColors);
    },
  } as TerminalSession;
  return { terminal, appliedPalettes };
}

describe("terminal palette ownership", () => {
  test("only the latest claimant can update a terminal palette", () => {
    const { terminal, appliedPalettes } = createTerminal();
    const ownerA = {};
    const ownerB = {};

    expect(applyTerminalPalette(terminal, ownerA, { defaultColors: LIGHT, intent: "claim" })).toBe(
      true,
    );
    expect(applyTerminalPalette(terminal, ownerA, { defaultColors: DARK, intent: "update" })).toBe(
      true,
    );
    expect(applyTerminalPalette(terminal, ownerB, { defaultColors: LIGHT, intent: "update" })).toBe(
      false,
    );
    expect(applyTerminalPalette(terminal, ownerB, { defaultColors: LIGHT, intent: "claim" })).toBe(
      true,
    );
    expect(
      applyTerminalPalette(terminal, ownerA, { defaultColors: ALT_DARK, intent: "update" }),
    ).toBe(false);
    expect(applyTerminalPalette(terminal, ownerB, { defaultColors: DARK, intent: "update" })).toBe(
      true,
    );

    expect(appliedPalettes).toEqual([LIGHT, DARK, LIGHT, DARK]);
  });

  test("transfers ownership even when a new claimant reports the active palette", () => {
    const { terminal, appliedPalettes } = createTerminal(LIGHT);
    const ownerA = {};
    const ownerB = {};

    claimInitialTerminalPaletteOwner(terminal, ownerA);
    expect(applyTerminalPalette(terminal, ownerB, { defaultColors: LIGHT, intent: "claim" })).toBe(
      true,
    );
    expect(applyTerminalPalette(terminal, ownerA, { defaultColors: DARK, intent: "update" })).toBe(
      false,
    );
    expect(applyTerminalPalette(terminal, ownerB, { defaultColors: DARK, intent: "update" })).toBe(
      true,
    );

    expect(appliedPalettes).toEqual([DARK]);
  });

  test("grants initial owner update rights without waiting for a separate claim", () => {
    const { terminal, appliedPalettes } = createTerminal(LIGHT);
    const creator = {};

    claimInitialTerminalPaletteOwner(terminal, creator);
    expect(applyTerminalPalette(terminal, creator, { defaultColors: DARK, intent: "update" })).toBe(
      true,
    );
    expect(appliedPalettes).toEqual([DARK]);
  });
});
