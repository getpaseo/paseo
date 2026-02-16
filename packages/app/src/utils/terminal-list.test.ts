import { describe, expect, it } from "vitest";

import { upsertTerminalListEntry } from "./terminal-list";

describe("terminal-list", () => {
  it("adds a created terminal when the list is empty", () => {
    const result = upsertTerminalListEntry({
      terminals: [],
      terminal: {
        id: "term-1",
        name: "Terminal 1",
        cwd: "/tmp/project",
      },
    });

    expect(result).toEqual([{ id: "term-1", name: "Terminal 1" }]);
  });

  it("appends a created terminal when the id does not already exist", () => {
    const result = upsertTerminalListEntry({
      terminals: [{ id: "term-1", name: "Terminal 1" }],
      terminal: {
        id: "term-2",
        name: "Terminal 2",
        cwd: "/tmp/project",
      },
    });

    expect(result).toEqual([
      { id: "term-1", name: "Terminal 1" },
      { id: "term-2", name: "Terminal 2" },
    ]);
  });

  it("replaces the existing terminal entry when ids match", () => {
    const result = upsertTerminalListEntry({
      terminals: [
        { id: "term-1", name: "Terminal 1" },
        { id: "term-2", name: "Old Name" },
      ],
      terminal: {
        id: "term-2",
        name: "Renamed Terminal",
        cwd: "/tmp/project",
      },
    });

    expect(result).toEqual([
      { id: "term-1", name: "Terminal 1" },
      { id: "term-2", name: "Renamed Terminal" },
    ]);
  });
});
