import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  formatResolvedCommand,
  profileTakesPrompt,
  substitutePrompt,
} from "@getpaseo/protocol/terminal-profiles";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import { resolveLaunchProfile, type LaunchTarget } from "./target";

export interface TerminalComposerState {
  isTerminalLaunch: boolean;
  /** Null for a blank terminal: no command, just the daemon's default shell. */
  selectedTerminalProfile: TerminalProfile | null;
  /** False when there is nothing to type, which puts the composer in read-only. */
  terminalTakesPrompt: boolean;
  /** The composer's content: the typed text, or the resolved command when read-only. */
  terminalComposerValue: string;
  /** Placeholder for the editable cases. Empty when read-only, which shows a command instead. */
  terminalPlaceholder: string;
  /**
   * Only the read-only case needs a word: there is nothing to type, so the
   * button is the whole interaction. When you can type, the icon matches chat.
   */
  terminalSubmitLabel: string | undefined;
  /**
   * Changes whenever the target does, which is what asks the composer to take
   * focus again on web. Picking from the menu moves focus into the menu, and
   * you almost always want to type next, so hand it back.
   */
  launchFocusKey: string;
}

export interface ResolveTerminalComposerStateInput {
  launchTarget: LaunchTarget;
  terminalProfiles: readonly TerminalProfile[];
  terminalPromptText: string;
  commandPlaceholder: string;
  promptPlaceholder: (profileName: string) => string;
  submitLabel: string;
}

function launchKey(target: LaunchTarget): string {
  return target.kind === "chat" ? "chat" : `terminal:${target.profileId}`;
}

export function resolveTerminalComposerState(
  input: ResolveTerminalComposerStateInput,
): TerminalComposerState {
  const { launchTarget, terminalProfiles, terminalPromptText } = input;
  const selectedTerminalProfile = resolveLaunchProfile(launchTarget, terminalProfiles);
  const isTerminalLaunch = launchTarget.kind === "terminal";

  // A blank terminal has no argv to substitute into, so what you type is a
  // command for the shell rather than a prompt. Editable, always: typing a
  // command at a shell prompt is the whole point of a shell.
  if (!selectedTerminalProfile) {
    return {
      isTerminalLaunch,
      selectedTerminalProfile: null,
      terminalTakesPrompt: true,
      terminalComposerValue: terminalPromptText,
      terminalPlaceholder: input.commandPlaceholder,
      terminalSubmitLabel: undefined,
      launchFocusKey: launchKey(launchTarget),
    };
  }

  const takesPrompt = profileTakesPrompt(selectedTerminalProfile);
  return {
    isTerminalLaunch,
    selectedTerminalProfile,
    terminalTakesPrompt: takesPrompt,
    terminalComposerValue: takesPrompt
      ? terminalPromptText
      : formatResolvedCommand(substitutePrompt(selectedTerminalProfile, terminalPromptText)),
    terminalPlaceholder: takesPrompt ? input.promptPlaceholder(selectedTerminalProfile.name) : "",
    terminalSubmitLabel: takesPrompt ? undefined : input.submitLabel,
    launchFocusKey: launchKey(launchTarget),
  };
}

/** Owns the copy so the screen passes state, not strings. */
export function useTerminalComposerState(input: {
  launchTarget: LaunchTarget;
  terminalProfiles: readonly TerminalProfile[];
  terminalPromptText: string;
}): TerminalComposerState {
  const { t } = useTranslation();
  const { launchTarget, terminalProfiles, terminalPromptText } = input;
  return useMemo(
    () =>
      resolveTerminalComposerState({
        launchTarget,
        terminalProfiles,
        terminalPromptText,
        commandPlaceholder: t("newWorkspace.launch.commandPlaceholder"),
        promptPlaceholder: (name) => t("newWorkspace.launch.promptPlaceholder", { name }),
        submitLabel: t("newWorkspace.launch.submit"),
      }),
    [launchTarget, terminalProfiles, terminalPromptText, t],
  );
}
