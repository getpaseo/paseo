/**
 * `@react-native-gpui/fs`: a Node-shaped file API for the desktop app.
 *
 * The native module underneath is one TurboModule on its own thread with
 * `ArrayBuffer` arguments and plain-object results. Everything Node adds on top
 * of that — encodings, `Stats` and `Dirent` instances, callback forms, the
 * `fs/promises` object — lives in this package's JS layer, so the bridge stays a
 * byte mover and the API stays recognisably Node's.
 *
 * The default export is the `node:fs` object; `dialog`, `paths` and `watch` are
 * named exports because they have no `fs` counterpart to hang off.
 */

import { constants } from './constants';
import NativeFs from './NativeFs';
import {
  Dirent,
  FileHandle,
  Stats,
  promises,
  readFileImpl,
  type MkdirOptions,
  type OpenOptions,
  type RmOptions,
  type WriteOptions,
} from './promises';
import {
  decodeString,
  flagFrom,
  missingPath,
  modeFrom,
  normalizeEncoding,
  relativeEntryName,
  toArrayBuffer,
  toPath,
  withContext,
  type BinaryData,
  type Encoding,
  type NodeError,
} from './shared';
import { watch } from './watch';

export type {
  CpOptions,
  MkdirOptions,
  OpenOptions,
  ReaddirOptions,
  RmOptions,
  TimeLike,
  WriteOptions,
} from './promises';
export type { BinaryData, Encoding, NodeError } from './shared';
export type {
  FSWatcher,
  WatchEventType,
  WatchListener,
  WatchOptions,
} from './watch';
export { Dirent, Stats, FileHandle, promises, constants, watch };

/* -------------------------------------------------------------------------- */
/* Dialogs                                                                    */
/* -------------------------------------------------------------------------- */

export interface DialogFilter {
  name: string;
  extensions: Array<string>;
}

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
  directory?: boolean;
  filters?: Array<DialogFilter>;
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  defaultName?: string;
  filters?: Array<DialogFilter>;
}

/**
 * The native pickers.
 *
 * Cancelling is not an error: `open` resolves with `[]` and `save` with `null`,
 * which is what the design specifies and what libraries pairing the two expect.
 */
export const dialog = {
  async open(options: OpenDialogOptions = {}): Promise<string[]> {
    return NativeFs.showOpenDialog({
      title: options.title,
      defaultPath:
        options.defaultPath === undefined
          ? undefined
          : toPath(options.defaultPath),
      multiple: options.multiple ?? false,
      directory: options.directory ?? false,
      filters: options.filters ?? [],
    });
  },

  async save(options: SaveDialogOptions = {}): Promise<string | null> {
    return NativeFs.showSaveDialog({
      title: options.title,
      defaultPath:
        options.defaultPath === undefined
          ? undefined
          : toPath(options.defaultPath),
      defaultName: options.defaultName,
      filters: options.filters ?? [],
    });
  },
};

/* -------------------------------------------------------------------------- */
/* Known paths                                                                */
/* -------------------------------------------------------------------------- */

/** The well-known directories, as the native side reports them. */
export interface KnownPaths {
  home: string;
  documents: string;
  downloads: string;
  desktop: string;
  temp: string;
  appData: string;
  appCache: string;
  appLogs: string;
}

const KNOWN_PATH_NAMES = [
  'home',
  'documents',
  'downloads',
  'desktop',
  'temp',
  'appData',
  'appCache',
  'appLogs',
] as const;

let cachedPaths: KnownPaths | null = null;

/**
 * Reads the known paths once and remembers them.
 *
 * Lazy rather than at import time so that importing this package cannot fail: the
 * native module is only asked when an app actually names a directory, and the
 * native side creates the per-app folders on that first read.
 */
function knownPaths(): KnownPaths {
  if (cachedPaths === null) {
    cachedPaths = NativeFs.getPaths();
  }
  return cachedPaths;
}

/**
 * `paths.home`, `paths.documents` and the rest.
 *
 * Each property is a getter over one cached native read, so destructuring works
 * and the object can be exported before the module has been asked anything.
 */
