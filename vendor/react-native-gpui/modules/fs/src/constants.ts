/**
 * `fs.constants`, with Node's numbers.
 *
 * The `O_*` values are Node's table rather than the platform's `open(2)` flags,
 * because that is what the Rust side decodes: it translates them into
 * `OpenOptions` instead of passing them through. The numbers here must stay in
 * step with `modules/fs/desktop/src/module.rs`, which owns the other half of the
 * contract.
 */

export const constants = {
  // `access` modes.
  F_OK: 0,
  X_OK: 1,
  W_OK: 2,
  R_OK: 4,

  // `open` flags.
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_TRUNC: 512,
  O_APPEND: 1024,

  // `copyFile` modes.
  COPYFILE_EXCL: 1,

  // File-type bits, for the predicates on `Stats` that cannot be answered from
  // the module's coarse `kind` alone (a socket and a block device are both
  // "other" there).
  S_IFMT: 0o170000,
  S_IFREG: 0o100000,
  S_IFDIR: 0o040000,
  S_IFLNK: 0o120000,
  S_IFBLK: 0o060000,
  S_IFCHR: 0o020000,
  S_IFIFO: 0o010000,
  S_IFSOCK: 0o140000,
} as const;

export type Constants = typeof constants;
