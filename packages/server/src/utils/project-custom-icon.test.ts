import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ProjectIconSource } from "@getpaseo/protocol/messages";
import {
  createPersistedProjectRecord,
  type PersistedProjectRecord,
  type ProjectRegistry,
} from "../server/workspace-registry.js";
import {
  ProjectIconReader,
  readProjectIcon,
  readProjectIconSnapshot,
  removeProjectCustomIcon,
  setProjectCustomIcon,
} from "./project-custom-icon.js";

const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00,
]);
const PNG_1X1_ICON = { data: PNG_1X1.toString("base64"), mimeType: "image/png" };

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A project whose root holds no discoverable icon, over an in-memory registry. */
async function project() {
  const rootPath = await tempDir("paseo-project-root-");
  const paseoHome = await tempDir("paseo-home-");
  let record = createPersistedProjectRecord({
    projectId: "project-a",
    rootPath,
    kind: "git",
    displayName: "repo",
    createdAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:00.000Z",
  });
  const projects = {
    get: async () => record,
    update: async (_id: string, updater: (r: PersistedProjectRecord) => PersistedProjectRecord) => {
      record = updater(record);
      return record;
    },
  } as unknown as ProjectRegistry;
  const reader = new ProjectIconReader(paseoHome);

  return {
    paseoHome,
    rootPath,
    set: (source: ProjectIconSource) =>
      setProjectCustomIcon({ paseoHome, projectId: "project-a", source, projects }),
    read: () => readProjectIcon({ paseoHome, project: record }),
    snapshot: () => readProjectIconSnapshot({ paseoHome, project: record }),
    advertisedSnapshot: () => reader.snapshot(record),
    readAdvertised: () => reader.read(record),
    revision: () => record.customIconRevision,
    remove: () => removeProjectCustomIcon({ paseoHome, projectId: "project-a" }),
  };
}

function nonSquarePng(): Buffer {
  const wide = Buffer.from(PNG_1X1);
  wide.writeUInt32BE(2, 16);
  return wide;
}

describe("project custom icon", () => {
  it("stores uploaded bytes as the custom icon", async () => {
    const target = await project();

    await target.set({ type: "upload", data: PNG_1X1.toString("base64") });

    expect(target.revision()).toEqual(expect.any(String));
    await expect(target.read()).resolves.toEqual(PNG_1X1_ICON);
  });

  it("scans the project directory when no custom icon is stored", async () => {
    const target = await project();
    await mkdir(join(target.rootPath, "public"));
    await writeFile(join(target.rootPath, "public", "favicon.png"), PNG_1X1);

    await expect(target.read()).resolves.toEqual(PNG_1X1_ICON);
  });

  it("fingerprints automatic icons and explicit no-icon results", async () => {
    const target = await project();

    const missing = await target.snapshot();
    expect(missing).toEqual({ icon: null, revision: "automatic:none:v1" });

    await mkdir(join(target.rootPath, "public"));
    await writeFile(join(target.rootPath, "public", "favicon.png"), PNG_1X1);
    const first = await target.snapshot();
    await writeFile(
      join(target.rootPath, "public", "favicon.png"),
      Buffer.concat([PNG_1X1, Buffer.from([1])]),
    );
    const changed = await target.snapshot();

    expect(first.icon).toEqual(PNG_1X1_ICON);
    expect(first.revision).toMatch(/^automatic:[a-f0-9]{64}$/);
    expect(changed.revision).not.toBe(first.revision);
  });

  it("serves the bytes that match the advertised revision", async () => {
    const target = await project();
    await mkdir(join(target.rootPath, "public"));
    await writeFile(join(target.rootPath, "public", "favicon.png"), PNG_1X1);
    const advertised = await target.advertisedSnapshot();

    await writeFile(
      join(target.rootPath, "public", "favicon.png"),
      Buffer.concat([PNG_1X1, Buffer.from([1])]),
    );

    await expect(target.readAdvertised()).resolves.toEqual(advertised.icon);
  });

  it("drops the stored image when the project goes back to automatic", async () => {
    const target = await project();
    await target.set({ type: "upload", data: PNG_1X1.toString("base64") });

    await target.set({ type: "automatic" });

    expect(target.revision()).toBeNull();
    await expect(target.read()).resolves.toBeNull();
  });

  it("drops the stored image when the project is removed", async () => {
    const target = await project();
    const stored = await target.set({ type: "upload", data: PNG_1X1.toString("base64") });

    await target.remove();

    await expect(
      readProjectIcon({ paseoHome: target.paseoHome, project: stored }),
    ).resolves.toBeNull();
  });

  it.each([
    ["data that is not an image", Buffer.from("nope"), "Unsupported or invalid icon file"],
    ["a non-square image", nonSquarePng(), "square image up to 1024×1024"],
    ["a file over 512 KB", Buffer.alloc(512 * 1024 + 1), "512 KB or smaller"],
  ])("rejects %s", async (_name, bytes, message) => {
    const target = await project();

    await expect(target.set({ type: "upload", data: bytes.toString("base64") })).rejects.toThrow(
      message,
    );
    expect(target.revision()).toBeNull();
  });

  it("serializes concurrent saves for one project", async () => {
    const target = await project();

    const [first, second] = await Promise.all([
      target.set({ type: "upload", data: PNG_1X1.toString("base64") }),
      target.set({ type: "automatic" }),
    ]);

    expect(first.customIconRevision).toEqual(expect.any(String));
    expect(second.customIconRevision).toBeNull();
    await expect(target.read()).resolves.toBeNull();
  });
});
