/**
 * `fs.promises`: the Node-shaped asynchronous face of the module.
 *
 * Every call here is a thin translation. The native side does the work on its own
 * thread and reports Node codes, so this layer's job is argument shapes, the
 * encodings Node implements above the bytes, and the fields (`syscall`, `path`,
 * `dest`) that only a wrapper can know.
 */

import NativeFs from './NativeFs';
import { constants } from './constants';
import {
  checkBufferRange,
  decodeString,
  encodeString,
  flagFrom,
  modeFrom,
  nodeError,
  normalizeEncoding,
  relativeEntryName,
  toArrayBuffer,
  toBytes,
  toPath,
  withContext,
  type BinaryData,
  type Encoding,
  type NormalizedEncoding,
} from './shared';
import { Dirent, Stats, type DirEntryResult, type StatResult } from './stats';

/** An encoding, an options object, or nothing, as Node accepts for reads. */
export type ReadOptions =
  Encoding | { encoding?: Encoding | null } | null | undefined;

export interface WriteOptions {
  encoding?: Encoding | null;
  mode?: number | string;
  flag?: string | number;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: number | string;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface ReaddirOptions {
  withFileTypes?: boolean;
  recursive?: boolean;
}

export interface CpOptions {
  recursive?: boolean;
}

export interface OpenOptions {
  flags?: string | number;
  mode?: number | string;
}

/** The chunk size for a read that has no caller-supplied buffer. */
const READ_CHUNK = 64 * 1024;

/** A time as Node accepts one: `Date`, milliseconds, or a date string. */
export type TimeLike = Date | number | string;

function toMillis(value: TimeLike, name: string): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
    return value;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw nodeError(
      'ERR_INVALID_ARG_VALUE',
      `The argument '${name}' is invalid time. Received '${value}'`,
    );
  }
  return parsed;
}

function encodingOf(options: ReadOptions): NormalizedEncoding | null {
  if (typeof options === 'string') {
    return normalizeEncoding(options);
  }
  return normalizeEncoding(options?.encoding ?? null);
}

/**
 * `readFile`, in whichever of the two shapes the caller asked for.
 *
 * UTF-8 goes through the dedicated text method: the native side decodes it while
 * the bytes are still in Rust, so a text read never allocates an `ArrayBuffer`
 * that JS then copies. Every other encoding is decoded here, because Node's
 * `utf16le`, `latin1`, `base64` and `hex` are JS-level conventions rather than
 * something `std::fs` has an opinion about.
 */
function readFile(path: string): Promise<Uint8Array>;
function readFile(
  path: string,
  options: { encoding?: null } | null | undefined,
): Promise<Uint8Array>;
function readFile(
  path: string,
  options: Encoding | { encoding: Encoding },
): Promise<string>;
async function readFile(
  path: string,
  options?: ReadOptions,
): Promise<Uint8Array | string> {
  const target = toPath(path);
  const encoding = encodingOf(options);
  try {
    if (encoding === 'utf8') {
      return await NativeFs.readTextFile(target);
    }
    const buffer = await NativeFs.readFile(target);
    const bytes = new Uint8Array(buffer);
    return encoding === null ? bytes : decodeString(bytes, encoding);
  } catch (error) {
    throw withContext(error, 'open', target);
  }
}

/**
 * The same read, typed coarsely.
 *
 * `readFile`'s public overloads are what a caller sees; the callback layer calls
 * through this alias because at that point the encoding is a runtime value and
 * the result is genuinely either shape.
 */
export const readFileImpl: (
  path: string,
  options?: ReadOptions,
) => Promise<Uint8Array | string> = readFile;

/**
 * `writeFile`.
 *
 * A string is written through `writeTextFile` when it is UTF-8; anything else —
 * a different encoding, or binary data — is normalised to an `ArrayBuffer` and
 * sent through the byte method.
 */
