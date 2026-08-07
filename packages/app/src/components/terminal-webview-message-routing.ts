interface TerminalBridgeMessageIdentity {
  type: string;
  streamKey?: string;
}

export function shouldHandleTerminalBridgeMessage(
  message: TerminalBridgeMessageIdentity,
  stream: {
    desiredStreamKey: string;
    mountedStreamKey: string | null;
  },
): boolean {
  return (
    message.streamKey === undefined ||
    (message.streamKey === stream.desiredStreamKey && message.streamKey === stream.mountedStreamKey)
  );
}
