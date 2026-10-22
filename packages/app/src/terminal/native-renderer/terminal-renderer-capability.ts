export type TerminalRendererSelection = "native-grid" | "webview" | "update-host";

export function resolveTerminalRendererSelection(input: {
  useLegacyTerminalRenderer: boolean;
  supportsTerminalInputModeReplay: boolean;
}): TerminalRendererSelection {
  if (input.useLegacyTerminalRenderer) {
    return "webview";
  }
  return input.supportsTerminalInputModeReplay ? "native-grid" : "update-host";
}