async function writeFile(
  path: string,
  data: BinaryData,
  options?: WriteOptions | Encoding,
): Promise<void> {
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
      // `normalizeEncoding` answers `null` only when it is given nothing, and a
      // default is supplied here, so the fallback to `utf8` is unreachable — it
      // exists to keep the type honest instead of asserting it away.
      const encoding = normalizeEncoding(opts.encoding ?? 'utf8') ?? 'utf8';
      if (encoding === 'utf8') {
        await NativeFs.writeTextFile(target, data, flag, mode);
      } else {
        await NativeFs.writeFile(
          target,
          toArrayBuffer(encodeString(data, encoding)),
          flag,
          mode,
        );
      }
      return;
    }
    await NativeFs.writeFile(target, toArrayBuffer(data), flag, mode);
  } catch (error) {
    throw withContext(error, 'open', target);
  }
}

async function appendFile(
  path: string,
  data: BinaryData,
  options?: WriteOptions | Encoding,
): Promise<void> {
  const opts: WriteOptions =
    typeof options === 'string' ? { encoding: options } : (options ?? {});
  return writeFile(path, data, {
    ...opts,
    flag:
      opts.flag ?? constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
  });
}

function readdir(
  path: string,
  options?: { withFileTypes?: false; recursive?: boolean } | null,
): Promise<string[]>;
function readdir(
  path: string,
  options: { withFileTypes: true; recursive?: boolean },
): Promise<Dirent[]>;
async function readdir(
  path: string,
  options?: ReaddirOptions | null,
): Promise<string[] | Dirent[]> {
  const target = toPath(path);
  try {
    const recursive = options?.recursive ?? false;
    const entries = await NativeFs.readdir(target, recursive);
    return options?.withFileTypes
      ? entries.map(entry => new Dirent(entry as DirEntryResult))
      : entries.map(entry =>
          recursive
            ? relativeEntryName(target, entry.parentPath, entry.name)
            : entry.name,
        );
  } catch (error) {
    throw withContext(error, 'scandir', target);
  }
}

async function stat(path: string): Promise<Stats> {
  const target = toPath(path);
  try {
    return new Stats((await NativeFs.stat(target, true)) as StatResult);
  } catch (error) {
    throw withContext(error, 'stat', target);
  }
}

async function lstat(path: string): Promise<Stats> {
  const target = toPath(path);
  try {
    return new Stats((await NativeFs.stat(target, false)) as StatResult);
  } catch (error) {
    throw withContext(error, 'lstat', target);
  }
}

async function mkdir(
  path: string,
  options?: MkdirOptions | number,
): Promise<string | undefined> {
  const target = toPath(path);
  const opts: MkdirOptions =
    typeof options === 'number' ? { mode: options } : (options ?? {});
  try {
    await NativeFs.mkdir(
      target,
      opts.recursive ?? false,
      modeFrom(opts.mode, 0o777),
    );
    return undefined;
  } catch (error) {
    throw withContext(error, 'mkdir', target);
  }
}

async function rm(path: string, options?: RmOptions): Promise<void> {
  const target = toPath(path);
  try {
    await NativeFs.rm(
      target,
      options?.recursive ?? false,
      options?.force ?? false,
    );
  } catch (error) {
    throw withContext(error, 'rm', target);
  }
}

async function rename(from: string, to: string): Promise<void> {
  const source = toPath(from);
  const destination = toPath(to);
  try {
    await NativeFs.rename(source, destination);
  } catch (error) {
    // Node's rename error names both ends; the second is `dest`, not `path`.
    const wrapped = withContext(error, 'rename', source);
    if (wrapped.dest === undefined) {
      wrapped.dest = destination;
    }
    throw wrapped;
  }
}

