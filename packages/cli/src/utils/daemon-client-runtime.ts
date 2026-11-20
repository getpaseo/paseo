// The client values the CLI needs at run time. `@getpaseo/client` loads the protocol's message
// schemas when it is imported, so CLI modules load this file with `await import()` where they
// connect to a daemon, and commands that never connect (help, version, config) skip that cost.
export { createHostClient } from "@getpaseo/client/node";
export {
  DaemonConnectionError,
  requireTerminalKeepCapability,
} from "@getpaseo/client/internal/daemon-client";
export { createPaseoApi } from "@getpaseo/client";
