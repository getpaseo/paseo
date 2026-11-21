import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isNamedBrowserSlug } from "./browser-profile.js";

const groupSchema = z
  .strictObject({
    serverId: z.string().min(1),
    projectId: z.string().min(1),
  })
  .nullable();
const nameSchema = z.string().trim().min(1).max(80);
const entryInput = z.strictObject({ group: groupSchema, name: nameSchema });
const createInput = entryInput.extend({ workspaceNames: z.array(z.string()).default([]) });
const entrySchema = entryInput
  .extend({ slug: z.string() })
  .refine((entry) => isNamedBrowserSlug(entry.slug, entry.group === null));
const catalogSchema = z.strictObject({ version: z.literal(1), profiles: z.array(entrySchema) });
type Entry = z.infer<typeof entrySchema>;

function foldedSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
}

export function createBrowserProfileCatalog(userData: string) {
  const file = path.join(userData, "browser-profiles.json");
  let writer = Promise.resolve();
  async function list(): Promise<Entry[]> {
    try {
      return catalogSchema.parse(JSON.parse(await readFile(file, "utf8"))).profiles;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  async function append(input: unknown) {
    const { group, name, workspaceNames } = createInput.parse(input);
    const profiles = await list();
    const siblings = profiles.filter(
      (row) => row.group?.serverId === group?.serverId && row.group?.projectId === group?.projectId,
    );
    const names = siblings.map((row) => row.name).concat(group ? workspaceNames : []);
    if (names.some((existing) => existing.trim().toLowerCase() === name.toLowerCase()))
      throw new Error("Duplicate profile name");
    const base = foldedSlug(name) || `profile-${randomUUID().slice(0, 8)}`;
    if (!isNamedBrowserSlug(base, group === null) || (group && /^ws-/i.test(name)))
      throw new Error("Reserved profile name");
    let slug = base;
    for (let n = 2; siblings.some((row) => row.slug === slug); n++) {
      const suffix = `-${n}`;
      const stem = group && base === "ws" ? "profile-ws" : base;
      slug = stem.slice(0, 48 - suffix.length).replace(/-+$/, "") + suffix;
    }
    const entry = { group, name, slug };
    const temp = file + "." + randomUUID();
    try {
      await writeFile(temp, JSON.stringify({ version: 1, profiles: [...profiles, entry] }), {
        mode: 0o600,
      });
      await rename(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
    return entry;
  }
  return {
    list,
    create(input: unknown) {
      const result = writer.then(() => append(input));
      writer = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
