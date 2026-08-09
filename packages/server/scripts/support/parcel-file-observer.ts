import parcelWatcher from "@parcel/watcher";
import { resolve } from "node:path";
import type {
  FileObserverCallback,
  FileObserverOptions,
  FileObserverSubscription,
  SubscribeToFileChanges,
} from "../../src/server/file-observer/index.js";

/** Benchmark control for the Parcel implementation replaced by the production observer. */
export const subscribeToFileChangesWithParcel: SubscribeToFileChanges = async (
  directory: string,
  callback: FileObserverCallback,
  options: FileObserverOptions = {},
): Promise<FileObserverSubscription> => {
  const root = resolve(directory);
  let ignoredRoots = options.ignore ?? [];
  let subscription = await subscribe(root, ignoredRoots, callback);
  let lifecycle = Promise.resolve();
  let closed = false;
  const replaceSubscription = async (): Promise<void> => {
    if (closed) return;
    await subscription.unsubscribe();
    if (closed) return;
    subscription = await subscribe(root, ignoredRoots, callback);
  };

  return {
    updateIgnore(paths) {
      ignoredRoots = paths;
      lifecycle = lifecycle.then(replaceSubscription);
      return lifecycle;
    },
    unsubscribe() {
      if (closed) return lifecycle;
      closed = true;
      lifecycle = lifecycle.then(() => subscription.unsubscribe());
      return lifecycle;
    },
  };
};

async function subscribe(
  root: string,
  ignore: string[],
  callback: FileObserverCallback,
): Promise<parcelWatcher.AsyncSubscription> {
  return parcelWatcher.subscribe(
    root,
    (error, events) => {
      callback(
        error,
        events.map((event) => ({ path: resolve(event.path), type: event.type })),
      );
    },
    {
      backend: getParcelBackend(process.platform),
      ignore,
    },
  );
}

function getParcelBackend(platform: NodeJS.Platform): parcelWatcher.BackendType {
  switch (platform) {
    case "darwin":
      return "fs-events";
    case "linux":
      return "inotify";
    case "win32":
      return "windows";
    default:
      throw new Error(`No Parcel benchmark backend configured for ${platform}`);
  }
}
