let allocationChain: Promise<void> = Promise.resolve();

/** Serializes daemon-wide reservations for workspace launch blocks and service ports. */
export async function runWithWorkspacePortAllocationLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = allocationChain;
  let release!: () => void;
  allocationChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
