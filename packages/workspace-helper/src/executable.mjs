#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { constants, watch } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const outsideMessage = "Access outside of workspace is not allowed";
const imageTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);
const operation = process.argv[2];
let argumentsByName = new Map();
const argument = (name, fallback) => argumentsByName.get(name) ?? fallback;
const root = await realpath(".");

try {
  if (!operation) throw new Error("Usage: workspace-helper <command>");
  argumentsByName = parseArguments(operation, process.argv.slice(3));
  if (operation === "fs-stat") print(await fileStat(root, argument("--path", ".")));
  else if (operation === "fs-list") print(await list(root, argument("--path", ".")));
  else if (operation === "fs-read") await read(root, argument("--path"));
  else if (operation === "fs-write") await write(root, argument("--path"));
  else if (operation === "fs-create-entry")
    print(
      await createEntry(
        root,
        argument("--parent-path", "."),
        argument("--name"),
        argument("--kind"),
      ),
    );
  else if (operation === "fs-rename-entry")
    print(await renameEntry(root, argument("--path"), argument("--name")));
  else if (operation === "fs-duplicate-entry")
    print(await duplicateEntry(root, argument("--path")));
  else if (operation === "fs-delete-entry") print(await deleteEntry(root, argument("--path")));
  else if (operation === "watch") await runWatcher(root);
  else if (operation === "resolve-command")
    print({ path: await resolveCommand(root, argument("--name")) });
  else if (operation === "describe")
    print({ version: 1, capabilities: ["files", "watch", "resolve-command"] });
  else throw new Error(`Unknown workspace-helper command: ${operation}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function parseArguments(command, argv) {
  const allowed = new Set(allowedArguments(command));
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!allowed.has(name)) throw new Error(`Unknown workspace-helper argument: ${name}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${name} requires a value`);
    if (parsed.has(name)) throw new Error(`Duplicate workspace-helper argument: ${name}`);
    parsed.set(name, value);
  }
  return parsed;
}

function allowedArguments(command) {
  if (command === "fs-write") {
    return ["--path", "--expected-modified-at", "--expected-revision"];
  }
  if (command === "fs-stat" || command === "fs-list" || command === "fs-read") {
    return ["--path"];
  }
  if (command === "fs-create-entry") return ["--parent-path", "--name", "--kind"];
  if (command === "fs-rename-entry") return ["--path", "--name"];
  if (command === "fs-duplicate-entry" || command === "fs-delete-entry") return ["--path"];
  if (command === "resolve-command") return ["--name"];
  return [];
}

async function resolveCommand(workspaceRoot, name) {
  if (!name) throw new Error("--name is required");
  const candidates = commandCandidates(name);
  if (name.includes("/") || (process.platform === "win32" && name.includes("\\"))) {
    for (const candidateName of candidates) {
      const candidate = path.isAbsolute(candidateName)
        ? candidateName
        : path.resolve(workspaceRoot, candidateName);
      const resolved = await resolveExecutable(candidate);
      if (resolved) return resolved;
    }
    return null;
  }
  const searchPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  for (const directory of new Set([
    path.dirname(process.execPath),
    ...searchPath.split(path.delimiter),
  ])) {
    for (const candidateName of candidates) {
      const resolved = await resolveExecutable(path.join(directory, candidateName));
      if (resolved) return resolved;
    }
  }
  return null;
}

function commandCandidates(name) {
  if (process.platform !== "win32") return [name];
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const nameExtension = path.extname(name).toLowerCase();
  if (extensions.some((extension) => extension.toLowerCase() === nameExtension)) return [name];
  return [name, ...extensions.map((extension) => `${name}${extension}`)];
}

async function resolveExecutable(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return await realpath(candidate);
  } catch {
    return null;
  }
}

async function fileStat(workspaceRoot, relativePath) {
  try {
    const scoped = await resolveScoped(workspaceRoot, relativePath);
    const info = await stat(scoped.absolute, { bigint: true });
    if (!info.isFile())
      return { status: "error", path: scoped.relative, error: "Requested path is not a file" };
    const type = await classify(scoped.absolute, Number(info.size));
    return {
      status: "ready",
      path: scoped.relative,
      ...type,
      size: Number(info.size),
      modifiedAt: info.mtime.toISOString(),
      revision: revision(info),
    };
  } catch (error) {
    if (isMissing(error)) return { status: "missing", path: relativePath };
    return {
      status: "error",
      path: relativePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function list(workspaceRoot, relativePath) {
  const directory = await resolveScoped(workspaceRoot, relativePath);
  const info = await stat(directory.absolute);
  if (!info.isDirectory()) throw new Error("Requested path is not a directory");
  const entries = [];
  for (const dirent of await readdir(directory.absolute, { withFileTypes: true })) {
    try {
      const child = await resolveScoped(
        workspaceRoot,
        path.posix.join(directory.relative, dirent.name),
      );
      const childInfo = await stat(child.absolute);
      entries.push({
        name: dirent.name,
        path: child.relative,
        kind: childInfo.isDirectory() ? "directory" : "file",
        size: childInfo.size,
        modifiedAt: childInfo.mtime.toISOString(),
      });
    } catch (error) {
      if (!isMissing(error) && error?.message !== outsideMessage) throw error;
    }
  }
  entries.sort(
    (left, right) =>
      Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt) ||
      left.name.localeCompare(right.name),
  );
  return { path: directory.relative, entries };
}

async function read(workspaceRoot, relativePath) {
  const scoped = await resolveScoped(workspaceRoot, relativePath);
  const handle = await open(
    scoped.absolute,
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Requested path is not a file");
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 256 * 1024,
    })) {
      if (!process.stdout.write(chunk))
        await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
  } finally {
    await handle.close();
  }
}

async function write(workspaceRoot, relativePath) {
  const scoped = await resolveScoped(workspaceRoot, relativePath);
  const before = await stat(scoped.absolute, { bigint: true }).catch((error) =>
    isMissing(error) ? null : Promise.reject(error),
  );
  if (!before)
    return print({ status: "conflict", version: { status: "missing", path: relativePath } });
  if (!before.isFile()) return print({ status: "error", error: "Requested path is not a file" });
  const expectedRevision = argument("--expected-revision");
  const expectedModifiedAt = argument("--expected-modified-at");
  if (
    (expectedRevision && revision(before) !== expectedRevision) ||
    (!expectedRevision && expectedModifiedAt && before.mtime.toISOString() !== expectedModifiedAt)
  ) {
    return print({ status: "conflict", version: await fileStat(workspaceRoot, relativePath) });
  }
  const temporary = path.join(
    path.dirname(scoped.absolute),
    `.${path.basename(scoped.absolute)}.paseo-${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", Number(before.mode));
    for await (const chunk of process.stdin) await handle.write(chunk);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const latest = await stat(scoped.absolute, { bigint: true });
    if (revision(latest) !== revision(before))
      return print({ status: "conflict", version: await fileStat(workspaceRoot, relativePath) });
    await rename(temporary, scoped.absolute);
    const result = await stat(scoped.absolute, { bigint: true });
    print({
      status: "written",
      modifiedAt: result.mtime.toISOString(),
      size: Number(result.size),
      revision: revision(result),
    });
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function createEntry(workspaceRoot, parentPath, name, kind) {
  let validatedName;
  try {
    validatedName = validateEntryName(name);
    if (kind !== "file" && kind !== "directory") {
      return { status: "error", error: "Invalid entry kind" };
    }
    const parent = await resolveScoped(workspaceRoot, parentPath);
    const parentInfo = await stat(parent.absolute);
    if (!parentInfo.isDirectory()) {
      return { status: "error", error: "Parent path is not a directory" };
    }
    const relative = normalize(path.posix.join(parent.relative, validatedName));
    const target = await resolveScoped(workspaceRoot, relative);
    if (kind === "directory") {
      await mkdir(target.absolute);
    } else {
      const handle = await open(target.absolute, "wx", 0o644);
      await handle.close();
    }
    return { status: "ok", path: relative };
  } catch (error) {
    return entryError(error, validatedName);
  }
}

async function renameEntry(workspaceRoot, relativePath, name) {
  let validatedName;
  try {
    validatedName = validateEntryName(name);
    const source = await resolveScoped(workspaceRoot, relativePath);
    if (source.relative === ".") {
      return { status: "error", error: "Cannot rename the workspace root" };
    }
    const targetRelative = normalize(
      path.posix.join(path.posix.dirname(source.relative), validatedName),
    );
    const target = await resolveScoped(workspaceRoot, targetRelative);
    const sourcePath = path.resolve(workspaceRoot, source.relative);
    const targetPath = path.resolve(workspaceRoot, targetRelative);
    const sourceInfo = await lstat(sourcePath);
    const targetInfo = await lstat(targetPath).catch((error) =>
      isMissing(error) ? null : Promise.reject(error),
    );
    if (targetInfo && (targetInfo.dev !== sourceInfo.dev || targetInfo.ino !== sourceInfo.ino)) {
      return { status: "error", error: `"${validatedName}" already exists` };
    }
    if (source.relative !== target.relative) await rename(sourcePath, targetPath);
    return { status: "ok", path: targetRelative };
  } catch (error) {
    return entryError(error, validatedName);
  }
}

async function duplicateEntry(workspaceRoot, relativePath) {
  try {
    const source = await resolveScoped(workspaceRoot, relativePath);
    if (source.relative === ".") {
      return { status: "error", error: "Cannot duplicate the workspace root" };
    }
    const sourcePath = path.resolve(workspaceRoot, source.relative);
    const sourceInfo = await lstat(sourcePath);
    const sourceName = path.posix.basename(source.relative);
    const extension = sourceInfo.isDirectory() ? "" : path.posix.extname(sourceName);
    const baseName = extension ? sourceName.slice(0, -extension.length) : sourceName;
    let targetRelative;
    for (let copyNumber = 1; ; copyNumber += 1) {
      const suffix = copyNumber === 1 ? " copy" : ` copy ${copyNumber}`;
      targetRelative = normalize(
        path.posix.join(path.posix.dirname(source.relative), `${baseName}${suffix}${extension}`),
      );
      await resolveScoped(workspaceRoot, targetRelative);
      try {
        await lstat(path.resolve(workspaceRoot, targetRelative));
      } catch (error) {
        if (isMissing(error)) break;
        throw error;
      }
    }
    await cp(sourcePath, path.resolve(workspaceRoot, targetRelative), {
      recursive: sourceInfo.isDirectory(),
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    return { status: "ok", path: targetRelative };
  } catch (error) {
    return entryError(error);
  }
}

async function deleteEntry(workspaceRoot, relativePath) {
  try {
    const scoped = await resolveScoped(workspaceRoot, relativePath);
    if (scoped.relative === ".") {
      return { status: "error", error: "Cannot delete the workspace root" };
    }
    const target = path.resolve(workspaceRoot, scoped.relative);
    const info = await lstat(target);
    await rm(target, { recursive: info.isDirectory(), force: false });
    return { status: "ok", path: scoped.relative };
  } catch (error) {
    return entryError(error);
  }
}

function validateEntryName(name) {
  const trimmed = name?.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") throw new Error("Invalid name");
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("Name cannot contain path separators");
  }
  return trimmed;
}

function entryError(error, name) {
  if (error?.code === "EEXIST") {
    return { status: "error", error: `"${name ?? "Entry"}" already exists` };
  }
  if (isMissing(error)) return { status: "error", error: "File or folder no longer exists" };
  return { status: "error", error: error instanceof Error ? error.message : String(error) };
}

async function runWatcher(workspaceRoot) {
  const subscriptions = new Map();
  print({ type: "ready" });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const command = JSON.parse(line);
      if (command.protocolVersion !== 1) throw new Error("Unsupported workspace-helper protocol");
      if ("root" in command) throw new Error("Watch subscriptions cannot supply a root");
      if (command.type === "close") break;
      if (command.type === "unsubscribe") {
        closeSubscription(subscriptions.get(command.id));
        subscriptions.delete(command.id);
        print({ type: "unsubscribed", subscriptionId: command.id });
        continue;
      }
      if (command.type !== "subscribe") continue;
      closeSubscription(subscriptions.get(command.id));
      const observation = { watchers: new Map(), timers: new Map() };
      subscriptions.set(command.id, observation);
      const ignoredPaths = new Set(command.ignoredPaths ?? []);
      for (const requested of command.paths) {
        const scoped = await resolveScoped(workspaceRoot, requested);
        const info = await stat(scoped.absolute).catch((error) => {
          if (isMissing(error)) return null;
          throw error;
        });
        if (command.recursive === true && info?.isDirectory()) {
          await watchDirectoryTree(observation, scoped, command.id, ignoredPaths);
          continue;
        }
        const expectedName = path.basename(scoped.absolute);
        const watcher = watch(path.dirname(scoped.absolute), (_event, filename) => {
          if (filename != null && filename.toString() !== expectedName) return;
          clearTimeout(observation.timers.get(scoped.relative));
          observation.timers.set(
            scoped.relative,
            setTimeout(() => {
              observation.timers.delete(scoped.relative);
              print({ type: "changed", subscriptionId: command.id, paths: [scoped.relative] });
            }, 50),
          );
        });
        watcher.on("error", (error) =>
          print({ type: "error", subscriptionId: command.id, message: error.message }),
        );
        observation.watchers.set(scoped.absolute, watcher);
      }
      print({ type: "subscribed", subscriptionId: command.id });
    }
  } finally {
    for (const observation of subscriptions.values()) closeSubscription(observation);
  }
}

function closeSubscription(observation) {
  if (!observation) return;
  for (const watcher of observation.watchers.values()) watcher.close();
  for (const timer of observation.timers.values()) clearTimeout(timer);
}

async function watchDirectoryTree(observation, scoped, subscriptionId, ignoredPaths) {
  if (observation.watchers.has(scoped.absolute)) return;
  const watcher = watch(scoped.absolute, (_event, filename) => {
    const name = filename?.toString();
    const changed = name ? path.join(scoped.absolute, name) : scoped.absolute;
    const relative = normalize(path.relative(root, changed));
    if (isIgnored(relative, ignoredPaths)) return;
    clearTimeout(observation.timers.get(relative));
    observation.timers.set(
      relative,
      setTimeout(() => {
        observation.timers.delete(relative);
        print({ type: "changed", subscriptionId, paths: [relative] });
        void addDiscoveredDirectories(observation, scoped, subscriptionId, ignoredPaths);
      }, 50),
    );
  });
  watcher.on("error", (error) => print({ type: "error", subscriptionId, message: error.message }));
  observation.watchers.set(scoped.absolute, watcher);
  await addDiscoveredDirectories(observation, scoped, subscriptionId, ignoredPaths);
}

async function addDiscoveredDirectories(observation, scoped, subscriptionId, ignoredPaths) {
  const entries = await readdir(scoped.absolute, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absolute = path.join(scoped.absolute, entry.name);
    const relative = normalize(path.relative(root, absolute));
    if (isIgnored(relative, ignoredPaths)) continue;
    await watchDirectoryTree(observation, { absolute, relative }, subscriptionId, ignoredPaths);
  }
}

function isIgnored(relativePath, ignoredPaths) {
  for (const ignored of ignoredPaths) {
    if (relativePath === ignored || relativePath.startsWith(`${ignored}/`)) return true;
  }
  return false;
}

async function resolveScoped(workspaceRoot, relativePath = ".") {
  const normalizedRoot = path.resolve(workspaceRoot);
  if (path.isAbsolute(relativePath)) throw new Error(outsideMessage);
  const requested = path.resolve(normalizedRoot, relativePath);
  if (!contains(normalizedRoot, requested)) throw new Error(outsideMessage);
  const canonicalRoot = await realpath(normalizedRoot);
  try {
    const canonical = await realpath(requested);
    if (!contains(canonicalRoot, canonical)) throw new Error(outsideMessage);
    return { absolute: canonical, relative: normalize(path.relative(normalizedRoot, requested)) };
  } catch (error) {
    if (!isMissing(error)) throw error;
    const canonicalParent = await realpath(path.dirname(requested));
    if (!contains(canonicalRoot, canonicalParent))
      throw new Error(outsideMessage, { cause: error });
    return { absolute: requested, relative: normalize(path.relative(normalizedRoot, requested)) };
  }
}

function contains(rootPath, candidate) {
  const relative = path.relative(rootPath, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function normalize(relative) {
  return relative === "" ? "." : relative.split(path.sep).join("/");
}
function revision(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
}
function isMissing(error) {
  return ["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code);
}
function print(value) {
  process.stdout.write(`${JSON.stringify({ protocolVersion: 1, ...value })}\n`);
}

async function classify(file, size) {
  const extension = path.extname(file).toLowerCase();
  if (imageTypes.has(extension))
    return { kind: "image", encoding: "binary", mimeType: imageTypes.get(extension) };
  const handle = await open(file, "r");
  try {
    const sample = Buffer.alloc(Math.min(8192, size));
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    const bytes = sample.subarray(0, bytesRead);
    if (binary(bytes))
      return { kind: "binary", encoding: "binary", mimeType: "application/octet-stream" };
    return {
      kind: "text",
      encoding: "utf-8",
      mimeType: extension === ".json" ? "application/json" : "text/plain",
    };
  } finally {
    await handle.close();
  }
}
function binary(bytes) {
  if (bytes.length === 0) return false;
  let suspicious = 0;
  for (const byte of bytes) {
    if (byte === 0) return true;
    if ((byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127) suspicious++;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return true;
  }
  return suspicious / bytes.length > 0.3;
}
