export type TerminalRendererSelection = "native-grid" | "update-host";

export function resolveTerminalRendererSelection(input: {
  supportsTerminalInputModeReplay: boolean;
}): TerminalRendererSelection {
  return input.supportsTerminalInputModeReplay ? "native-grid" : "update-host";
}
