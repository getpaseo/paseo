/**
 * Re-exported rather than reimplemented. A second parser drifts from the one the
 * daemon uses to decide which forge owns a remote, and the two disagreeing is
 * invisible until a plugin resolves a repository the host does not.
 */
export { parseGitRemoteLocation, type GitRemoteLocation } from "@getpaseo/protocol/git-remote";
