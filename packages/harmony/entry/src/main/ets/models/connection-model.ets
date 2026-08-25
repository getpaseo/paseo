/**
 * Reactive connection state model for the Paseo daemon connection.
 *
 * Uses ArkUI @Observed decorator so that UI components bound to this state
 * automatically re-render when connection status changes.
 */

export interface ServerInfo {
  serverId: string;
  hostname: string;
  version: string;
}

@Observed
export class ConnectionModel {
  /** Current WebSocket connection state. */
  status: 'idle' | 'connecting' | 'connected' | 'disconnected' = 'idle';

  /** Daemon identity — received in the server_info status message. */
  serverId: string = '';
  /** Hostname of the machine running the daemon. */
  hostname: string = '';
  /** Paseo daemon version string (e.g. "0.1.104"). */
  version: string = '';
  /** Error message from the last failed connection attempt. */
  lastError: string = '';
  /** Timestamp of the last successful connection (ms since epoch). */
  connectedAt: number = 0;
  /** True if the daemon is reachable but requires a password. */
  needsPassword: boolean = false;

  /** Reset to idle state (used before reconnection attempts). */
  reset(): void {
    this.status = 'idle';
    this.lastError = '';
    this.serverId = '';
    this.hostname = '';
    this.version = '';
  }

  /** Transition to connecting state. */
  setConnecting(): void {
    this.status = 'connecting';
    this.lastError = '';
  }

  /** Transition to connected state with server info. */
  setConnected(info: ServerInfo): void {
    this.status = 'connected';
    this.serverId = info.serverId;
    this.hostname = info.hostname;
    this.version = info.version;
    this.connectedAt = Date.now();
  }

  /** Transition to disconnected state with optional error. */
  setDisconnected(error?: string): void {
    this.status = 'disconnected';
    if (error) {
      this.lastError = error;
    }
  }
}
