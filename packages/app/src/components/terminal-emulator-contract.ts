import type { Ref } from "react";
import type { ITheme } from "@xterm/xterm";
import type { TerminalState } from "@getpaseo/protocol/messages";
import type { TerminalInputModeState } from "@getpaseo/protocol/terminal-input-mode";
import type { TerminalOutputData } from "../terminal/runtime/terminal-emulator-runtime";
import type {
  TerminalLocalFileLinkSource,
  TerminalLocalFileLinkTarget,
} from "../terminal/local-links/terminal-local-link-provider";
import type { TerminalClipboardWriter } from "../terminal/native-renderer/terminal-selection";
import type { PendingTerminalModifiers } from "../utils/terminal-keys";
import type { TerminalRendererReadyChange } from "../utils/terminal-renderer-readiness";

export interface TerminalEmulatorHandle {
  writeOutput: (data: TerminalOutputData) => void;
  restoreOutput: (data: TerminalOutputData) => void;
  renderSnapshot: (state: TerminalState | null) => void;
  paste: (text: string) => void;
  copySelection: (clipboard: TerminalClipboardWriter) => Promise<string>;
  clear: () => void;
  claimSize: () => void;
  showKeyboard: () => void;
  blur: () => void;
}

export interface TerminalEmulatorProps {
  dom?: unknown;
  ref: Ref<TerminalEmulatorHandle>;
  streamKey: string;
  supportsTerminalInputModeReplay: boolean;
  testId?: string;
  xtermTheme?: ITheme;
  scrollbackLines: number;
  fontFamily?: string;
  fontSize?: number;
  wordShapingEnabled?: boolean;
  keyboardInset?: number;
  isKeyboardVisible?: boolean;
  swipeGesturesEnabled?: boolean;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  initialSnapshot?: TerminalState | null;
  onInput?: (data: string) => Promise<void> | void;
  onFocus?: () => Promise<void> | void;
  onResize?: (input: {
    rows: number;
    cols: number;
    shouldClaim: boolean;
    forceClaim?: boolean;
  }) => Promise<void> | void;
  onTerminalKey?: (input: {
    key: string;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
  }) => Promise<void> | void;
  onPendingModifiersConsumed?: () => Promise<void> | void;
  onInputModeChange?: (state: TerminalInputModeState) => Promise<void> | void;
  onSelectionChange?: (hasSelection: boolean) => void;
  onResolveLocalFileLink?: (
    source: TerminalLocalFileLinkSource,
  ) => Promise<TerminalLocalFileLinkTarget | null> | TerminalLocalFileLinkTarget | null;
  onOpenLocalFileLink?: (
    target: TerminalLocalFileLinkTarget,
    disposition: "main" | "side",
  ) => Promise<void> | void;
  onRendererReadyChange?: (change: TerminalRendererReadyChange) => void;
  pendingModifiers?: PendingTerminalModifiers;
  focusRequestToken?: number;
  resizeRequestToken?: number;
}
