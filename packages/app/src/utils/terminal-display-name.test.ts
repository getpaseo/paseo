import { describe, expect, it } from "vitest";

import { localizeDefaultTerminalName } from "./terminal-display-name";

describe("localizeDefaultTerminalName", () => {
  it("localizes daemon-generated default terminal names", () => {
    expect(localizeDefaultTerminalName("Terminal 1", "终端")).toBe("终端 1");
    expect(localizeDefaultTerminalName("Terminal 27", "终端")).toBe("终端 27");
  });

  it("preserves custom terminal names", () => {
    expect(localizeDefaultTerminalName("Dev Server", "终端")).toBe("Dev Server");
  });
});
