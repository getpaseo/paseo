import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { classifyForResolution, fetchDaemonResolution } from "@/assistant-file-links/resolver";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import type {
  TerminalLocalFileLinkSource,
  TerminalLocalFileLinkTarget,
} from "./terminal-local-link-provider";

export interface ResolveTerminalLocalFileLinkInput {
  source: TerminalLocalFileLinkSource;
  workspaceRoot: string;
  canValidateExactPaths: boolean;
  getDirectorySuggestions: DaemonClient["getDirectorySuggestions"] | null;
}

export async function resolveTerminalLocalFileLink(
  input: ResolveTerminalLocalFileLinkInput,
): Promise<TerminalLocalFileLinkTarget | null> {
  const { source, workspaceRoot, getDirectorySuggestions } = input;
  if (!getDirectorySuggestions) {
    return null;
  }
  const resolution = classifyForResolution(
    { href: source.text, text: source.text, sourceType: "inline-code" },
    { workspaceRoot },
  );
  try {
    if (resolution.kind === "needsLookup") {
      return await fetchDaemonResolution({
        ambiguousQuery: resolution.ambiguousQuery,
        token: resolution.token,
        target: resolution.target,
        workspaceRoot,
        getDirectorySuggestions,
      });
    }
    // COMPAT(exactDirectorySuggestions): added after v0.13.2; remove after 2027-04-27
    // once the daemon floor supports exactOnly.
    if (resolution.value.kind !== "file" || !input.canValidateExactPaths) {
      return null;
    }
    const target = resolution.value.target;
    const readTarget = resolveFilePreviewReadTarget({ path: target.path, workspaceRoot });
    if (!readTarget) {
      return null;
    }
    const relativePath = relativeLookupPath(readTarget);
    if (relativePath === null) {
      return null;
    }
    const response = await getDirectorySuggestions({
      cwd: readTarget.cwd,
      query: `./${relativePath}`,
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
      exactOnly: true,
      limit: 1,
    });
    // Only the named path proves existence; never open a similarly named search result.
    const exists = response.entries.some(
      (entry) => entry.kind === "file" && entry.path === relativePath,
    );
    return !response.error && exists ? target : null;
  } catch {
    // A missing or disconnected host cannot validate a terminal link.
    return null;
  }
}

function relativeLookupPath(input: { cwd: string; path: string }): string | null {
  const root = input.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  let query = input.path.replace(/\\/g, "/");
  const prefix = `${root}/`;
  // A network share cannot be validated as a same-named directory under a local root.
  if (query.startsWith("//") && !prefix.startsWith("//")) {
    return null;
  }
  const isDrivePath = /^[A-Za-z]:\//.test(query);
  const comparableQuery = isDrivePath ? query.toLowerCase() : query;
  const comparablePrefix = isDrivePath ? prefix.toLowerCase() : prefix;
  if (comparableQuery.startsWith(comparablePrefix)) {
    query = query.slice(prefix.length);
  }

  const parts: string[] = [];
  for (const part of query.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}
