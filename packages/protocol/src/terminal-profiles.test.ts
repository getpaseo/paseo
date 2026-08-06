import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_PROFILES,
  PROMPT_SENTINEL,
  formatResolvedCommand,
  getTerminalProfileIcon,
  guessTerminalProfileIcon,
  profileTakesPrompt,
  resolveTerminalProfiles,
  substitutePrompt,
} from "./terminal-profiles.js";

describe("resolveTerminalProfiles", () => {
  it("returns defaults when undefined", () => {
    const result = resolveTerminalProfiles(undefined);
    expect(result).toBe(DEFAULT_TERMINAL_PROFILES);
  });

  it("returns an empty array as-is when defined as empty", () => {
    const result = resolveTerminalProfiles([]);
    expect(result).toEqual([]);
  });

  // A profile that predates the sentinel got materialized into user config the
  // first time anyone touched the profile list, so it would otherwise be stuck
  // launch-only while a fresh install gets prompt support.
  it("appends the sentinel to a bare shipped default", () => {
    const persisted = [{ id: "claude", name: "Claude Code", command: "claude", icon: "claude" }];
    const result = resolveTerminalProfiles(persisted);
    expect(result[0]).toEqual({
      id: "claude",
      name: "Claude Code",
      command: "claude",
      icon: "claude",
      args: [PROMPT_SENTINEL],
    });
  });

  // Profiles created through the settings UI get generated ids, so keying the
  // adoption on the id would never match a real user's config.
  it("appends the sentinel for a generated id, keying on the command instead", () => {
    const persisted = [
      { id: "profile_1739308800000_a1b2c3", name: "Codex", command: "codex", args: ["--yolo"] },
    ];
    const result = resolveTerminalProfiles(persisted);
    expect(result[0]?.args).toEqual(["--yolo", PROMPT_SENTINEL]);
  });

  it("appends the sentinel after the user's own args, preserving them", () => {
    const persisted = [{ id: "codex", name: "Codex", command: "codex", args: ["--yolo"] }];
    const result = resolveTerminalProfiles(persisted);
    expect(result[0]?.args).toEqual(["--yolo", PROMPT_SENTINEL]);
  });

  it("appends the sentinel for an absolute path to a known agent", () => {
    const persisted = [
      { id: "profile_1739308800001_d4e5f6", name: "Codex", command: "/usr/local/bin/codex" },
    ];
    const result = resolveTerminalProfiles(persisted);
    expect(result[0]?.args).toEqual([PROMPT_SENTINEL]);
  });

  it("appends the sentinel for a Windows-shaped command with an extension", () => {
    const persisted = [
      {
        id: "profile_1739308800002_g7h8i9",
        name: "Claude Code",
        command: "C:\\Program Files\\nodejs\\claude.cmd",
      },
    ];
    const result = resolveTerminalProfiles(persisted);
    expect(result[0]?.args).toEqual([PROMPT_SENTINEL]);
  });

  it("does not append when the profile already carries a sentinel", () => {
    const persisted = [
      { id: "codex", name: "Codex", command: "codex", args: [PROMPT_SENTINEL, "--yolo"] },
    ];
    const result = resolveTerminalProfiles(persisted);
    expect(result[0]).toBe(persisted[0]);
  });

  it("leaves a command that is not a known agent untouched, whatever its id", () => {
    const persisted = [
      { id: "zsh-custom", name: "Zsh", command: "zsh" },
      { id: "claude", name: "Gemini", command: "gemini" },
    ];
    const result = resolveTerminalProfiles(persisted);
    expect(result[0]).toBe(persisted[0]);
    expect(result[1]).toBe(persisted[1]);
  });

  it("migrates only the matching entries in a mixed list, preserving the rest by reference", () => {
    const otherAgent = { id: "profile_1739308800003_j1k2l3", name: "Gemini", command: "gemini" };
    const persisted = [{ id: "claude", name: "Claude Code", command: "claude" }, otherAgent];
    const result = resolveTerminalProfiles(persisted);
    expect(result[0]?.args).toEqual([PROMPT_SENTINEL]);
    expect(result[1]).toBe(otherAgent);
  });

  it("default profiles include claude, codex, opencode", () => {
    const ids = DEFAULT_TERMINAL_PROFILES.map((p) => p.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("opencode");
  });

  it("claude profile has the correct icon", () => {
    const claude = DEFAULT_TERMINAL_PROFILES.find((p) => p.id === "claude");
    expect(claude?.icon).toBe("claude");
  });

  it("every default profile takes a prompt, and drops the arg entirely without one", () => {
    for (const profile of DEFAULT_TERMINAL_PROFILES) {
      expect(profileTakesPrompt(profile)).toBe(true);
      // No prompt has to mean no argv entry at all: a bare positional would be
      // an empty argument, and a bare `--prompt=` is not the same as omitting it.
      expect(substitutePrompt(profile, "")).toEqual({ command: profile.command, args: [] });
    }
  });

  it("ships the prompt form each CLI actually accepts", () => {
    const byId = new Map(DEFAULT_TERMINAL_PROFILES.map((profile) => [profile.id, profile]));
    // claude, codex, and pi take the prompt as a trailing positional.
    for (const id of ["claude", "codex", "pi"]) {
      expect(byId.get(id)?.args).toEqual(["{{{prompt}}}"]);
    }
    // opencode's positional is the project directory, so the prompt is a flag.
    expect(byId.get("opencode")?.args).toEqual(["--prompt={{{prompt}}}"]);
  });

  it("adopts the right prompt form per command, not a blanket trailing positional", () => {
    const [adoptedOpencode] = resolveTerminalProfiles([
      { id: "profile_generated", name: "OpenCode", command: "opencode" },
    ]);
    expect(adoptedOpencode?.args).toEqual(["--prompt={{{prompt}}}"]);

    const [adoptedPi] = resolveTerminalProfiles([
      { id: "profile_generated", name: "Pi", command: "pi", args: ["--thinking", "high"] },
    ]);
    expect(adoptedPi?.args).toEqual(["--thinking", "high", "{{{prompt}}}"]);
  });

  it("codex profile has the correct icon", () => {
    const codex = DEFAULT_TERMINAL_PROFILES.find((p) => p.id === "codex");
    expect(codex?.icon).toBe("codex");
  });

  it("opencode profile has the correct icon", () => {
    const opencode = DEFAULT_TERMINAL_PROFILES.find((p) => p.id === "opencode");
    expect(opencode?.icon).toBe("opencode");
  });
});

describe("guessTerminalProfileIcon", () => {
  it.each([
    ["claude", "claude"],
    ["codex", "codex"],
    ["opencode", "opencode"],
    ["copilot", "copilot"],
    ["kiro", "kiro"],
    ["omp", "omp"],
    ["pi", "pi"],
    ["gemini", "gemini"],
    ["cursor", "cursor"],
    ["goose", "goose"],
    ["grok", "grok"],
    ["kimi", "kimi"],
    ["Claude", "claude"],
    ["CODEX", "codex"],
    ["/usr/local/bin/claude", "claude"],
    ["C:\\\\Program Files\\\\Codex\\\\codex.exe", "codex"],
    ["/usr/local/bin/gemini", "gemini"],
    ["agy", "agy"],
    ["/usr/local/bin/agy", "agy"],
  ])("guesses %s -> %s", (command, expected) => {
    expect(guessTerminalProfileIcon(command)).toBe(expected);
  });

  it.each([["zsh"], ["bash"], ["fish"], [""], ["/usr/bin/foo"], ["cursor-agent"]])(
    "returns undefined for unknown command %s",
    (command) => {
      expect(guessTerminalProfileIcon(command)).toBeUndefined();
    },
  );
});

describe("getTerminalProfileIcon", () => {
  it("returns the explicit icon when set", () => {
    const profile = { id: "1", name: "Foo", command: "zsh", icon: "claude" };
    expect(getTerminalProfileIcon(profile)).toBe("claude");
  });

  it("guesses the icon when none is set", () => {
    const profile = { id: "1", name: "Foo", command: "claude" };
    expect(getTerminalProfileIcon(profile)).toBe("claude");
  });

  it("returns undefined when no icon is set and command is unknown", () => {
    const profile = { id: "1", name: "Foo", command: "zsh" };
    expect(getTerminalProfileIcon(profile)).toBeUndefined();
  });
});

describe("profileTakesPrompt", () => {
  it("is true when the sentinel is a standalone arg", () => {
    expect(profileTakesPrompt({ command: "claude", args: [PROMPT_SENTINEL] })).toBe(true);
  });

  it("is true when the sentinel is embedded inside a larger arg", () => {
    expect(profileTakesPrompt({ command: "sh", args: ["-c", `echo ${PROMPT_SENTINEL}`] })).toBe(
      true,
    );
  });

  it("is true when the sentinel is in the command", () => {
    expect(profileTakesPrompt({ command: `run ${PROMPT_SENTINEL}` })).toBe(true);
  });

  it("is false with no sentinel anywhere, including with args omitted", () => {
    expect(profileTakesPrompt({ command: "claude", args: ["--continue"] })).toBe(false);
    expect(profileTakesPrompt({ command: "zsh" })).toBe(false);
  });
});

describe("substitutePrompt", () => {
  it("replaces a standalone sentinel arg with the prompt", () => {
    expect(substitutePrompt({ command: "claude", args: [PROMPT_SENTINEL] }, "fix the bug")).toEqual(
      { command: "claude", args: ["fix the bug"] },
    );
  });

  it("drops a sentinel-only arg when the prompt is empty, so a bare command still launches", () => {
    expect(substitutePrompt({ command: "claude", args: [PROMPT_SENTINEL] }, "")).toEqual({
      command: "claude",
      args: [],
    });
  });

  it("substitutes into an embedded sentinel rather than dropping the arg, even when empty", () => {
    expect(
      substitutePrompt({ command: "sh", args: ["-c", `echo ${PROMPT_SENTINEL}`] }, ""),
    ).toEqual({ command: "sh", args: ["-c", "echo "] });
  });

  it("replaces every occurrence, in the command and in the args", () => {
    expect(
      substitutePrompt(
        { command: `${PROMPT_SENTINEL}-run`, args: [`${PROMPT_SENTINEL}/${PROMPT_SENTINEL}`] },
        "x",
      ),
    ).toEqual({ command: "x-run", args: ["x/x"] });
  });

  it("passes the prompt through verbatim, with no quoting or escaping", () => {
    expect(
      substitutePrompt({ command: "sh", args: [PROMPT_SENTINEL] }, 'a "quoted" $var; rm -rf'),
    ).toEqual({ command: "sh", args: ['a "quoted" $var; rm -rf'] });
  });

  it("normalizes absent args to an empty list", () => {
    expect(substitutePrompt({ command: "zsh" }, "ignored")).toEqual({ command: "zsh", args: [] });
  });
});

describe("formatResolvedCommand", () => {
  it("joins the command and its args with spaces", () => {
    expect(formatResolvedCommand({ command: "/bin/sh", args: ["-c", "echo hi"] })).toBe(
      "/bin/sh -c echo hi",
    );
  });

  it("is just the command when there are no args", () => {
    expect(formatResolvedCommand({ command: "zsh", args: [] })).toBe("zsh");
  });
});
