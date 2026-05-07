import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listFilesRecursive } from "./sync.js";

export interface SkillManifestFile {
  rel: string;
  sha256: string;
}

export interface SkillManifestEntry {
  name: string;
  files: SkillManifestFile[];
}

export interface SkillManifest {
  version: 1;
  skills: SkillManifestEntry[];
}

export type SkillOp =
  | { kind: "add"; name: string }
  | { kind: "update"; name: string }
  | { kind: "delete"; name: string };

const MANIFEST_FILENAME = ".paseo-manifest.json";

function manifestPath(agentsDir: string): string {
  return path.join(agentsDir, MANIFEST_FILENAME);
}

export async function readManifest(agentsDir: string): Promise<SkillManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath(agentsDir), "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isSkillManifest(parsed)) return null;
  return parsed;
}

export async function writeManifest(agentsDir: string, m: SkillManifest): Promise<void> {
  await fs.mkdir(agentsDir, { recursive: true });
  const target = manifestPath(agentsDir);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(m, null, 2)}\n`);
  await fs.rename(tmp, target);
}

export async function hashBundle(
  sourceDir: string,
  skillNames: readonly string[],
): Promise<SkillManifestEntry[]> {
  const out: SkillManifestEntry[] = [];

  for (const name of skillNames) {
    const skillDir = path.join(sourceDir, name);
    const stat = await fs.stat(skillDir).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const rels = await listFilesRecursive(skillDir);
    const files: SkillManifestFile[] = [];
    for (const rel of rels) {
      const sha256 = await hashFile(path.join(skillDir, rel));
      files.push({ rel: toPosix(rel), sha256 });
    }
    files.sort((a, b) => compareStrings(a.rel, b.rel));
    out.push({ name, files });
  }

  out.sort((a, b) => compareStrings(a.name, b.name));
  return out;
}

export function diffSkills(
  bundle: SkillManifestEntry[],
  manifest: SkillManifest | null,
): SkillOp[] {
  const manifestByName = new Map<string, SkillManifestEntry>();
  if (manifest) {
    for (const entry of manifest.skills) manifestByName.set(entry.name, entry);
  }

  const ops: SkillOp[] = [];
  const seen = new Set<string>();

  for (const bundleEntry of bundle) {
    seen.add(bundleEntry.name);
    const manifestEntry = manifestByName.get(bundleEntry.name);
    if (!manifestEntry) {
      ops.push({ kind: "add", name: bundleEntry.name });
    } else if (!filesEqual(bundleEntry.files, manifestEntry.files)) {
      ops.push({ kind: "update", name: bundleEntry.name });
    }
  }

  for (const name of manifestByName.keys()) {
    if (!seen.has(name)) ops.push({ kind: "delete", name });
  }

  ops.sort((a, b) => compareStrings(a.name, b.name));
  return ops;
}

function filesEqual(a: SkillManifestFile[], b: SkillManifestFile[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].rel !== b[i].rel || a[i].sha256 !== b[i].sha256) return false;
  }
  return true;
}

async function hashFile(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isSkillManifest(value: unknown): value is SkillManifest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (!Array.isArray(v.skills)) return false;
  for (const skill of v.skills) {
    if (!skill || typeof skill !== "object") return false;
    const s = skill as Record<string, unknown>;
    if (typeof s.name !== "string") return false;
    if (!Array.isArray(s.files)) return false;
    for (const file of s.files) {
      if (!file || typeof file !== "object") return false;
      const f = file as Record<string, unknown>;
      if (typeof f.rel !== "string" || typeof f.sha256 !== "string") return false;
    }
  }
  return true;
}
