/**
 * `Stats` and `Dirent`, built over the plain objects the native module returns.
 *
 * The module crosses the bridge with numbers rather than methods — a generated
 * TurboModule result cannot carry predicates — so the classes live here and
 * reproduce the shape Node's callers test for. The `kind` field is the coarse
 * classification the native side can make without a platform syscall; `mode` is
 * there for the finer predicates, and is zero on Windows where there are no
 * Unix mode bits at all.
 */

import { constants } from './constants';

/** The native `FileKind` numbers; must match `module::kind` in Rust. */
export const FILE_KIND = {
  file: 0,
  directory: 1,
  symlink: 2,
  other: 3,
} as const;

/** The shape `stat`, `lstat` and `fstat` return across the bridge. */
export interface StatResult {
  size: number;
  mode: number;
  kind: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  dev: number;
  ino: number;
  nlink: number;
  uid: number;
  gid: number;
}

/** The shape `readdir` returns across the bridge. */
export interface DirEntryResult {
  name: string;
  kind: number;
  parentPath: string;
}

/** The type bits of a mode, or 0 when the platform does not report them. */
function fileTypeBits(mode: number): number {
  return mode & constants.S_IFMT;
}

/**
 * Node's `fs.Stats`.
 *
 * The fields are plain properties rather than getters: they are copied once from
 * the native result, and a caller destructuring the object sees the same values
 * Node's does.
 */
export class Stats {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  readonly gid: number;
  readonly rdev: number;
  readonly size: number;
  readonly blksize: number;
  readonly blocks: number;

  readonly atimeMs: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;

  readonly atime: Date;
  readonly mtime: Date;
  readonly ctime: Date;
  readonly birthtime: Date;

  /** The native classification, kept because it answers predicates the mode
   * cannot on platforms that report no type bits. */
  private readonly kind: number;

  constructor(result: StatResult) {
    this.dev = result.dev;
    this.ino = result.ino;
    this.mode = result.mode;
    this.nlink = result.nlink;
    this.uid = result.uid;
    this.gid = result.gid;
    // The native result has no `rdev`, block size or block count; Node reports
    // zero for them where the platform cannot say, so zero is the honest value.
    this.rdev = 0;
    this.size = result.size;
    this.blksize = 0;
    this.blocks = 0;

    this.atimeMs = result.atimeMs;
    this.mtimeMs = result.mtimeMs;
    this.ctimeMs = result.ctimeMs;
    this.birthtimeMs = result.birthtimeMs;

    this.atime = new Date(result.atimeMs);
    this.mtime = new Date(result.mtimeMs);
    this.ctime = new Date(result.ctimeMs);
    this.birthtime = new Date(result.birthtimeMs);

    this.kind = result.kind;
  }

  isFile(): boolean {
    const bits = fileTypeBits(this.mode);
    return bits === 0
      ? this.kind === FILE_KIND.file
      : bits === constants.S_IFREG;
  }

  isDirectory(): boolean {
    const bits = fileTypeBits(this.mode);
    return bits === 0
      ? this.kind === FILE_KIND.directory
      : bits === constants.S_IFDIR;
  }

  isSymbolicLink(): boolean {
    const bits = fileTypeBits(this.mode);
    return bits === 0
      ? this.kind === FILE_KIND.symlink
      : bits === constants.S_IFLNK;
  }

  isBlockDevice(): boolean {
    return fileTypeBits(this.mode) === constants.S_IFBLK;
  }

  isCharacterDevice(): boolean {
    return fileTypeBits(this.mode) === constants.S_IFCHR;
  }

  isFIFO(): boolean {
    return fileTypeBits(this.mode) === constants.S_IFIFO;
  }

  isSocket(): boolean {
    return fileTypeBits(this.mode) === constants.S_IFSOCK;
  }
}

/**
 * Node's `fs.Dirent`.
 *
 * `parentPath` is `''` when the caller already held the parent, matching what
 * `readdir` with `{withFileTypes: true}` produces there.
 */
export class Dirent {
  readonly name: string;
  readonly parentPath: string;
  readonly path: string;

  private readonly kind: number;

  constructor(result: DirEntryResult) {
    this.name = result.name;
    this.parentPath = result.parentPath;
    // `path` is the older name for the same field, and libraries still read it.
    this.path = result.parentPath;
    this.kind = result.kind;
  }

  isFile(): boolean {
    return this.kind === FILE_KIND.file;
  }

  isDirectory(): boolean {
    return this.kind === FILE_KIND.directory;
  }

  isSymbolicLink(): boolean {
    return this.kind === FILE_KIND.symlink;
  }

  isBlockDevice(): boolean {
    return false;
  }

  isCharacterDevice(): boolean {
    return false;
  }

  isFIFO(): boolean {
    return false;
  }

  isSocket(): boolean {
    return false;
  }
}
