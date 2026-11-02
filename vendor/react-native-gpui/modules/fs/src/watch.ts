/**
 * `watch`: the JS half of the typed watcher event.
 *
 * The native module returns a watcher id; every event it produces carries that
 * id, so one shared emitter serves every open watcher and each listener keeps
 * only its own. The subscription is taken through the generated typed emitter on
 * the module (`NativeFs.onWatchEvent`), which is the same mechanism the fixture's
 * `onProgress` uses in `RustTurboModuleFixture.tsx`, rather than through
 * `NativeEventEmitter`: the spec declares `onWatchEvent` as a typed
 * `CodegenTypes.EventEmitter`, and the bridge installs a listener for exactly
 * that; `NativeEventEmitter` would subscribe on the global device-emitter channel
 * that only `sendEvent` writes to, so it would never fire.
 */

import NativeFs, { type WatchEvent } from './NativeFs';
import { toPath, withContext, type NodeError } from './shared';

/** The event names Node uses for the two things a watcher reports. */
export type WatchEventType = 'rename' | 'change';

export interface WatchOptions {
  recursive?: boolean;
  encoding?: string;
}

export interface FSWatcher {
  close(): Promise<void>;
}

export type WatchListener = (
  eventType: WatchEventType,
  filename: string | null,
) => void;

/**
 * Which of Node's two event types a native kind is.
 *
 * Node folds everything it sees into `rename` (the entry appeared, vanished or
 * moved) and `change` (its contents or metadata changed). The caller's callback
 * signature is Node's, so the mapping happens here while the native kind stays
 * available to anyone who subscribes to the module directly.
 */
function eventTypeOf(kind: string): WatchEventType {
  return kind === 'modify' ? 'change' : 'rename';
}

/** The file a path names, relative to the watched root where it is below it. */
/**
 * The filename a listener is given.
 *
 * The native side already reported it relative to the watch root, and its own
 * name for a single-file watch: it canonicalises the root, which is where macOS
 * decides between `/var` and `/private/var`, and it strips whichever spelling the
 * event actually carries. Stripping a prefix here as well would be a second,
 * weaker guess at the same question — a relative root never matches, and Windows
 * separates with `\` — so the event path is passed through unchanged.
 */
function fileNameOf(eventPath: string): string {
  return eventPath;
}

/**
 * Starts a watcher.
 *
 * The id arrives asynchronously, but the caller expects a handle it can close
 * immediately, so the handle is created first and closing it before the id is
 * known sets a flag the resolution honours. That is the one ordering hazard in
 * this API, and it is invisible from the outside.
 *
 * Node reports a failure to start through an `error` event on the watcher. This
 * handle has no event surface, so the failure is held and rejected from
 * `close()` instead: it can then never become an unhandled rejection, and a
 * caller that closes what it opened is guaranteed to see it.
 */
export function watch(path: string, listener: WatchListener): FSWatcher;
export function watch(
  path: string,
  options: WatchOptions | null,
  listener: WatchListener,
): FSWatcher;
export function watch(
  path: string,
  optionsOrListener: WatchOptions | null | WatchListener,
  maybeListener?: WatchListener,
): FSWatcher {
  const options =
    typeof optionsOrListener === 'function' ? {} : (optionsOrListener ?? {});
  const listener =
    typeof optionsOrListener === 'function' ? optionsOrListener : maybeListener;
  if (typeof listener !== 'function') {
    throw new TypeError('watch requires a listener function');
  }

  const target = toPath(path);
  let id: number | null = null;
  let closed = false;
  let failure: NodeError | null = null;
  let subscription: { remove(): void } | null = null;

  const ready = NativeFs.watch(target, options.recursive ?? false)
    .then(watcherId => {
      id = watcherId;
      if (closed) {
        // `close()` ran while the id was in flight; stop the native watcher now
        // that there is something to stop.
        NativeFs.unwatch(watcherId);
        return;
      }
      subscription = NativeFs.onWatchEvent((event: WatchEvent) => {
        if (event.id !== id) {
          return;
        }
        // The encoding option only affects how a non-ASCII name is decoded, and
        // every name already arrives as a JS string.
        listener(eventTypeOf(event.kind), fileNameOf(event.path));
      });
    })
    .catch((error: unknown) => {
      failure = withContext(error, 'watch', target);
    });

  return {
    async close(): Promise<void> {
      closed = true;
      subscription?.remove();
      subscription = null;
      if (id !== null) {
        NativeFs.unwatch(id);
        id = null;
      }
      // Awaiting the start makes `close()` immediately after `watch()` still stop
      // the native watcher rather than racing it.
      await ready;
      if (failure !== null) {
        const error = failure;
        failure = null;
        throw error;
      }
    },
  };
}
