/**
 * The pieces every face of the API needs: Node error objects, `file://` path
 * conversion, the encodings Node supports, and the flag/mode translation.
 *
 * Nothing here touches the native module, so it stays usable from the sync,
 * callback and promise layers without a cycle.
 */

/** Bytes in any of the shapes a caller may hand a writer. */
export type BinaryData = string | ArrayBuffer | ArrayBufferView;

/** The encodings this module implements, after aliasing. */
export type NormalizedEncoding =
  'utf8' | 'utf16le' | 'latin1' | 'base64' | 'hex';

/** The encodings accepted in an options object, with Node's aliases. */
export type Encoding =
  | 'utf8'
  | 'utf-8'
  | 'utf16le'
  | 'utf-16le'
  | 'ucs2'
  | 'ucs-2'
  | 'latin1'
  | 'binary'
  | 'ascii'
  | 'base64'
  | 'hex';

/** What a rejected call looks like: Node's `ErrnoException`. */
export interface NodeError extends Error {
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
  /** The second path of a two-path call, as Node names it on `rename` and `cp`. */
  dest?: string;
}

/** Builds an error with a code but no OS call behind it. */
export function nodeError(code: string, message: string): NodeError {
  const error = new Error(message) as NodeError;
  error.code = code;
  return error;
}

/** The error Node raises when a path is not there, in its message format. */
export function missingPath(path: string, syscall: string): NodeError {
  return nodeError(
    'ENOENT',
    `ENOENT: no such file or directory, ${syscall} '${path}'`,
  );
}

/**
 * Adds the fields only the JS side knows to an error a native call rejected
 * with.
 *
 * The Rust layer reports `code` and a Node-format message, but it deliberately
 * does not guess `syscall` — one native `stat` serves `stat` and `lstat`, and it
 * cannot know the spelling of the path the caller passed.
 */
export function withContext(
  error: unknown,
  syscall: string,
  path?: string,
): NodeError {
  const wrapped: NodeError =
    error instanceof Error
      ? (error as NodeError)
      : nodeError('EIO', String(error));
  if (wrapped.syscall === undefined) {
    wrapped.syscall = syscall;
  }
  if (path !== undefined && wrapped.path === undefined) {
    wrapped.path = path;
  }
  return wrapped;
}

/**
 * `file://` URLs to paths, leaving plain paths alone.
 *
 * Node accepts `URL` objects and `file:` strings interchangeably; this API takes
 * strings, so the conversion is textual. Percent escapes are decoded because a
 * path with a space arrives as `file:///a%20b`.
 */
export function toPath(path: string): string {
  if (!path.startsWith('file://')) {
    return path;
  }
  let rest = path.slice('file://'.length);
  // An empty or `localhost` authority is the local machine.
  if (rest.startsWith('localhost/')) {
    rest = rest.slice('localhost'.length);
  }
  const decoded = decodeURIComponent(rest);
  // `file:///C:/x` is a drive path on Windows, not a path under `/`.
  if (/^\/[A-Za-z]:[\\/]/.test(decoded)) {
    return decoded.slice(1);
  }
  return decoded;
}

/**
 * Node's bounds check for a buffer window, as `RangeError` with
 * `code = 'ERR_OUT_OF_RANGE'`.
 *
 * Both `read` and `write` take a window into a caller's buffer, and the native
 * side reads or writes `length` bytes before the result is trimmed to fit — so an
 * oversized `length` would consume bytes from the file and silently drop them
 * rather than failing. Node rejects the call instead, and its wording is
 * reproduced because callers match on it:
 *
 *   The value of "length" is out of range. It must be <= 2. Received 8
 */
export function checkBufferRange(
  buffer: Uint8Array,
  offset: number | undefined,
  length: number | undefined,
): { offset: number; length: number } {
  const start = offset ?? 0;
  if (!Number.isInteger(start) || start < 0 || start > buffer.byteLength) {
    throw nodeError(
      'ERR_OUT_OF_RANGE',
      `The value of "offset" is out of range. It must be >= 0 && <= ${buffer.byteLength}. Received ${start}`,
    );
  }
  const count = length ?? buffer.byteLength - start;
  const available = buffer.byteLength - start;
  if (!Number.isInteger(count) || count < 0 || count > available) {
    throw nodeError(
      'ERR_OUT_OF_RANGE',
      `The value of "length" is out of range. It must be <= ${available}. Received ${count}`,
    );
  }
  return { offset: start, length: count };
}

