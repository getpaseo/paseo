import { promises as fs, paths } from "@react-native-gpui/fs";
import Desktop from "../desktop/src/NativePaseoDesktop";

let writes = Promise.resolve();
const directory = () => `${paths.appData}/paseo-gpui/storage`;
const filename = (key) => `${directory()}/${Desktop.sha256(key)}.json`;
async function read(key) {
  try {
    return JSON.parse(await fs.readFile(filename(key), "utf8")).value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function mutate(operation) {
  const result = writes.then(operation);
  writes = result.catch(() => {});
  return result;
}
async function write(key, value) {
  await fs.mkdir(directory(), { recursive: true });
  const target = filename(key);
  await fs.writeFile(`${target}.tmp`, JSON.stringify({ key, value }), "utf8");
  await fs.rename(`${target}.tmp`, target);
}
async function keys() {
  let entries;
  try {
    entries = await fs.readdir(directory());
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(
    entries
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => JSON.parse(await fs.readFile(`${directory()}/${name}`, "utf8")).key),
  );
}
const storage = {
  async getItem(key) {
    await writes;
    return read(key);
  },
  setItem(key, value) {
    return mutate(() => write(key, value));
  },
  removeItem(key) {
    return mutate(() => fs.rm(filename(key), { force: true }));
  },
  async getAllKeys() {
    await writes;
    return keys();
  },
  async multiGet(items) {
    await writes;
    return Promise.all(items.map(async (key) => [key, await read(key)]));
  },
  multiSet(items) {
    return mutate(async () => {
      for (const [key, value] of items) await write(key, value);
    });
  },
  multiRemove(items) {
    return mutate(async () => {
      for (const key of items) await fs.rm(filename(key), { force: true });
    });
  },
  clear() {
    return mutate(() => fs.rm(directory(), { recursive: true, force: true }));
  },
};
export default storage;
