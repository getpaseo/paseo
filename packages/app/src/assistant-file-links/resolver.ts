import {
  classifyAssistantFileLink,
  isFileLookingAssistantToken,
  type AssistantFileLinkClassification,
  type InlinePathTarget,
} from "./parse";
import type { OpenFileDisposition } from "@/workspace/file-open";

export interface AssistantFileLinkContext {
  serverId?: string;
  workspaceRoot?: string;
}

export interface AssistantFileLinkSource {
  href: string;
  text?: string;
  markup?: string;
  sourceInfo?: string;
  sourceType?: "inline-code";
}

export interface DirectorySuggestionEntry {
  path: string;
  kind: "file" | "directory";
}

export interface DirectorySuggestionResult {
  entries: DirectorySuggestionEntry[];
  error: string | null;
}

export interface AssistantFileLinkResolverDependencies {
  getDirectorySuggestions: (input: {
    query: string;
    cwd: string;
    includeFiles: true;
    includeDirectories: false;
    limit: number;
  }) => Promise<DirectorySuggestionResult>;
  openWorkspaceFile: (target: InlinePathTarget, disposition: OpenFileDisposition) => void;
  openExternalUrl: (url: string) => void | Promise<void>;
  onUnresolvedFileCandidate?: (token: string) => void;
  isCurrentContext?: (context: AssistantFileLinkContext) => boolean;
}

export interface AssistantFileLinkResolver {
  prefetch(input: AssistantFileLinkPrefetchInput): Promise<ResolvedAssistantFileLink>;
  open(input: AssistantFileLinkOpenInput): Promise<AssistantFileLinkOpenResult>;
}

export interface AssistantFileLinkPrefetchInput {
  context: AssistantFileLinkContext;
  source: AssistantFileLinkSource;
}

export interface AssistantFileLinkOpenInput extends AssistantFileLinkPrefetchInput {
  disposition: OpenFileDisposition;
}

export type ResolvedAssistantFileLink =
  | {
      kind: "external";
      url: string;
    }
  | {
      kind: "file";
      target: InlinePathTarget;
    }
  | {
      kind: "unresolvedFileCandidate";
      token: string;
    }
  | {
      kind: "ignored";
    };

export type AssistantFileLinkOpenResult = ResolvedAssistantFileLink & {
  opened: boolean;
};

type CachedAssistantFileLink = Exclude<ResolvedAssistantFileLink, { kind: "external" }>;

interface ParsedAssistantFileLinkInteraction {
  token: string;
  classification: AssistantFileLinkClassification;
}

export function createAssistantFileLinkResolver(
  dependencies: AssistantFileLinkResolverDependencies,
): AssistantFileLinkResolver {
  const cache = new Map<string, CachedAssistantFileLink>();
  const inFlight = new Map<string, Promise<CachedAssistantFileLink>>();

  async function resolve(
    input: AssistantFileLinkPrefetchInput,
  ): Promise<ResolvedAssistantFileLink> {
    const parsed = parseInteraction(input);
    if (!parsed) {
      return { kind: "ignored" };
    }

    if (parsed.classification.kind === "external") {
      return { kind: "external", url: parsed.classification.raw };
    }

    if (parsed.classification.kind === "directFile") {
      return { kind: "file", target: parsed.classification.target };
    }

    const key = getResolutionKey(input.context, parsed.token);
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }

    const active = inFlight.get(key);
    if (active) {
      return active;
    }

    const request = resolveAmbiguousCandidate({
      context: input.context,
      token: parsed.token,
      target: parsed.classification.target,
      getDirectorySuggestions: dependencies.getDirectorySuggestions,
    })
      .then((result) => {
        if (result.kind === "file") {
          cache.set(key, result);
        }
        inFlight.delete(key);
        return result;
      })
      .catch((): CachedAssistantFileLink => {
        inFlight.delete(key);
        return { kind: "unresolvedFileCandidate", token: parsed.token };
      });

    inFlight.set(key, request);
    return request;
  }

  return {
    prefetch(input) {
      return resolve(input);
    },
    async open(input) {
      const resolved = await resolve(input);
      if (!canApplyResult(input.context, dependencies.isCurrentContext)) {
        return { ...resolved, opened: false };
      }

      if (resolved.kind === "file") {
        dependencies.openWorkspaceFile(resolved.target, input.disposition);
        return { ...resolved, opened: true };
      }

      if (resolved.kind === "external") {
        await dependencies.openExternalUrl(resolved.url);
        return { ...resolved, opened: true };
      }

      if (resolved.kind === "unresolvedFileCandidate") {
        dependencies.onUnresolvedFileCandidate?.(resolved.token);
      }

      return { ...resolved, opened: false };
    },
  };
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

function parseInteraction(
  input: AssistantFileLinkPrefetchInput,
): ParsedAssistantFileLinkInteraction | null {
  const token = getAssistantFileLinkToken(input.source).trim();
  if (!token) {
    return null;
  }

  const classification = classifyAssistantFileLink(token, {
    workspaceRoot: input.context.workspaceRoot,
  });
  if (!classification) {
    return null;
  }

  return { token, classification };
}

async function resolveAmbiguousCandidate(input: {
  context: AssistantFileLinkContext;
  token: string;
  target: InlinePathTarget;
  getDirectorySuggestions: AssistantFileLinkResolverDependencies["getDirectorySuggestions"];
}): Promise<CachedAssistantFileLink> {
  const workspaceRoot = input.context.workspaceRoot?.trim();
  if (!workspaceRoot) {
    return { kind: "unresolvedFileCandidate", token: input.token };
  }

  const query = getAmbiguousSuggestionQuery(input.target, workspaceRoot);
  const suggestions = await input.getDirectorySuggestions({
    query,
    cwd: workspaceRoot,
    includeFiles: true,
    includeDirectories: false,
    limit: 1,
  });
  const match = suggestions.entries.find((entry) => entry.kind === "file");
  if (!match || suggestions.error) {
    return { kind: "unresolvedFileCandidate", token: input.token };
  }

  return {
    kind: "file",
    target: {
      ...input.target,
      path: joinWorkspacePath(workspaceRoot, match.path),
    },
  };
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

function getResolutionKey(context: AssistantFileLinkContext, token: string): string {
  return [context.serverId ?? "", context.workspaceRoot ?? "", token].join("\0");
}

function isLinkifiedSource(source: AssistantFileLinkSource): boolean {
  return source.markup === "linkify" || source.sourceInfo === "auto";
}

function canApplyResult(
  context: AssistantFileLinkContext,
  isCurrentContext: AssistantFileLinkResolverDependencies["isCurrentContext"],
): boolean {
  return isCurrentContext ? isCurrentContext(context) : true;
}

function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const child = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return root ? `${root}/${child}` : child;
}