/**
 * A recursive `readdir` entry as the path Node reports.
 *
 * Node's `readdir(dir, { recursive: true })` returns paths relative to `dir`
 * — `nested/deep/leaf.txt`, not `leaf.txt` — so a caller can join them onto the
 * root and get a real path. The native side reports each entry's absolute
 * containing directory, so the relative name is what remains after removing the
 * root. A non-recursive listing names the direct children only, which is already
 * what `entry.name` holds, so this is used for the recursive case alone.
 *
 * The separator is taken from the paths themselves rather than from a platform
 * check: the native side returns native separators, and a module that reaches
 * for `process.platform` needs Node's types for a question the data already
 * answers.
 */
export function relativeEntryName(
  root: string,
  parentPath: string,
  name: string,
): string {
  const separator = root.includes('\\') ? '\\' : '/';
  const split = (value: string) => value.split(/[\\/]+/u).filter(Boolean);
  const rootParts = split(root);
  const parentParts = split(parentPath);
  // Compare from the front. A parent that does not start with the root means the
  // entry is somewhere the caller did not ask about, which should not happen, so
  // the bare name is a safer answer than a fabricated path.
  const inside = rootParts.every((part, index) => parentParts[index] === part);
  if (!inside) {
    return name;
  }
  return [...parentParts.slice(rootParts.length), name].join(separator);
}

/** The encoding name, folded to the set implemented here. */
export function normalizeEncoding(
  encoding: string | null | undefined,
): NormalizedEncoding | null {
  if (encoding === null || encoding === undefined) {
    return null;
  }
  switch (encoding.toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return 'utf8';
    case 'utf16le':
    case 'utf-16le':
    case 'ucs2':
    case 'ucs-2':
      return 'utf16le';
    case 'latin1':
    case 'binary':
    case 'ascii':
      return 'latin1';
    case 'base64':
      return 'base64';
    case 'hex':
      return 'hex';
    default:
      throw nodeError(
        'ERR_INVALID_ARG_VALUE',
        `The argument 'encoding' is invalid encoding. Received '${encoding}'`,
      );
  }
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_VALUES: Record<string, number> = (() => {
  const values: Record<string, number> = {};
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    values[BASE64_ALPHABET[index]] = index;
  }
  // The URL-safe alphabet is accepted too: `Buffer` decodes either.
  values['-'] = 62;
  values._ = 63;
  return values;
})();

function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.byteLength ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.byteLength ? bytes[index + 2] : 0;
    const triple = (first << 16) | (second << 8) | third;
    out += BASE64_ALPHABET[(triple >> 18) & 0x3f];
    out += BASE64_ALPHABET[(triple >> 12) & 0x3f];
    out +=
      index + 1 < bytes.byteLength
        ? BASE64_ALPHABET[(triple >> 6) & 0x3f]
        : '=';
    out += index + 2 < bytes.byteLength ? BASE64_ALPHABET[triple & 0x3f] : '=';
  }
  return out;
}

