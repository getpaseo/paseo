import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * How a path entry is classified: 0 file, 1 directory, 2 symlink, 3 other.
 *
 * A plain number rather than a string or enum so it crosses the bridge without a
 * lookup table and survives being read back out of a plain object in JS.
 */
export type FileKind = number;

export type StatResult = {
  size: number;
  mode: number;
  kind: FileKind;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  dev: number;
  ino: number;
  nlink: number;
  uid: number;
  gid: number;
};

export type DirEntry = {
  name: string;
  kind: FileKind;
  parentPath: string;
};

export type DialogFilter = {
  name: string;
  extensions: Array<string>;
};

export type OpenDialogOptions = {
  title?: string;
  defaultPath?: string;
  multiple: boolean;
  directory: boolean;
  filters: Array<DialogFilter>;
};

export type SaveDialogOptions = {
  title?: string;
  defaultPath?: string;
  defaultName?: string;
  filters: Array<DialogFilter>;
};

export type KnownPaths = {
  home: string;
  documents: string;
  downloads: string;
  desktop: string;
  temp: string;
  appData: string;
  appCache: string;
  appLogs: string;
};

export type WatchEvent = {
  id: number;
  kind: string;
  path: string;
};

export type DownloadHeader = {
  name: string;
  value: string;
};

export type DownloadOptions = {
  id: number;
  method: string;
  headers: Array<DownloadHeader>;
};

/**
 * What a download resolves with. A non-2xx answer is not an error here: it
 * comes back with its `status` and a small `body`, and no file is written.
 */
export type DownloadResult = {
  status: number;
  headers: Array<DownloadHeader>;
  bytes: number;
  body?: string;
};

export type DownloadProgress = {
  id: number;
  received: number;
  // -1 when the server did not say how long the body is.
  total: number;
};

export type UploadOptions = {
  id: number;
  method: string;
  headers: Array<DownloadHeader>;
  // Where in the file the body starts.
  offset: number;
  // How many bytes to send; -1 sends everything from `offset`.
  length: number;
};

/**
 * What an upload resolves with. Any status is a result; `body` is the first
 * part of the response.
 */
export type UploadResult = {
  status: number;
  headers: Array<DownloadHeader>;
  body: string;
};

export type UploadProgress = {
  id: number;
  sent: number;
  total: number;
};

/**
 * The file system module: one instance, on its own thread, so a slow file never
 * blocks JS or the UI.
 *
 * A method that returns a value runs on the JS thread; `void` and `Promise`
 * methods run on the module's thread. The writers below therefore return
 * `boolean` — a `void` method would be moved off the JS thread, which is wrong
 * for a `*Sync` call. They always return true and throw on failure.
 */
export interface Spec extends TurboModule {
  // Text is separate from bytes so a `utf8` read or write needs no buffer.
  readFile(path: string): Promise<ArrayBuffer>;
  readTextFile(path: string): Promise<string>;
  writeFile(
    path: string,
    data: ArrayBuffer,
    flags: number,
    mode: number,
  ): Promise<void>;
  writeTextFile(
    path: string,
    data: string,
    flags: number,
    mode: number,
  ): Promise<void>;

  readdir(path: string, recursive: boolean): Promise<Array<DirEntry>>;
  // `followSymlinks` false is `lstat`.
  stat(path: string, followSymlinks: boolean): Promise<StatResult>;
  mkdir(path: string, recursive: boolean, mode: number): Promise<void>;
  rm(path: string, recursive: boolean, force: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copy(from: string, to: string, recursive: boolean): Promise<void>;
  access(path: string, mode: number): Promise<void>;
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  // `type` is Node's, and only Windows acts on it: `'dir'` and `'junction'`
  // create a directory link, `null` decides from the resolved target, and a
  // plain `'file'` is a file link. Unix ignores it, because the syscall does.
  // Without it a Windows directory link was created as a file link and could
  // not be traversed.
  symlink(target: string, path: string, type: string | null): Promise<void>;
  truncate(path: string, length: number): Promise<void>;
  utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;

  // File handles. `position` -1 means "at the current offset".
  open(path: string, flags: number, mode: number): Promise<number>;
  read(fd: number, length: number, position: number): Promise<ArrayBuffer>;
  write(fd: number, data: ArrayBuffer, position: number): Promise<number>;
  fstat(fd: number): Promise<StatResult>;
  fsync(fd: number): Promise<void>;
  ftruncate(fd: number, length: number): Promise<void>;
  close(fd: number): Promise<void>;

  showOpenDialog(options: OpenDialogOptions): Promise<Array<string>>;
  showSaveDialog(options: SaveDialogOptions): Promise<string | null>;
  reveal(path: string): Promise<void>;
  openExternal(path: string): Promise<void>;

  // Returns the watcher id; events arrive through `onWatchEvent`.
  watch(path: string, recursive: boolean): Promise<number>;
  unwatch(id: number): void;

  readFileSync(path: string): ArrayBuffer;
  readTextFileSync(path: string): string;
  writeFileSync(
    path: string,
    data: ArrayBuffer,
    flags: number,
    mode: number,
  ): boolean;
  writeTextFileSync(
    path: string,
    data: string,
    flags: number,
    mode: number,
  ): boolean;
  statSync(path: string, followSymlinks: boolean): StatResult | null;
  existsSync(path: string): boolean;
  readdirSync(path: string, recursive: boolean): Array<DirEntry>;
  mkdirSync(path: string, recursive: boolean, mode: number): boolean;
  rmSync(path: string, recursive: boolean, force: boolean): boolean;
  renameSync(from: string, to: string): boolean;
  copyFileSync(from: string, to: string): boolean;

  download(
    url: string,
    path: string,
    options: DownloadOptions,
  ): Promise<DownloadResult>;
  // Returns whether a download with that id was running.
  cancelDownload(id: number): boolean;

  upload(
    url: string,
    path: string,
    options: UploadOptions,
  ): Promise<UploadResult>;
  // Returns whether an upload with that id was running.
  cancelUpload(id: number): boolean;

  getPaths(): KnownPaths;

  readonly onWatchEvent: CodegenTypes.EventEmitter<WatchEvent>;
  readonly onDownloadProgress: CodegenTypes.EventEmitter<DownloadProgress>;
  readonly onUploadProgress: CodegenTypes.EventEmitter<UploadProgress>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('RNFsModule');
