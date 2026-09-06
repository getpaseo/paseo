import type {
  AudioSessionLease,
  AudioSessionLeaseToken,
  AudioSessionOwner,
} from "./audio-session-lease";

export class AudioCaptureBusyError extends Error {
  constructor(readonly owner: AudioSessionOwner | null) {
    super("The microphone is already in use.");
  }
}

interface CaptureAttempt {
  token: AudioSessionLeaseToken;
  controller: AbortController;
  starting: Promise<void> | null;
  stopping: Promise<void> | null;
}

interface AudioCaptureLifetimeOptions {
  owner: AudioSessionOwner;
  lease: AudioSessionLease;
  stop(): Promise<void>;
}

export interface AudioCaptureLifetime {
  start(action: (signal: AbortSignal) => Promise<void>): Promise<boolean>;
  stop(): Promise<void>;
}

/** Keeps exclusive ownership until even a cancelled microphone request has settled. */
export function createAudioCaptureLifetime(
  options: AudioCaptureLifetimeOptions,
): AudioCaptureLifetime {
  let current: CaptureAttempt | null = null;

  function stop(): Promise<void> {
    const attempt = current;
    if (!attempt) return Promise.resolve();
    if (attempt.stopping) return attempt.stopping;
    attempt.controller.abort();
    const starting = attempt.starting;
    attempt.stopping = (async () => {
      // getUserMedia and native capture startup cannot be cancelled. Stopping
      // before they settle can succeed while capture opens a moment later.
      await starting?.catch(() => undefined);
      await options.stop();
      current = null;
      options.lease.release(attempt.token);
    })().catch((error: unknown) => {
      // A failed stop does not prove capture ended. Keep ownership for a retry.
      attempt.stopping = null;
      throw error;
    });
    return attempt.stopping;
  }

  return {
    start(action) {
      if (current?.starting || current?.stopping || current?.controller.signal.aborted) {
        throw new AudioCaptureBusyError(options.lease.current());
      }
      const token = current?.token ?? options.lease.acquire(options.owner);
      if (!token) throw new AudioCaptureBusyError(options.lease.current());
      const attempt: CaptureAttempt = {
        token,
        controller: new AbortController(),
        starting: null,
        stopping: null,
      };
      current = attempt;
      const starting = Promise.resolve().then(async () => {
        if (!attempt.controller.signal.aborted) await action(attempt.controller.signal);
        return undefined;
      });
      attempt.starting = starting;
      return starting.then(
        () => {
          attempt.starting = null;
          return !attempt.controller.signal.aborted;
        },
        async (error: unknown) => {
          attempt.starting = null;
          await stop();
          throw error;
        },
      );
    },
    stop,
  };
}