function decodeBase64(text: string): Uint8Array {
  const bytes: number[] = [];
  let pending = 0;
  let bits = 0;
  for (const character of text) {
    if (
      character === '=' ||
      character === '\n' ||
      character === '\r' ||
      character === ' '
    ) {
      continue;
    }
    const value = BASE64_VALUES[character];
    if (value === undefined) {
      // Node stops at the first character that is not base64 rather than
      // failing, so `Buffer.from('abc$', 'base64')` decodes the prefix.
      break;
    }
    pending = (pending << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((pending >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function encodeHex(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.byteLength; index += 1) {
    out += bytes[index].toString(16).padStart(2, '0');
  }
  return out;
}

function decodeHex(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index + 1 < text.length; index += 2) {
    const value = Number.parseInt(text.slice(index, index + 2), 16);
    if (Number.isNaN(value)) {
      break;
    }
    bytes.push(value);
  }
  return Uint8Array.from(bytes);
}

function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    // A surrogate pair is one code point; without this an emoji becomes two
    // sequences of replacement characters.
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let index = 0;
  while (index < bytes.byteLength) {
    const first = bytes[index];
    const width =
      first < 0x80
        ? 1
        : first >= 0xf0
          ? 4
          : first >= 0xe0
            ? 3
            : first >= 0xc0
              ? 2
              : 0;
    if (width === 0 || index + width > bytes.byteLength) {
      // Node decodes malformed input with U+FFFD instead of throwing, so a
      // file that is not valid UTF-8 still reads as text.
      out += '\ufffd';
      index += 1;
      continue;
    }
    let code = width === 1 ? first : first & (0xff >> (width + 1));
    let valid = true;
    for (let offset = 1; offset < width; offset += 1) {
      const continuation = bytes[index + offset];
      if ((continuation & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      code = (code << 6) | (continuation & 0x3f);
    }
    if (!valid) {
      out += '\ufffd';
      index += 1;
      continue;
    }
    out += String.fromCodePoint(code);
    index += width;
  }
  return out;
}

function encodeUtf16le(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >> 8;
  }
  return bytes;
}

function decodeUtf16le(bytes: Uint8Array): string {
  const codes: number[] = [];
  for (let index = 0; index + 1 < bytes.byteLength; index += 2) {
    codes.push(bytes[index] | (bytes[index + 1] << 8));
  }
  return chunkedFromCharCode(codes);
}

function chunkedFromCharCode(codes: number[]): string {
  let out = '';
  // `apply` has an argument-count limit, so long strings are built in pieces.
  for (let index = 0; index < codes.length; index += 8192) {
    out += String.fromCharCode.apply(null, codes.slice(index, index + 8192));
  }
  return out;
}

/** Text to bytes for the encodings implemented in JS. */
export function encodeString(
  text: string,
  encoding: NormalizedEncoding,
): Uint8Array {
  switch (encoding) {
    case 'utf8':
      return encodeUtf8(text);
    case 'utf16le':
      return encodeUtf16le(text);
    case 'latin1': {
      const bytes = new Uint8Array(text.length);
      for (let index = 0; index < text.length; index += 1) {
        bytes[index] = text.charCodeAt(index) & 0xff;
      }
      return bytes;
    }
    case 'base64':
      return decodeBase64(text);
    case 'hex':
      return decodeHex(text);
  }
}

/** Bytes to text for the encodings implemented in JS. */
export function decodeString(
  bytes: Uint8Array,
  encoding: NormalizedEncoding,
): string {
  switch (encoding) {
    case 'utf8':
      return decodeUtf8(bytes);
    case 'utf16le':
      return decodeUtf16le(bytes);
    case 'latin1': {
      const codes: number[] = [];
      for (let index = 0; index < bytes.byteLength; index += 1) {
        codes.push(bytes[index]);
      }
      return chunkedFromCharCode(codes);
    }
    case 'base64':
      return encodeBase64(bytes);
    case 'hex':
      return encodeHex(bytes);
  }
}

/**
 * Normalises any accepted data shape to an `ArrayBuffer` the bridge can send.
 *
 * A `Uint8Array` may be a window onto a larger allocation; slicing to the view's
 * own range is what stops a writer from sending bytes that belong to something
 * else in the same buffer.
 */
export function toArrayBuffer(
  data: BinaryData,
  encoding: NormalizedEncoding = 'utf8',
): ArrayBuffer {
  if (typeof data === 'string') {
    const bytes = encodeString(data, encoding);
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }
  if (data instanceof ArrayBuffer) {
    return data;
  }
  const view = data as ArrayBufferView;
  const buffer = view.buffer as ArrayBuffer;
  if (view.byteOffset === 0 && view.byteLength === buffer.byteLength) {
    return buffer;
  }
  return buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/** A byte view of `toArrayBuffer`'s result, without copying. */
export function toBytes(
  data: BinaryData,
  encoding: NormalizedEncoding = 'utf8',
): Uint8Array {
  return new Uint8Array(toArrayBuffer(data, encoding));
}

/** Node's numeric `open` flags, by their string spelling. */
const FLAG_STRINGS: Record<string, number> = {
  r: 0,
  'r+': 2,
  rs: 0,
  sr: 0,
  w: 1 | 64 | 512,
  wx: 1 | 64 | 512 | 128,
  xw: 1 | 64 | 512 | 128,
  'w+': 2 | 64 | 512,
  'wx+': 2 | 64 | 512 | 128,
  'xw+': 2 | 64 | 512 | 128,
  a: 1 | 64 | 1024,
  ax: 1 | 64 | 1024 | 128,
  xa: 1 | 64 | 1024 | 128,
  'a+': 2 | 64 | 1024,
  'ax+': 2 | 64 | 1024 | 128,
  'xa+': 2 | 64 | 1024 | 128,
  as: 1 | 64 | 1024,
  sa: 1 | 64 | 1024,
};

/** A `flag` option as the number the native side decodes. */
export function flagFrom(
  flag: string | number | undefined,
  fallback: number,
): number {
  if (flag === undefined) {
    return fallback;
  }
  if (typeof flag === 'number') {
    return flag;
  }
  const value = FLAG_STRINGS[flag];
  if (value === undefined) {
    throw nodeError(
      'ERR_INVALID_ARG_VALUE',
      `The argument 'flag' is invalid. Received '${flag}'`,
    );
  }
  return value;
}

/** A `mode` option as a number. A string is octal, as in Node. */
export function modeFrom(
  mode: number | string | undefined,
  fallback = 0o666,
): number {
  if (mode === undefined) {
    return fallback;
  }
  if (typeof mode === 'number') {
    return mode;
  }
  const parsed = Number.parseInt(mode, 8);
  if (Number.isNaN(parsed)) {
    throw nodeError(
      'ERR_INVALID_ARG_VALUE',
      `The argument 'mode' is invalid. Received '${mode}'`,
    );
  }
  return parsed;
}
