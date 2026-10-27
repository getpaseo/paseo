import { useTerminalInputSink } from "@/terminal/input-sink";
import { TerminalUploadButton } from "./terminal-upload-button";

interface TerminalToolbarSlotProps {
  serverId: string;
  terminalId: string;
}

/**
 * The terminal controls in a pane's tab bar, shown while the pane's active tab is
 * a terminal. A view over the mounted pane's input sink: it owns no terminal
 * state and renders nothing until the pane has registered.
 */
export function TerminalToolbarSlot({ serverId, terminalId }: TerminalToolbarSlotProps) {
  const sink = useTerminalInputSink(serverId, terminalId);
  if (!sink) {
    return null;
  }
  return <TerminalUploadButton sink={sink} placement="toolbar" />;
}
