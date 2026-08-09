export interface ReconnectToastState {
  connectionStatusStartedAt: number;
  presented: boolean;
}

export function reconcileReconnectToastState(
  state: ReconnectToastState | undefined,
  connectionStatusStartedAt: number,
): ReconnectToastState {
  if (state?.connectionStatusStartedAt === connectionStatusStartedAt) {
    return state;
  }

  return {
    connectionStatusStartedAt,
    presented: false,
  };
}
