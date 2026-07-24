export {
  SshTunnel,
  sshExec,
  buildSshBaseArgs,
  findFreeLocalPort,
  waitForLocalPort,
  createAskpassScript,
  createTerminalAskpassScript,
  cleanupAskpassScript,
} from "./ssh-process.js";
export {
  ensureRemoteDaemon,
  buildEnsureScript,
  type EnsureRemoteDaemonResult,
} from "./remote-daemon.js";
export { normalizeSshHostConfig, type SshHostConfig } from "./ssh-host-config.js";
export type { SshHostConnection } from "@getpaseo/protocol/host-connection-schema";