export const paths: KnownPaths = Object.defineProperties(
  {},
  Object.fromEntries(
    KNOWN_PATH_NAMES.map(name => [
      name,
      { enumerable: true, get: () => knownPaths()[name] },
    ]),
  ),
) as KnownPaths;

/* -------------------------------------------------------------------------- */
/* Sync forms                                                                 */
/* -------------------------------------------------------------------------- */

function readFileSync(path: string): Uint8Array;
function readFileSync(
  path: string,
  options: Encoding | { encoding: Encoding },
): string;
function readFileSync(
  path: string,
  options?: Encoding | { encoding?: Encoding | null } | null,
): Uint8Array | string {
  const target = toPath(path);
  const encoding =
    typeof options === 'string' ? options : (options?.encoding ?? null);
  try {
    if (encoding === null) {
      return new Uint8Array(NativeFs.readFileSync(target));
    }
    const normalized = normalizeEncoding(encoding) ?? 'utf8';
    if (normalized === 'utf8') {
      // The dedicated text method decodes in Rust instead of handing JS bytes
      // to decode a second time.
      return NativeFs.readTextFileSync(target);
    }
    return decodeString(
      new Uint8Array(NativeFs.readFileSync(target)),
      normalized,
    );
  } catch (error) {
    throw withContext(error, 'open', target);
  }
}

function writeFileSync(
  path: string,
  data: BinaryData,
  options?: WriteOptions | Encoding,
): void {
  const target = toPath(path);
  const opts: WriteOptions =
    typeof options === 'string' ? { encoding: options } : (options ?? {});
  const flag = flagFrom(
    opts.flag,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
  );
  const mode = modeFrom(opts.mode);
  try {
    if (typeof data === 'string') {
      const encoding = normalizeEncoding(opts.encoding ?? 'utf8') ?? 'utf8';
      if (encoding === 'utf8') {
        NativeFs.writeTextFileSync(target, data, flag, mode);
        return;
      }
      NativeFs.writeFileSync(target, toArrayBuffer(data, encoding), flag, mode);
      return;
    }
    NativeFs.writeFileSync(target, toArrayBuffer(data), flag, mode);
  } catch (error) {
    throw withContext(error, 'open', target);
  }
}

function appendFileSync(
  path: string,
  data: BinaryData,
  options?: WriteOptions | Encoding,
): void {
  const opts: WriteOptions =
    typeof options === 'string' ? { encoding: options } : (options ?? {});
  writeFileSync(path, data, {
    ...opts,
    flag:
      opts.flag ?? constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
  });
}

function existsSync(path: string): boolean {
  try {
    return NativeFs.existsSync(toPath(path));
  } catch {
    // `existsSync` answers a question rather than reporting a failure, so every
    // error — a permission problem as much as a missing path — is a `false`.
    return false;
  }
}

function statSync(path: string): Stats {
  const target = toPath(path);
  try {
    const result = NativeFs.statSync(target, true);
    if (result === null) {
      throw missingPath(target, 'stat');
    }
    return new Stats(result);
  } catch (error) {
    throw withContext(error, 'stat', target);
  }
}

function lstatSync(path: string): Stats {
  const target = toPath(path);
  try {
    const result = NativeFs.statSync(target, false);
    if (result === null) {
      throw missingPath(target, 'lstat');
    }
    return new Stats(result);
  } catch (error) {
    throw withContext(error, 'lstat', target);
  }
}

function readdirSync(
  path: string,
  options?: { withFileTypes?: false; recursive?: boolean } | null,
): string[];
function readdirSync(
  path: string,
  options: { withFileTypes: true; recursive?: boolean },
): Dirent[];
function readdirSync(
  path: string,
  options?: { withFileTypes?: boolean; recursive?: boolean } | null,
): string[] | Dirent[] {
  const target = toPath(path);
  try {
    const recursive = options?.recursive ?? false;
    const entries = NativeFs.readdirSync(target, recursive);
    return options?.withFileTypes
      ? entries.map(entry => new Dirent(entry))
      : entries.map(entry =>
          recursive
            ? relativeEntryName(target, entry.parentPath, entry.name)
            : entry.name,
        );
  } catch (error) {
    throw withContext(error, 'scandir', target);
  }
}

