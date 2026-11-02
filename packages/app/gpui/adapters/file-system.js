import fs, { promises, paths } from "@react-native-gpui/fs";
import { Buffer } from "buffer";
const pathOf = (value) => String(value?.uri ?? value).replace(/^file:\/\//, "");
const join = (parts) =>
  parts
    .map(pathOf)
    .join("/")
    .replace(/\/{2,}/g, "/");
export const cacheDirectory = `file://${paths.appCache}/paseo-gpui/`;
export const documentDirectory = `file://${paths.appData}/paseo-gpui/`;
export const EncodingType = { Base64: "base64", UTF8: "utf8" };
export const Paths = { cache: cacheDirectory, document: documentDirectory };
export async function getInfoAsync(uri) {
  try {
    const stat = await promises.stat(pathOf(uri));
    return { exists: true, isDirectory: stat.isDirectory(), size: stat.size, uri };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, uri };
    throw error;
  }
}
export const makeDirectoryAsync = (uri, options = {}) =>
  promises.mkdir(pathOf(uri), { recursive: options.intermediates });
export const copyAsync = ({ from, to }) => promises.copyFile(pathOf(from), pathOf(to));
export const moveAsync = ({ from, to }) => promises.rename(pathOf(from), pathOf(to));
export const readAsStringAsync = (uri, options = {}) =>
  promises.readFile(pathOf(uri), options.encoding ?? "utf8");
export const writeAsStringAsync = (uri, contents, options = {}) =>
  promises.writeFile(pathOf(uri), contents, options.encoding ?? "utf8");
export const deleteAsync = (uri, options = {}) =>
  promises.rm(pathOf(uri), { recursive: true, force: options.idempotent });
export const readDirectoryAsync = (uri) => promises.readdir(pathOf(uri));
export class File {
  constructor(...parts) {
    this.uri = `file://${join(parts)}`;
  }
  get name() {
    return pathOf(this).split("/").at(-1);
  }
  get exists() {
    return fs.existsSync(pathOf(this));
  }
  get size() {
    return fs.statSync(pathOf(this)).size;
  }
  create({ overwrite = false, intermediates = false } = {}) {
    if (intermediates)
      fs.mkdirSync(pathOf(this).split("/").slice(0, -1).join("/"), { recursive: true });
    fs.writeFileSync(pathOf(this), "", { flag: overwrite ? "w" : "wx" });
  }
  write(value) {
    fs.writeFileSync(pathOf(this), value);
  }
  delete() {
    fs.rmSync(pathOf(this));
  }
  async bytes() {
    return promises.readFile(pathOf(this));
  }
  async arrayBuffer() {
    const bytes = await this.bytes();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  async base64() {
    return Buffer.from(await this.bytes()).toString("base64");
  }
  async text() {
    return promises.readFile(pathOf(this), "utf8");
  }
  move(destination) {
    fs.renameSync(pathOf(this), pathOf(destination));
    this.uri = destination.uri;
  }
  copy(destination) {
    fs.copyFileSync(pathOf(this), pathOf(destination));
  }
  static async downloadFileAsync(url, destination) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const file = destination instanceof File ? destination : new File(destination);
    await promises.writeFile(pathOf(file), new Uint8Array(await response.arrayBuffer()));
    return file;
  }
}
export class Directory {
  constructor(...parts) {
    this.uri = `file://${join(parts)}`;
  }
  get exists() {
    return fs.existsSync(pathOf(this));
  }
  create({ intermediates = false } = {}) {
    fs.mkdirSync(pathOf(this), { recursive: intermediates });
  }
  delete() {
    fs.rmSync(pathOf(this), { recursive: true });
  }
  list() {
    return fs
      .readdirSync(pathOf(this), { withFileTypes: true })
      .map((entry) =>
        entry.isDirectory() ? new Directory(this, entry.name) : new File(this, entry.name),
      );
  }
}

export function createDownloadResumable(url, uri, options = {}, onProgress) {
  const controller = new AbortController();
  return {
    async downloadAsync() {
      const response = await fetch(url, { headers: options.headers, signal: controller.signal });
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const target = pathOf(uri);
      await promises.mkdir(target.split("/").slice(0, -1).join("/"), { recursive: true });
      await promises.writeFile(`${target}.part`, bytes);
      await promises.rename(`${target}.part`, target);
      onProgress?.({ totalBytesWritten: bytes.length, totalBytesExpectedToWrite: bytes.length });
      return {
        uri,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      };
    },
    async cancelAsync() {
      controller.abort();
    },
  };
}
