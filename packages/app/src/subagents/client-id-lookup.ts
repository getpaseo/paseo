/** Retry a failed storage lookup on the next caller signal, without overlapping requests. */
export function createClientIdLookup(input: {
  getClientId: () => Promise<string>;
  onResolved: (clientId: string) => void;
  onError: (error: unknown) => void;
}): { resolve: () => Promise<void>; dispose: () => void } {
  let disposed = false;
  let resolving = false;
  return {
    async resolve() {
      if (disposed || resolving) return;
      resolving = true;
      try {
        const clientId = await input.getClientId();
        if (!disposed) input.onResolved(clientId);
      } catch (error) {
        if (!disposed) input.onError(error);
      } finally {
        resolving = false;
      }
    },
    dispose() {
      disposed = true;
    },
  };
}
