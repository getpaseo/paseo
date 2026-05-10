import { describe, expect, it } from "vitest";
import {
  collectKnownTerminalIds,
  collectScriptTerminalIds,
  collectStandaloneTerminalIds,
  reconcilePendingScriptTerminals,
  removeTerminalFromPayload,
  upsertCreatedTerminalPayload,
  type ListTerminalsPayload,
} from "@/screens/workspace/terminals/state";
import type { CreateTerminalResponse } from "@server/shared/messages";

function listedTerminal(id: string): ListTerminalsPayload["terminals"][number] {
  return { id, name: id, title: id };
}

function createdTerminal(id: string): NonNullable<CreateTerminalResponse["payload"]["terminal"]> {
  return { id, name: id, cwd: "/repo", title: id };
}

describe("workspace terminal state", () => {
  it("keeps pending script terminals until they appear or a fresher list arrives", () => {
    const pending = new Map([
      ["older-than-list", 10],
      ["now-live", 20],
      ["still-pending", 30],
    ]);

    const reconciled = reconcilePendingScriptTerminals(["now-live"], 20)(pending);

    expect(reconciled).toEqual(new Map([["still-pending", 30]]));
  });

  it("returns the same pending map when reconciliation changes nothing", () => {
    const pending = new Map([["still-pending", 30]]);

    const reconciled = reconcilePendingScriptTerminals([], 20)(pending);

    expect(reconciled).toBe(pending);
  });

  it("combines live and pending terminal ids without duplicating script terminals", () => {
    const pendingScriptTerminalIds = new Map([
      ["script-pending", 10],
      ["terminal-1", 10],
    ]);

    expect(
      collectKnownTerminalIds({
        liveTerminalIds: ["terminal-1", "terminal-2"],
        pendingScriptTerminalIds,
      }),
    ).toEqual(["terminal-1", "terminal-2", "script-pending"]);
    expect(
      collectScriptTerminalIds({
        pendingScriptTerminalIds,
        scripts: [{ terminalId: "script-live" }, { terminalId: null }],
      }),
    ).toEqual(new Set(["script-pending", "terminal-1", "script-live"]));
    expect(
      collectStandaloneTerminalIds({
        terminals: [
          listedTerminal("terminal-1"),
          listedTerminal("terminal-2"),
          listedTerminal("script-live"),
        ],
        scriptTerminalIds: new Set(["terminal-1", "script-live"]),
      }),
    ).toEqual(["terminal-2"]);
  });

  it("updates terminal cache entries for created and closed terminals", () => {
    const current: ListTerminalsPayload = {
      cwd: "/repo",
      requestId: "existing",
      terminals: [listedTerminal("terminal-1")],
    };

    expect(
      upsertCreatedTerminalPayload({
        current,
        terminal: createdTerminal("terminal-2"),
        workspaceDirectory: "/repo",
      }),
    ).toEqual({
      cwd: "/repo",
      requestId: "existing",
      terminals: [
        listedTerminal("terminal-1"),
        { id: "terminal-2", name: "terminal-2", title: "terminal-2" },
      ],
    });
    expect(removeTerminalFromPayload("terminal-1")(current)).toEqual({
      cwd: "/repo",
      requestId: "existing",
      terminals: [],
    });
  });
});
