import { useTerminalDictationState, useTerminalInputSink } from "@/terminal/input-sink";
import { TerminalDictationControl } from "./terminal-dictation-control";
import { TerminalUploadButton } from "./terminal-upload-button";

interface TerminalToolbarSlotProps {
  serverId: string;
  terminalId: string;
}

/**
 * The terminal controls in a pane's tab bar, shown while the pane's active tab is
 * a terminal: upload, then the mic. A view over the mounted pane's input sink and
 * its dictation state: it owns no terminal state and renders nothing until the
 * pane has registered.
 */
export function TerminalToolbarSlot({ serverId, terminalId }: TerminalToolbarSlotProps) {
  const sink = useTerminalInputSink(serverId, terminalId);
  if (!sink) {
    return null;
  }
  return <TerminalToolbarSlotControls sink={sink} />;
}

function TerminalToolbarSlotControls({
  sink,
}: {
  sink: NonNullable<ReturnType<typeof useTerminalInputSink>>;
}) {
  const state = useTerminalDictationState(sink.dictation.ownerId);
  return (
    <>
      <TerminalUploadButton sink={sink} placement="toolbar" />
      <TerminalDictationControl sink={sink} state={state} />
    </>
  );
}