function mkdirSync(path: string, options?: MkdirOptions | number): void {
  const target = toPath(path);
  const opts: MkdirOptions =
    typeof options === 'number' ? { mode: options } : (options ?? {});
  try {
    NativeFs.mkdirSync(
      target,
      opts.recursive ?? false,
      modeFrom(opts.mode, 0o777),
    );
  } catch (error) {
    throw withContext(error, 'mkdir', target);
  }
}

function rmSync(path: string, options?: RmOptions): void {
  const target = toPath(path);
  try {
    NativeFs.rmSync(
      target,
      options?.recursive ?? false,
      options?.force ?? false,
    );
  } catch (error) {
    throw withContext(error, 'rm', target);
  }
}

function renameSync(from: string, to: string): void {
  const source = toPath(from);
  const destination = toPath(to);
  try {
    NativeFs.renameSync(source, destination);
  } catch (error) {
    const wrapped = withContext(error, 'rename', source);
    // Node's rename error names both ends; the second is `dest`, not `path`.
    if (wrapped.dest === undefined) {
      wrapped.dest = destination;
    }
    throw wrapped;
  }
}

function copyFileSync(from: string, to: string): void {
  const source = toPath(from);
  const destination = toPath(to);
  try {
    NativeFs.copyFileSync(source, destination);
  } catch (error) {
    const wrapped = withContext(error, 'copyfile', source);
    if (wrapped.dest === undefined) {
      wrapped.dest = destination;
    }
    throw wrapped;
  }
}

/* -------------------------------------------------------------------------- */
/* Callback forms                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The callback forms are wrappers over the promise implementations, as the
 * design says, so there is one implementation of each operation.
 *
 * The trailing argument is the callback in every form; the optional argument
 * before it is an options object (or an encoding, or a mode) when it is not a
 * function. That is the whole of Node's overloading convention here.
 */

type NodeCallback<T> = (error: NodeError | null, value?: T) => void;

function callbackOf<T>(args: unknown[]): NodeCallback<T> {
  const callback = args[args.length - 1];
  if (typeof callback !== 'function') {
    throw new TypeError('A callback function is required');
  }
  return callback as NodeCallback<T>;
}

/** The options argument, if the caller supplied one rather than the callback. */
function before<T>(args: unknown[], index: number, fallback: T): T {
  const value = args[index];
  return value === undefined || typeof value === 'function'
    ? fallback
    : (value as T);
}

/**
 * Reports a settled promise the Node way.
 *
 * A rejection that has a callback is delivered to it; nothing is thrown, because
 * a throw from here would escape the caller's stack rather than the callback.
 */
function settle<T>(promise: Promise<T>, callback: NodeCallback<T>): void {
  promise.then(
    value => callback(null, value),
    (error: NodeError) => callback(error),
  );
}

function readFile(
  path: string,
  callback: NodeCallback<Uint8Array | string>,
): void;
function readFile(
  path: string,
  options: Encoding | { encoding?: Encoding | null } | null,
  callback: NodeCallback<Uint8Array | string>,
): void;
function readFile(path: string, ...args: unknown[]): void {
  // The promise overloads keep the result precise; the callback form goes
  // through the coarse alias because at that point the encoding is a runtime
  // value and either shape is possible.
  const options = before(args, 0, undefined) as
    Encoding | { encoding?: Encoding | null } | null | undefined;
  settle(readFileImpl(path, options), callbackOf(args));
}

function writeFile(
  path: string,
  data: BinaryData,
  callback: NodeCallback<void>,
): void;
function writeFile(
  path: string,
  data: BinaryData,
  options: WriteOptions | Encoding | null,
  callback: NodeCallback<void>,
): void;
function writeFile(path: string, data: BinaryData, ...args: unknown[]): void {
  settle(
    promises.writeFile(
      path,
      data,
      before(args, 0, undefined) as WriteOptions | Encoding | undefined,
    ),
    callbackOf(args),
  );
}

