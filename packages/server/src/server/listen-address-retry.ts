// A daemon configured to listen on a VPN or overlay address (Tailscale, WireGuard, ZeroTier) can
// start before that interface has its address, for example at login or right after an app
// update. listen() then fails with EADDRNOTAVAIL. That failure clears up on its own once the
// interface comes up, so it is retried for a bounded window. Every other listen error
// (EADDRINUSE, EACCES, ...) is a configuration or conflict problem and fails immediately.

export interface ListenAddressRetryClock {
  now(): number;
  sleep(delayMs: number): Promise<void>;
}

export interface ListenAddressRetryPolicy {
  /** Total time to keep retrying before giving up, measured from the first failure. */
  maxWaitMs: number;
  /** Delay before retry number `attempt` (1-based). */
  delay(attempt: number): number;
}

export interface ListenAddressRetry {
  attempt: number;
  delayMs: number;
  waitedMs: number;
}

export interface ListenWithAddressRetryInput {
  /** One listen attempt. Rejects with the Node listen error. */
  attemptListen: () => Promise<void>;
  /** The configured listen address, used in log and error messages. */
  listen: string;
  clock?: ListenAddressRetryClock;
  policy?: ListenAddressRetryPolicy;
  onRetry?: (retry: ListenAddressRetry) => void;
}

export class ListenAddressUnavailableError extends Error {
  readonly code = "EADDRNOTAVAIL";

  constructor(
    public readonly listen: string,
    public readonly waitedMs: number,
    options: { cause: unknown },
  ) {
    super(
      `Configured listen address ${listen} is not available on this machine (EADDRNOTAVAIL); ` +
        `gave up after waiting ${Math.round(waitedMs / 1000)}s for it to appear. ` +
        "Bring up the network interface that owns this address (for example Tailscale), " +
        "or change daemon.listen in config.json / PASEO_LISTEN.",
      options,
    );
    this.name = "ListenAddressUnavailableError";
  }
}

export const systemListenAddressRetryClock: ListenAddressRetryClock = {
  now: () => Date.now(),
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};

export const defaultListenAddressRetryPolicy: ListenAddressRetryPolicy = {
  maxWaitMs: 60_000,
  delay: (attempt) => Math.min(500 * 2 ** (attempt - 1), 5_000),
};

function isAddressUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EADDRNOTAVAIL"
  );
}

export async function listenWithAddressRetry(input: ListenWithAddressRetryInput): Promise<void> {
  const clock = input.clock ?? systemListenAddressRetryClock;
  const policy = input.policy ?? defaultListenAddressRetryPolicy;
  let firstFailureAt: number | null = null;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await input.attemptListen();
      return;
    } catch (error) {
      if (!isAddressUnavailable(error)) throw error;
      firstFailureAt ??= clock.now();
      const waitedMs = clock.now() - firstFailureAt;
      const remainingMs = policy.maxWaitMs - waitedMs;
      if (remainingMs <= 0) {
        throw new ListenAddressUnavailableError(input.listen, waitedMs, { cause: error });
      }
      const delayMs = Math.min(policy.delay(attempt), remainingMs);
      input.onRetry?.({ attempt, delayMs, waitedMs });
      await clock.sleep(delayMs);
    }
  }
}
