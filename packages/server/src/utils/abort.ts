export async function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return await operation;
  }

  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => {
    rejectAborted(signal.reason ?? new Error("Operation aborted"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
