import { describe, expect, it } from "vitest";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import type { TerminalProfileInput } from "@/screens/workspace/terminals/use-workspace-terminals";
import { runPinnedTabTarget, type TabTargetHandlers } from "./run";

const PROFILES: readonly TerminalProfile[] = [
  { id: "claude", name: "Claude Code", command: "claude" },
];

interface RecordedLaunch {
  action: "draft" | "terminal" | "browser" | "codeServer" | "profile";
  profile?: TerminalProfileInput;
}

function recordingHandlers() {
  const launches: RecordedLaunch[] = [];
  const handlers: TabTargetHandlers = {
    createDraft: () => launches.push({ action: "draft" }),
    createTerminal: () => launches.push({ action: "terminal" }),
    createBrowser: () => launches.push({ action: "browser" }),
    createCodeServer: () => launches.push({ action: "codeServer" }),
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

  it("creates a code server for the code server target", () => {
    const { launches, handlers } = recordingHandlers();
    runPinnedTabTarget({ kind: "codeServer" }, PROFILES, handlers);
    expect(launches).toEqual([{ action: "codeServer" }]);
  });

  it("launches the resolved profile command for a known profile target", () => {
    const { launches, handlers } = recordingHandlers();
    runPinnedTabTarget({ kind: "profile", profileId: "claude" }, PROFILES, handlers);
    expect(launches).toEqual([
      { action: "profile", profile: { name: "Claude Code", command: "claude", args: [] } },
    ]);
  });

  it("launches a prompt-taking profile bare, never with the sentinel as a literal argument", () => {
    const { launches, handlers } = recordingHandlers();
    runPinnedTabTarget(
      { kind: "profile", profileId: "codex" },
      [{ id: "codex", name: "Codex", command: "codex", args: ["--yolo", "{{{prompt}}}"] }],
      handlers,
    );
    // A pin has nowhere to type, so the prompt-only arg drops instead of
    // reaching the CLI as the literal text `{{{prompt}}}`.
    expect(launches).toEqual([
      { action: "profile", profile: { name: "Codex", command: "codex", args: ["--yolo"] } },
    ]);
  });

  it("does nothing when the profile id is absent from the host", () => {
    const { launches, handlers } = recordingHandlers();
    runPinnedTabTarget({ kind: "profile", profileId: "missing" }, PROFILES, handlers);
    expect(launches).toEqual([]);
  });
});
