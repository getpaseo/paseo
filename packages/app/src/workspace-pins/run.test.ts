import { describe, expect, it } from "vitest";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import type { TerminalProfileInput } from "@/screens/workspace/terminals/use-workspace-terminals";
import { runPinnedTabTarget, type TabTargetHandlers } from "./run";

const PROFILES: readonly TerminalProfile[] = [
  { id: "claude", name: "Claude Code", command: "claude" },
];

interface RecordedLaunch {
  action: "draft" | "terminal" | "browser" | "profile";
  profile?: TerminalProfileInput;
}

function recordingHandlers() {
  const launches: RecordedLaunch[] = [];
  const handlers: TabTargetHandlers = {
    createDraft: () => launches.push({ action: "draft" }),
    createTerminal: () => launches.push({ action: "terminal" }),
    createBrowser: () => launches.push({ action: "browser" }),
    createTerminalWithProfile: (profile) => launches.push({ action: "profile", profile }),
  };
  return { launches, handlers };
}

describe("runPinnedTabTarget", () => {
  it("creates a draft agent for the draft target", () => {
    const { launches, handlers } = recordingHandlers();
    runPinnedTabTarget({ kind: "draft" }, PROFILES, handlers);
    expect(launches).toEqual([{ action: "draft" }]);
  });

  it("creates a terminal for the terminal target", () => {
    const { launches, handlers } = recordingHandlers();
    runPinnedTabTarget({ kind: "terminal" }, PROFILES, handlers);
    expect(launches).toEqual([{ action: "terminal" }]);
  });

  it("creates a browser for the browser target", () => {
    const { launches, handlers } = recordingHandlers();
    runPinnedTabTarget({ kind: "browser" }, PROFILES, handlers);
    expect(launches).toEqual([{ action: "browser" }]);
  });

  it("launches the resolved profile command for a known profile target", () => {
    const { launches, handlers } = recordingHandlers();
    runPinnedTabTarget({ kind: "profile", profileId: "claude" }, PROFILES, handlers);
    expect(launches).toEqual([
      { action: "profile", profile: { name: "Claude Code", command: "claude" } },
    ]);
  });

  it("does nothing when the profile id is absent from the host", () => {
    const { launches, handlers } = recordingHandlers();
    runPinnedTabTarget({ kind: "profile", profileId: "missing" }, PROFILES, handlers);
    expect(launches).toEqual([]);
  });
});
