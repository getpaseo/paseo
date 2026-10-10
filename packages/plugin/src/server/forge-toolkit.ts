/**
 * Shared machinery for Forge plugins. `@getpaseo/plugin/server` owns the
 * provider contract; this entry owns what a Forge plugin would otherwise copy
 * out of another one, for both ways of reaching a vendor:
 *
 * - REST: a token-authenticated HTTP client that maps status codes onto the
 *   SDK's classified errors.
 * - CLI: process execution with the Windows quoting rules, spawn-failure
 *   classification, and JSON output parsing.
 *
 * Plus what both need: Git remote parsing and pagination guards.
 *
 * Nothing here is vendor-specific. A plugin supplies the base URL or binary,
 * the endpoint or command shapes, and what "not signed in" looks like; the
 * toolkit supplies everything between that and the classified errors the daemon
 * reads back to derive auth state.
 */
export {
  createExternalProcessEnv,
  execCommand,
  findExecutable,
  quoteWindowsArgument,
  quoteWindowsCommand,
  runGitCommand,
  shouldUseWindowsShell,
  type ExecCommandOptions,
  type ExecCommandResult,
} from "./forge-toolkit/process.js";
export {
  createCachedCliPathResolver,
  createForgeCliRunner,
  defaultResolveRemoteUrl,
  parseCliJsonOutput,
  redactCommandArgs,
  type CliCommandErrorShape,
  type CreateForgeCliRunnerOptions,
  type ForgeCliRunnerOptions,
  type ForgeCliRunnerResult,
} from "./forge-toolkit/cli.js";
export {
  buildUrl,
  createForgeHttpClient,
  resolveTokenFromEnv,
  type CreateForgeHttpClientOptions,
  type ForgeHttpClient,
  type ForgeHttpMethod,
  type ForgeHttpQuery,
  type ForgeHttpRawRequest,
  type ForgeHttpRequest,
  type ForgeHttpResponse,
} from "./forge-toolkit/http.js";
export { parseGitRemoteLocation, type GitRemoteLocation } from "./forge-toolkit/git-remote.js";
export {
  createForgePageGuard,
  type CreateForgePageGuardOptions,
  type ForgePageGuard,
} from "./forge-toolkit/paging.js";
