import {
  classifyAssistantFileLink,
  isFileLookingAssistantToken,
  type AssistantFileLinkClassification,
  type InlinePathTarget,
} from "./parse";

export interface AssistantFileLinkSource {
  href: string;
  text?: string;
  markup?: string;
  sourceInfo?: string;
  sourceType?: "inline-code";
}

export interface AssistantFileLinkContext {
  serverId?: string;
  workspaceRoot?: string;
}

export interface DirectorySuggestionEntry {
  path: string;
  kind: "file" | "directory";
}

export interface DirectorySuggestionResult {
  entries: DirectorySuggestionEntry[];
  error: string | null;
}

export type GetDirectorySuggestions = (input: {
  query: string;
  cwd: string;
  includeFiles: true;
  includeDirectories: false;
  matchMode: "suffix";
  limit: number;
}) => Promise<DirectorySuggestionResult>;

export type ResolvedAssistantFileLink =
  | { kind: "external"; url: string }
  | { kind: "file"; target: InlinePathTarget }
  | { kind: "unresolvedFileCandidate"; token: string }
  | { kind: "ignored" };

export interface ResolveAssistantFileLinkInput {
  source: AssistantFileLinkSource;
  context: AssistantFileLinkContext;
  getDirectorySuggestions: GetDirectorySuggestions;
}

export async function resolveAssistantFileLink(
  input: ResolveAssistantFileLinkInput,
): Promise<ResolvedAssistantFileLink> {
  const synchronous = resolveAssistantFileLinkSync(input);
  if (synchronous.kind !== "needsLookup") {
    return synchronous.resolved;
  }

  const workspaceRoot = input.context.workspaceRoot?.trim();
  if (!workspaceRoot) {
    return { kind: "unresolvedFileCandidate", token: synchronous.token };
  }

  const query = getAmbiguousSuggestionQuery(synchronous.target, workspaceRoot);
  let suggestions: DirectorySuggestionResult;
  try {
    suggestions = await input.getDirectorySuggestions({
      query,
      cwd: workspaceRoot,
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
      limit: 1,
    });
  } catch {
    return { kind: "unresolvedFileCandidate", token: synchronous.token };
  }

  const match = suggestions.entries.find((entry) => entry.kind === "file");
  if (!match || suggestions.error) {
    return { kind: "unresolvedFileCandidate", token: synchronous.token };
  }

  return {
    kind: "file",
    target: {
      ...synchronous.target,
      path: joinWorkspacePath(workspaceRoot, match.path),
    },
  };
}

type SyncResolution =
  | { kind: "resolved"; resolved: ResolvedAssistantFileLink }
  | { kind: "needsLookup"; token: string; target: InlinePathTarget };

export function resolveAssistantFileLinkSync(input: {
  source: AssistantFileLinkSource;
  context: AssistantFileLinkContext;
}): SyncResolution {
  const token = getAssistantFileLinkToken(input.source).trim();
  if (!token) {
    return { kind: "resolved", resolved: { kind: "ignored" } };
  }

  const classification = classifyAssistantFileLink(token, {
    workspaceRoot: input.context.workspaceRoot,
  });
  if (!classification) {
    return { kind: "resolved", resolved: { kind: "ignored" } };
  }
  if (classification.kind === "external") {
    return { kind: "resolved", resolved: { kind: "external", url: classification.raw } };
  }
  if (
    classification.kind === "directFile" &&
    !shouldResolveDirectFileThroughSuggestions({
      context: input.context,
      source: input.source,
      token,
      target: classification.target,
    })
  ) {
    return { kind: "resolved", resolved: { kind: "file", target: classification.target } };
  }
  return { kind: "needsLookup", token, target: classification.target };
}

export function getAssistantFileLinkToken(source: AssistantFileLinkSource): string {
  if (isLinkifiedSource(source) || source.sourceType === "inline-code") {
    const text = source.text?.trim();
    if (text && isFileLookingAssistantToken(text)) {
      return text;
    }
  }

  return source.href;
}

function getAmbiguousSuggestionQuery(target: InlinePathTarget, workspaceRoot: string): string {
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = target.path.replace(/\\/g, "/");
  const prefix = `${normalizedRoot}/`;
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length);
  }

  const lastSlash = normalizedPath.lastIndexOf("/");
  return lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;
}

function shouldResolveDirectFileThroughSuggestions(input: {
  context: AssistantFileLinkContext;
  source: AssistantFileLinkSource;
  token: string;
  target: InlinePathTarget;
}): boolean {
  if (input.source.sourceType !== "inline-code") {
    return false;
  }

  if (isAbsoluteInlineCodeToken(input.token)) {
    return false;
  }

  const workspaceRoot = input.context.workspaceRoot?.trim();
  if (!workspaceRoot) {
    return false;
  }

  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = input.target.path.replace(/\\/g, "/");
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}

function isAbsoluteInlineCodeToken(token: string): boolean {
  return (
    token.startsWith("/") ||
    token.toLowerCase().startsWith("file://") ||
    /^[A-Za-z]:[\\/]/.test(token)
  );
}

function isLinkifiedSource(source: AssistantFileLinkSource): boolean {
  return source.markup === "linkify" || source.sourceInfo === "auto";
}

function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const child = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return root ? `${root}/${child}` : child;
}

export type { AssistantFileLinkClassification };