function appendFile(
  path: string,
  data: BinaryData,
  callback: NodeCallback<void>,
): void;
function appendFile(
  path: string,
  data: BinaryData,
  options: WriteOptions | Encoding | null,
  callback: NodeCallback<void>,
): void;
function appendFile(path: string, data: BinaryData, ...args: unknown[]): void {
  settle(
    promises.appendFile(
      path,
      data,
      before(args, 0, undefined) as WriteOptions | Encoding | undefined,
    ),
    callbackOf(args),
  );
}

function readdir(
  path: string,
  callback: NodeCallback<string[] | Dirent[]>,
): void;
function readdir(
  path: string,
  options: { withFileTypes?: boolean; recursive?: boolean } | null,
  callback: NodeCallback<string[] | Dirent[]>,
): void;
function readdir(path: string, ...args: unknown[]): void {
  const options = before(args, 0, null) as {
    withFileTypes?: boolean;
    recursive?: boolean;
  } | null;
  const pending: Promise<string[] | Dirent[]> = options?.withFileTypes
    ? promises.readdir(path, { ...options, withFileTypes: true })
    : promises.readdir(path, {
        recursive: options?.recursive,
        withFileTypes: false,
      });
  settle(pending, callbackOf(args));
}

function stat(path: string, callback: NodeCallback<Stats>): void;
function stat(path: string, ...args: unknown[]): void {
  settle(promises.stat(path), callbackOf([...args]));
}

function lstat(path: string, callback: NodeCallback<Stats>): void;
function lstat(path: string, ...args: unknown[]): void {
  settle(promises.lstat(path), callbackOf([...args]));
}

function mkdir(path: string, callback: NodeCallback<string | undefined>): void;
function mkdir(
  path: string,
  options: MkdirOptions | number | null,
  callback: NodeCallback<string | undefined>,
): void;
function mkdir(path: string, ...args: unknown[]): void {
  settle(
    promises.mkdir(
      path,
      before(args, 0, undefined) as MkdirOptions | number | undefined,
    ),
    callbackOf(args),
  );
}

function rm(path: string, callback: NodeCallback<void>): void;
function rm(
  path: string,
  options: RmOptions | null,
  callback: NodeCallback<void>,
): void;
function rm(path: string, ...args: unknown[]): void {
  settle(
    promises.rm(path, before(args, 0, undefined) as RmOptions | undefined),
    callbackOf(args),
  );
}

function rename(from: string, to: string, callback: NodeCallback<void>): void;
function rename(from: string, to: string, ...args: unknown[]): void {
  settle(promises.rename(from, to), callbackOf([...args]));
}

function copyFile(from: string, to: string, callback: NodeCallback<void>): void;
function copyFile(
  from: string,
  to: string,
  mode: number,
  callback: NodeCallback<void>,
): void;
function copyFile(from: string, to: string, ...args: unknown[]): void {
  settle(
    promises.copyFile(
      from,
      to,
      before(args, 0, undefined) as number | undefined,
    ),
    callbackOf(args),
  );
}

function cp(from: string, to: string, callback: NodeCallback<void>): void;
function cp(
  from: string,
  to: string,
  options: { recursive?: boolean } | null,
  callback: NodeCallback<void>,
): void;
function cp(from: string, to: string, ...args: unknown[]): void {
  settle(
    promises.cp(
      from,
      to,
      before(args, 0, undefined) as { recursive?: boolean } | undefined,
    ),
    callbackOf(args),
  );
}

function access(path: string, callback: NodeCallback<void>): void;
function access(path: string, mode: number, callback: NodeCallback<void>): void;
function access(path: string, ...args: unknown[]): void {
  settle(
    promises.access(path, before(args, 0, undefined) as number | undefined),
    callbackOf(args),
  );
}

function realpath(path: string, callback: NodeCallback<string>): void;
function realpath(path: string, ...args: unknown[]): void {
  settle(promises.realpath(path), callbackOf([...args]));
}

