export interface BufferedDirectoryTransaction<TClient, TDelta> {
  client: TClient;
  deltas: TDelta[];
}

export function inheritBufferedDirectoryDeltas<TClient, TDelta>(input: {
  client: TClient;
  previous: BufferedDirectoryTransaction<TClient, TDelta> | null | undefined;
}): TDelta[] {
  if (input.previous?.client !== input.client) return [];
  return [...input.previous.deltas];
}
