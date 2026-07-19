export function larkChannelQueryKey(serverId: string | null) {
  return ["lark-channel", serverId] as const;
}
