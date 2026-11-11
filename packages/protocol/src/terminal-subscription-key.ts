// A terminal directory subscription is scoped to a (cwd, workspaceId) pair, not
// cwd alone: under Model B two workspaces can share a cwd, and each must track
// and tear down its own live subscription without disturbing the other. An
// absent workspaceId (old clients) keys to the cwd on its own. The `::`
// separator cannot collide with a workspace id, which is always `wks_<hex>`.
export function terminalSubscriptionKey(cwd: string, workspaceId: string | undefined): string {
  return workspaceId === undefined ? cwd : `${workspaceId}::${cwd}`;
}
