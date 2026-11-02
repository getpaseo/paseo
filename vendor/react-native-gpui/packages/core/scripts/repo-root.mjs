// The repository root, found by lookup rather than by counting parent
// directories: this file lives at a different depth before and after a folder
// move, but the root is always the nearest ancestor whose package.json declares
// `workspaces`.
//
// A published package has no repository root above it, so callers that only
// run inside this checkout use this; anything that must also work from an
// installed copy resolves its dependencies from node_modules instead.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function hasWorkspaces(dir) {
  const manifest = path.join(dir, 'package.json');
  if (!existsSync(manifest)) return false;
  try {
    return Boolean(JSON.parse(readFileSync(manifest, 'utf8')).workspaces);
  } catch {
    return false;
  }
}

export function repoRoot(from = path.dirname(fileURLToPath(import.meta.url))) {
  let current = path.resolve(from);
  while (true) {
    if (hasWorkspaces(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `no repository root with a workspaces manifest above ${from}`,
      );
    }
    current = parent;
  }
}

// The installed `<name>` package, found by walking up from `start` for a
// `node_modules` directory that holds it. Mirrors `find_node_module` in
// `rn-gpui-sys/build.rs` and `rn_gpui_find_node_module` in CMake.
export function findNodeModule(start, name) {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
