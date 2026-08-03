import { WebSocket } from "ws";

/**
 * How long the CLI waits for the daemon to answer a close frame before it drops the
 * socket. Long enough for a healthy daemon to finish the handshake, short enough that a
 * wedged one is never what keeps the CLI from exiting.
 */
export const CLOSE_HANDSHAKE_TIMEOUT_MS = 2000;

/**
 * Bound the WebSocket closing handshake.
 *
 * A daemon can receive a close frame and never answer it — a paused process, a half-open
 * socket, a relay that went away mid-flight. Node's `ws` keeps the underlying socket
 * handle alive until its own 30s close timeout expires, and a live handle keeps the CLI
 * process alive with it, so a command that has already printed its output sits there
 * doing nothing. Send the polite close, then terminate if the peer does not answer.
 *
 * The timer is unref'd: the bound must never itself be the reason the process stays up.
 */
export function boundCloseHandshake(
  socket: WebSocket,
  timeoutMs: number = CLOSE_HANDSHAKE_TIMEOUT_MS,
): WebSocket {
  let timer: NodeJS.Timeout | null = null;

  const clearCloseTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  socket.once("close", clearCloseTimer);

  const close = socket.close.bind(socket);
  socket.close = (code?: number, reason?: string) => {
    close(code, reason);
    if (timer || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      socket.terminate();
    }, timeoutMs);
    timer.unref();
  };

  return socket;
}
