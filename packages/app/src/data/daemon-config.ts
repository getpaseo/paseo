export function daemonConfigQueryKey(serverId: string | null) {
  return ["daemon-config", serverId] as const;
}
