/**
 * Application-wide constants.
 */

export class AppConstants {
  /** Default daemon port. */
  static readonly DEFAULT_PORT = 6767;

  /** Default host for local connections. */
  static readonly DEFAULT_HOST = '127.0.0.1';

  /** WebSocket connection timeout in milliseconds. */
  static readonly CONNECT_TIMEOUT_MS = 10_000;

  /** RPC request timeout in milliseconds. */
  static readonly RPC_TIMEOUT_MS = 60_000;

  /** Maximum composer input lines before scrolling. */
  static readonly MAX_COMPOSER_LINES = 5;

  /** Terminal scrollback buffer size in lines. */
  static readonly TERMINAL_SCROLLBACK = 1000;

  /** Preference key for last-used daemon host. */
  static readonly PREF_LAST_HOST = 'paseo_last_host';

  /** Preference key for last-used daemon port. */
  static readonly PREF_LAST_PORT = 'paseo_last_port';

  /** App version (mirrors root package.json during build). */
  static readonly APP_VERSION = '0.1.0';

  /** Protocol version sent in the WS hello handshake. */
  static readonly PROTOCOL_VERSION = '1';
}
