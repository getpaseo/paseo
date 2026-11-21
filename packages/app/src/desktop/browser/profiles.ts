import type { BrowserProfileEntry, BrowserProfileGroup } from "@/desktop/host";

export const sharedDefault: BrowserProfileEntry = { group: null, slug: "default", name: "default" };

async function identityHash(...parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(["v1", ...parts])),
  );
  return Array.from(new Uint8Array(digest, 0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function sameProfileGroup(a: BrowserProfileGroup, b: BrowserProfileGroup): boolean {
  return a?.serverId === b?.serverId && a?.projectId === b?.projectId;
}

export function sameProfile(a: BrowserProfileEntry, b: BrowserProfileEntry): boolean {
  return a.slug === b.slug && sameProfileGroup(a.group, b.group);
}

// Catalogs created before automatic names were reserved, and later workspace renames,
// can introduce an existing collision. Keep both sessions and distinguish the automatic row.
export function automaticProfileLabel(
  automatic: BrowserProfileEntry,
  catalog: BrowserProfileEntry[],
  qualifier: string,
): string {
  const names = new Set(
    catalog
      .filter((entry) => sameProfileGroup(entry.group, automatic.group))
      .map((entry) => entry.name.trim().toLowerCase()),
  );
  let label = automatic.name;
  for (let n = 1; names.has(label.trim().toLowerCase()); n++) {
    label = `${automatic.name} (${qualifier}${n === 1 ? "" : " " + n})`;
  }
  return label;
}

export async function workspaceProfile(
  serverId: string,
  projectId: string,
  workspaceId: string,
  name: string,
): Promise<BrowserProfileEntry> {
  const hash = await identityHash("workspace", serverId, projectId, workspaceId);
  return { group: { serverId, projectId }, slug: "ws-" + hash, name };
}

export async function profilePartition({ group, slug }: BrowserProfileEntry): Promise<string> {
  if (!group) return slug === "default" ? "persist:paseo-browser" : "persist:paseo-shared-" + slug;
  return `persist:paseo-project-${await identityHash("project", group.serverId, group.projectId)}-${slug}`;
}