async function copyFile(
  from: string,
  to: string,
  mode?: number,
): Promise<void> {
  const source = toPath(from);
  const destination = toPath(to);
  if (mode !== undefined && (mode & constants.COPYFILE_EXCL) !== 0) {
    // The native copy has no exclusive flag, so the check is made here. It is
    // advisory — a file created between the two calls still wins — but it gives
    // the caller the error Node promises for the ordinary case.
    try {
      await NativeFs.stat(destination, false);
      throw nodeError(
        'EEXIST',
        `EEXIST: file already exists, copyfile '${source}' -> '${destination}'`,
      );
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  try {
    await NativeFs.copy(source, destination, false);
  } catch (error) {
    const wrapped = withContext(error, 'copyfile', source);
    if (wrapped.dest === undefined) {
      wrapped.dest = destination;
    }
    throw wrapped;
  }
}

async function cp(
  from: string,
  to: string,
  options?: CpOptions,
): Promise<void> {
  const source = toPath(from);
  const destination = toPath(to);
  try {
    await NativeFs.copy(source, destination, options?.recursive ?? false);
  } catch (error) {
    const wrapped = withContext(error, 'cp', source);
    if (wrapped.dest === undefined) {
      wrapped.dest = destination;
    }
    throw wrapped;
  }
}

async function access(path: string, mode?: number): Promise<void> {
  const target = toPath(path);
  try {
    await NativeFs.access(target, mode ?? constants.F_OK);
  } catch (error) {
    throw withContext(error, 'access', target);
  }
}

async function realpath(path: string): Promise<string> {
  const target = toPath(path);
  try {
    return await NativeFs.realpath(target);
  } catch (error) {
    throw withContext(error, 'realpath', target);
  }
}

async function readlink(path: string): Promise<string> {
  const target = toPath(path);
  try {
    return await NativeFs.readlink(target);
  } catch (error) {
    throw withContext(error, 'readlink', target);
  }
}

async function symlink(
  target: string,
  path: string,
  type?: 'file' | 'dir' | 'junction',
): Promise<void> {
  // `type` is passed through rather than dropped. It is the only way to ask for a
  // directory link on Windows, where creating one as a file link leaves a path
  // that cannot be traversed; Unix ignores it, as the syscall does.
  const link = toPath(path);
  try {
    await NativeFs.symlink(toPath(target), link, type ?? null);
  } catch (error) {
    throw withContext(error, 'symlink', link);
  }
}

async function truncate(path: string, length?: number): Promise<void> {
  const target = toPath(path);
  try {
    await NativeFs.truncate(target, length ?? 0);
  } catch (error) {
    throw withContext(error, 'truncate', target);
  }
}

async function utimes(
  path: string,
  atime: TimeLike,
  mtime: TimeLike,
): Promise<void> {
  const target = toPath(path);
  try {
    await NativeFs.utimes(
      target,
      toMillis(atime, 'atime'),
      toMillis(mtime, 'mtime'),
    );
  } catch (error) {
    throw withContext(error, 'utime', target);
  }
}

async function chmod(path: string, mode: number | string): Promise<void> {
  const target = toPath(path);
  try {
    await NativeFs.chmod(target, modeFrom(mode));
  } catch (error) {
    throw withContext(error, 'chmod', target);
  }
}

async function mkdtemp(
  prefix: string,
  options?: Encoding | { encoding?: Encoding },
): Promise<string> {
  // The native side creates the directory under the system temp directory and
  // returns the path; the encoding only affects how a non-ASCII prefix arrives,
  // and every string crosses the bridge as UTF-8.
  options;
  try {
    return await NativeFs.mkdtemp(toPath(prefix));
  } catch (error) {
    throw withContext(error, 'mkdtemp', prefix);
  }
}

/**
 * A descriptor plus the operations Node puts on `FileHandle`.
 *
 * Positioned reads and writes do not touch the file's offset, which is what
 * makes concurrent chunked I/O safe: two readers on one handle cannot move each
 * other's cursor.
 */
export class FileHandle {
  /** The native descriptor. */
  readonly fd: number;
  private closed = false;

  constructor(fd: number) {
    this.fd = fd;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw nodeError('EBADF', `EBADF: bad file descriptor, ${this.fd}`);
    }
  }

  /** Reads from the current offset when `position` is `-1`. */
  async read(): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  async read(options: {
    buffer?: Uint8Array;
    offset?: number;
    length?: number;
    position?: number | null;
  }): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  async read(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  /**
   * Node's positional form with the buffer implied: `read(size, offset, length,
   * position)`. `offset` and `length` are a window into the freshly allocated
   * buffer, and a missing `position` reads from the cursor.
   */
  async read(
    size: number,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  async read(
    first?:
      | number
      | Uint8Array
      | {
          buffer?: Uint8Array;
          offset?: number;
          length?: number;
          position?: number | null;
        },
    second?: number,
    third?: number,
    fourth?: number | null,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
    this.assertOpen();
    let destination: Uint8Array;
    let offset = 0;
    let length: number;
    let position: number;
    // The two no-buffer forms mean "read to the end", which is a different
    // operation from a single bounded read and is handled by `readToEnd`.
    let toEnd = false;
    if (first === undefined) {
      toEnd = true;
      destination = new Uint8Array(0);
      length = 0;
      position = -1;
    } else if (typeof first === 'number') {
      // A size instead of a buffer: allocate it and apply the same window
      // arguments Node's buffer form takes.
      destination = new Uint8Array(first);
      offset = second ?? 0;
      length = third ?? Math.max(destination.byteLength - offset, 0);
      position = fourth ?? -1;
    } else if (first instanceof Uint8Array) {
      destination = first;
      offset = second ?? 0;
      length = third ?? destination.byteLength - offset;
      position = fourth ?? -1;
    } else {
      destination = first.buffer ?? new Uint8Array(0);
      offset = first.offset ?? 0;
      length = first.length ?? Math.max(destination.byteLength - offset, 0);
      position = first.position ?? -1;
      toEnd = first.buffer === undefined;
    }

    try {
      if (toEnd) {
        const bytes = await this.readToEnd(position);
        return { bytesRead: bytes.byteLength, buffer: bytes };
      }
      // Validated before the native call, not after. The native side reads
      // `length` bytes and advances the cursor, so a window that overruns the
      // buffer used to consume bytes and then drop them when the result was
      // trimmed to fit. Node rejects the call instead, and so must this.
      const window = checkBufferRange(destination, offset, length);
      const buffer = await NativeFs.read(this.fd, window.length, position);
      const bytes = new Uint8Array(buffer);
      const bytesRead = Math.min(bytes.byteLength, window.length);
      destination.set(bytes.subarray(0, bytesRead), window.offset);
      return { bytesRead, buffer: destination };
    } catch (error) {
      throw withContext(error, 'read', undefined);
    }
  }

  /**
   * Reads until a short read, which is end of file.
   *
   * The native `read` returns at most what it was asked for, so "the rest of the
   * file" has to be assembled: a single call with a huge length would ask Rust to
   * allocate that much up front. A cursor read (`position` -1) advances the
   * handle's offset, so the loop continues where the previous chunk ended.
   */
  private async readToEnd(position: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let at = position;
    for (;;) {
      const buffer = await NativeFs.read(this.fd, READ_CHUNK, at);
      const chunk = new Uint8Array(buffer);
      if (chunk.byteLength === 0) {
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < READ_CHUNK) {
        break;
      }
      if (at >= 0) {
        at += chunk.byteLength;
      }
    }
    const all = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      all.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return all;
  }

  async write(
    data: BinaryData,
    position?: number | null,
    encoding?: Encoding,
  ): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
  async write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position?: number | null,
  ): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
  async write(
    data: BinaryData,
    second?: number | null,
    third?: number | Encoding,
    fourth?: number | null,
  ): Promise<{ bytesWritten: number; buffer: Uint8Array }> {
    this.assertOpen();
    let bytes: Uint8Array;
    let position: number | null = null;
    if (typeof data === 'string') {
      // `write(string, position, encoding)`: here the number is a file position.
      const encodingName =
        typeof third === 'string' ? normalizeEncoding(third) : 'utf8';
      bytes = encodeString(data, encodingName ?? 'utf8');
      position = second ?? null;
    } else if (
      data instanceof Uint8Array &&
      third !== undefined &&
      typeof third !== 'number'
    ) {
      // `write(buffer, { offset, length, position })`, which Node also accepts.
      const options = third as unknown as {
        offset?: number;
        length?: number;
        position?: number | null;
      };
      const window = checkBufferRange(data, options.offset, options.length);
      bytes = data.subarray(window.offset, window.offset + window.length);
      position = options.position ?? null;
    } else if (
      data instanceof Uint8Array &&
      second !== undefined &&
      second !== null
    ) {
      // `write(buffer, offset[, length[, position]])` — the numeric argument is
      // into the *buffer*, not into the file. Reading it as a file position
      // wrote the whole buffer at that offset instead of a slice at the cursor.
      const window = checkBufferRange(
        data,
        second,
        typeof third === 'number' ? third : undefined,
      );
      bytes = data.subarray(window.offset, window.offset + window.length);
      position = fourth ?? null;
    } else {
      bytes = toBytes(data);
      position = typeof second === 'number' ? second : null;
    }
    try {
      const bytesWritten = await NativeFs.write(
        this.fd,
        toArrayBuffer(bytes),
        position ?? -1,
      );
      return { bytesWritten, buffer: bytes };
    } catch (error) {
      throw withContext(error, 'write', undefined);
    }
  }

  async stat(): Promise<Stats> {
    this.assertOpen();
    try {
      return new Stats((await NativeFs.fstat(this.fd)) as StatResult);
    } catch (error) {
      throw withContext(error, 'fstat', undefined);
    }
  }

  async sync(): Promise<void> {
    this.assertOpen();
    try {
      await NativeFs.fsync(this.fd);
    } catch (error) {
      throw withContext(error, 'fsync', undefined);
    }
  }

  async truncate(length?: number): Promise<void> {
    this.assertOpen();
    try {
      await NativeFs.ftruncate(this.fd, length ?? 0);
    } catch (error) {
      throw withContext(error, 'ftruncate', undefined);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await NativeFs.close(this.fd);
    } catch (error) {
      throw withContext(error, 'close', undefined);
    }
  }
}

async function open(
  path: string,
  flags?: string | number | OpenOptions,
  mode?: number | string,
): Promise<FileHandle> {
  const target = toPath(path);
  const opts: OpenOptions =
    typeof flags === 'object' && flags !== null ? flags : { flags, mode };
  const flag = flagFrom(opts.flags, constants.O_RDONLY);
  try {
    const fd = await NativeFs.open(target, flag, modeFrom(opts.mode));
    return new FileHandle(fd);
  } catch (error) {
    throw withContext(error, 'open', target);
  }
}

async function reveal(path: string): Promise<void> {
  const target = toPath(path);
  try {
    await NativeFs.reveal(target);
  } catch (error) {
    throw withContext(error, 'reveal', target);
  }
}

async function openExternal(path: string): Promise<void> {
  const target = toPath(path);
  try {
    await NativeFs.openExternal(target);
  } catch (error) {
    throw withContext(error, 'openExternal', target);
  }
}

/**
 * The `fs/promises` object.
 *
 * The functions are declared separately and collected here so the callback layer
 * in `index.ts` can wrap the same implementations rather than reimplementing
 * them.
 */
export const promises = {
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
};

export type Promises = typeof promises;

/** Re-exported so `fs.stat` and `fs.promises.stat` share one class identity. */
export { Dirent, Stats };
export type { StatResult };
