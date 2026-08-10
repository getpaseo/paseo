import { describe, expect, it } from "vitest";
import { PROMPT_SENTINEL } from "@getpaseo/protocol/terminal-profiles";
import { resolveDefaultTerminalLaunch } from "./terminal-default-profile.js";

// What a plain new terminal opens is decided in exactly one place, so the RPC,
// the host settings UI and the spawn cannot drift. These are the shapes that
// place has to get right.
describe("resolveDefaultTerminalLaunch", () => {
  it("leaves the system shell in charge when no default is set", () => {
    expect(
      resolveDefaultTerminalLaunch({ defaultTerminalProfileId: "", terminalProfiles: undefined }),
    ).toBeUndefined();
  });

  it("launches the default profile's command and args", () => {
    expect(
      resolveDefaultTerminalLaunch({
        defaultTerminalProfileId: "shell-pwsh",
        terminalProfiles: [
          { id: "shell-pwsh", name: "PowerShell 7", command: "C:\\pwsh\\pwsh.exe", args: ["-l"] },
        ],
      }),
    ).toEqual({ command: "C:\\pwsh\\pwsh.exe", args: ["-l"] });
  });

  // A default pointing at a shipped profile has to resolve for a user who has
  // never edited the list, where terminalProfiles is still absent.
  it("resolves a shipped profile when the user has no profile list", () => {
    expect(
      resolveDefaultTerminalLaunch({
        defaultTerminalProfileId: "codex",
        terminalProfiles: undefined,
      }),
    ).toEqual({ command: "codex", args: [] });
  });

  // Nothing is typed on this path, so the prompt-only args have to be dropped
  // exactly as they are for a profile the client launches with no prompt.
  it("drops prompt-only args because a plain terminal carries no prompt", () => {
    expect(
      resolveDefaultTerminalLaunch({
        defaultTerminalProfileId: "opencode",
        terminalProfiles: [
          {
            id: "opencode",
            name: "OpenCode",
            command: "opencode",
            args: ["--model=gpt-5", `--prompt=${PROMPT_SENTINEL}`],
          },
        ],
      }),
    ).toEqual({ command: "opencode", args: ["--model=gpt-5"] });
  });

  // A profile deleted while it was still the default must not spawn its id as a
  // command; the terminal falls back to the system shell instead.
  it("falls back to the system shell when the default profile is gone", () => {
    expect(
      resolveDefaultTerminalLaunch({
        defaultTerminalProfileId: "shell-nu",
        terminalProfiles: [{ id: "shell-pwsh", name: "PowerShell 7", command: "pwsh" }],
      }),
    ).toBeUndefined();
  });
});