function readlink(path: string, callback: NodeCallback<string>): void;
function readlink(path: string, ...args: unknown[]): void {
  settle(promises.readlink(path), callbackOf([...args]));
}

function symlink(
  target: string,
  path: string,
  callback: NodeCallback<void>,
): void;
function symlink(
  target: string,
  path: string,
  type: string,
  callback: NodeCallback<void>,
): void;
function symlink(target: string, path: string, ...args: unknown[]): void {
  settle(
    promises.symlink(
      target,
      path,
      before(args, 0, undefined) as 'file' | 'dir' | 'junction' | undefined,
    ),
    callbackOf(args),
  );
}

function truncate(path: string, callback: NodeCallback<void>): void;
function truncate(
  path: string,
  length: number,
  callback: NodeCallback<void>,
): void;
function truncate(path: string, ...args: unknown[]): void {
  settle(
    promises.truncate(path, before(args, 0, undefined) as number | undefined),
    callbackOf(args),
  );
}

function utimes(
  path: string,
  atime: Date | number | string,
  mtime: Date | number | string,
  callback: NodeCallback<void>,
): void;
function utimes(
  path: string,
  atime: Date | number | string,
  mtime: Date | number | string,
  ...args: unknown[]
): void {
  settle(promises.utimes(path, atime, mtime), callbackOf([...args]));
}

function chmod(
  path: string,
  mode: number | string,
  callback: NodeCallback<void>,
): void;
function chmod(path: string, mode: number | string, ...args: unknown[]): void {
  settle(promises.chmod(path, mode), callbackOf([...args]));
}

function mkdtemp(prefix: string, callback: NodeCallback<string>): void;
function mkdtemp(
  prefix: string,
  options: Encoding | { encoding?: Encoding },
  callback: NodeCallback<string>,
): void;
function mkdtemp(prefix: string, ...args: unknown[]): void {
  settle(
    promises.mkdtemp(
      prefix,
      before(args, 0, undefined) as
        Encoding | { encoding?: Encoding } | undefined,
    ),
    callbackOf(args),
  );
}

function open(path: string, callback: NodeCallback<FileHandle>): void;
function open(
  path: string,
  flags: string | number | OpenOptions,
  callback: NodeCallback<FileHandle>,
): void;
function open(
  path: string,
  flags: string | number | OpenOptions,
  mode: number | string,
  callback: NodeCallback<FileHandle>,
): void;
function open(path: string, ...args: unknown[]): void {
  const flags = before(args, 0, undefined) as
    string | number | OpenOptions | undefined;
  const mode = before(args, 1, undefined) as number | string | undefined;
  settle(
    mode === undefined
      ? promises.open(path, flags)
      : promises.open(path, flags, mode),
    callbackOf(args),
  );
}

function reveal(path: string, callback: NodeCallback<void>): void;
function reveal(path: string, ...args: unknown[]): void {
  settle(promises.reveal(path), callbackOf([...args]));
}

function openExternal(path: string, callback: NodeCallback<void>): void;
function openExternal(path: string, ...args: unknown[]): void {
  settle(promises.openExternal(path), callbackOf([...args]));
}

/* -------------------------------------------------------------------------- */
/* The `fs` object                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Node's `fs`, as far as this platform implements it.
 *
 * The callback forms wrap the promise implementations; the sync forms call the
 * bridge's JS-thread methods directly; `promises` is the same object shape Node
 * exposes as `fs.promises`.
 */
const fs = {
  constants,
  promises,

  readFile,
  writeFile,
  appendFile,
  readdir,
  stat,
  lstat,
  mkdir,
  rm,
  rename,
  copyFile,
  cp,
  access,
  realpath,
  readlink,
  symlink,
  truncate,
  utimes,
  chmod,
  mkdtemp,
  open,
  reveal,
  openExternal,

  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  statSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  rmSync,
  renameSync,
  copyFileSync,

  Stats,
  Dirent,
  FileHandle,
};

export default fs;
