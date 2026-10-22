export function shouldResetForMissingRendererReady(input: {
  expectedReadyVersion: number;
  currentReadyVersion: number;
  expectedStreamKey: string;
  mountRequestedStreamKey: string | null;
  rendererReadyStreamKey: string | null;
}): boolean {
  return (
    input.currentReadyVersion === input.expectedReadyVersion &&
    input.mountRequestedStreamKey === input.expectedStreamKey &&
    input.rendererReadyStreamKey !== input.expectedStreamKey
  );
}
