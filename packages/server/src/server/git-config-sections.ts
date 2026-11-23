// `git push -u`, `git branch -d` and `git worktree add` rewrite a repository's shared
// `.git/config` only to add or remove `[branch "<name>"]` sections. Paseo reads those
// keys solely for the checkout whose current branch they name, so a change limited to
// them must not re-scan every worktree of the repository.

const SECTION_HEADER = /^\s*\[\s*([^\]\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/;

export type GitConfigSections = Map<string, string>;

export function parseGitConfigSections(text: string): GitConfigSections {
  const sections: GitConfigSections = new Map();
  let key: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const header = SECTION_HEADER.exec(rawLine);
    if (header) {
      key = `${header[1].toLowerCase()}\u0000${header[2] ?? ""}`;
      const rest = rawLine.slice(header[0].length).trim();
      sections.set(key, (sections.get(key) ?? "") + (rest ? `${rest}\n` : ""));
      continue;
    }
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const current = key ?? "";
    sections.set(current, (sections.get(current) ?? "") + `${line}\n`);
  }
  return sections;
}

/**
 * The branch names whose `[branch "<name>"]` sections differ between two parses,
 * or null when anything else changed (a remote, core settings, an include, a
 * section without a branch name), which callers must treat as a change to all of it.
 */
export function changedBranchSections(
  previous: GitConfigSections,
  next: GitConfigSections,
): Set<string> | null {
  const branches = new Set<string>();
  for (const key of new Set([...previous.keys(), ...next.keys()])) {
    if (previous.get(key) === next.get(key)) continue;
    const [name, subsection] = key.split("\u0000");
    if (name !== "branch" || !subsection) return null;
    branches.add(subsection.replace(/\\(.)/g, "$1"));
  }
  return branches;
}
