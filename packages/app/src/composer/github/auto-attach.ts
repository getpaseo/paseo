import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import {
  buildGithubSearchQueryOptions,
  type GitHubSearchClient,
} from "@/git/use-github-search-query";
import { extractGithubRefs, type GithubRef } from "@/utils/github-refs";
import type { GitHubSearchItem } from "@getpaseo/protocol/messages";
import { isAttachmentSelectedForGithubItem, toggleGithubAttachment } from "../actions";

const AUTO_ATTACH_DEBOUNCE_MS = 300;

interface ComposerGithubAutoAttachInput {
  text: string;
  remoteUrl: string | null | undefined;
  attachments: UserComposerAttachment[];
  client: GitHubSearchClient | null;
  isConnected: boolean;
  serverId: string;
  cwd: string;
  setAttachments: Dispatch<SetStateAction<UserComposerAttachment[]>>;
}

interface ComposerGithubAutoAttachResult {
  markGithubAttachmentRemoved: (attachment: ComposerAttachment | undefined) => void;
}

export function useComposerGithubAutoAttach(
  params: ComposerGithubAutoAttachInput,
): ComposerGithubAutoAttachResult {
  const queryClient = useQueryClient();
  const latestRef = useRef(params);
  const removedRefKeysRef = useRef(new Set<string>());
  const pendingRefKeysRef = useRef(new Set<string>());

  latestRef.current = params;

  useEffect(() => {
    const refs = refsReadyForLookup({
      params: latestRef.current,
      removedRefKeys: removedRefKeysRef.current,
      pendingRefKeys: pendingRefKeysRef.current,
    });
    if (refs.length === 0) {
      return;
    }

    const timerId = setTimeout(() => {
      void attachRefs({
        refs,
        queryClient,
        latestRef,
        removedRefKeys: removedRefKeysRef.current,
        pendingRefKeys: pendingRefKeysRef.current,
      });
    }, AUTO_ATTACH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timerId);
    };
  }, [
    params.text,
    params.remoteUrl,
    params.attachments,
    params.client,
    params.isConnected,
    params.serverId,
    params.cwd,
    queryClient,
  ]);

  const markGithubAttachmentRemoved = useCallback((attachment: ComposerAttachment | undefined) => {
    const key = attachmentKey(attachment);
    if (key) {
      removedRefKeysRef.current.add(key);
    }
  }, []);

  return useMemo(
    () => ({
      markGithubAttachmentRemoved,
    }),
    [markGithubAttachmentRemoved],
  );
}

async function attachRefs({
  refs,
  queryClient,
  latestRef,
  removedRefKeys,
  pendingRefKeys,
}: {
  refs: GithubRef[];
  queryClient: QueryClient;
  latestRef: RefObject<ComposerGithubAutoAttachInput>;
  removedRefKeys: Set<string>;
  pendingRefKeys: Set<string>;
}): Promise<void> {
  for (const ref of refs) {
    const key = githubRefKey(ref);
    if (pendingRefKeys.has(key)) {
      continue;
    }
    pendingRefKeys.add(key);
    try {
      await attachRef({ ref, key, queryClient, latestRef, removedRefKeys });
    } finally {
      pendingRefKeys.delete(key);
    }
  }
}

async function attachRef({
  ref,
  key,
  queryClient,
  latestRef,
  removedRefKeys,
}: {
  ref: GithubRef;
  key: string;
  queryClient: QueryClient;
  latestRef: RefObject<ComposerGithubAutoAttachInput>;
  removedRefKeys: Set<string>;
}): Promise<void> {
  const snapshot = latestRef.current;
  if (!snapshot.client || !snapshot.isConnected || !isRefStillPresent(ref, snapshot)) {
    return;
  }

  const search = await fetchGithubRefSearch({ ref, snapshot, queryClient });
  if (!search) {
    return;
  }
  const item = search.items.find((candidate) => githubItemMatchesRef(candidate, ref));
  if (!item || removedRefKeys.has(key) || !isRefStillPresent(ref, latestRef.current)) {
    return;
  }

  latestRef.current.setAttachments((current) => {
    if (removedRefKeys.has(key) || isAttachmentSelectedForGithubItem(current, item)) {
      return current;
    }
    return toggleGithubAttachment(current, item);
  });
}

function refsReadyForLookup({
  params,
  removedRefKeys,
  pendingRefKeys,
}: {
  params: ComposerGithubAutoAttachInput;
  removedRefKeys: Set<string>;
  pendingRefKeys: Set<string>;
}): GithubRef[] {
  if (!params.client || !params.isConnected || params.cwd.trim().length === 0) {
    return [];
  }

  return extractGithubRefs(params.text, params.remoteUrl).filter((ref) => {
    const key = githubRefKey(ref);
    return (
      !removedRefKeys.has(key) &&
      !pendingRefKeys.has(key) &&
      !hasGithubAttachment(params.attachments, ref)
    );
  });
}

async function fetchGithubRefSearch({
  ref,
  snapshot,
  queryClient,
}: {
  ref: GithubRef;
  snapshot: ComposerGithubAutoAttachInput;
  queryClient: QueryClient;
}) {
  if (!snapshot.client) {
    return null;
  }

  try {
    return await queryClient.fetchQuery(
      buildGithubSearchQueryOptions({
        client: snapshot.client,
        serverId: snapshot.serverId,
        cwd: snapshot.cwd,
        query: String(ref.number),
        enabled: true,
      }),
    );
  } catch {
    return null;
  }
}

function isRefStillPresent(ref: GithubRef, params: ComposerGithubAutoAttachInput): boolean {
  return extractGithubRefs(params.text, params.remoteUrl).some(
    (candidate) => githubRefKey(candidate) === githubRefKey(ref),
  );
}

function hasGithubAttachment(attachments: UserComposerAttachment[], ref: GithubRef): boolean {
  return attachments.some((attachment) => attachmentKey(attachment) === githubRefKey(ref));
}

function githubItemMatchesRef(item: GitHubSearchItem, ref: GithubRef): boolean {
  return item.kind === githubItemKind(ref) && item.number === ref.number;
}

function githubItemKind(ref: GithubRef): GitHubSearchItem["kind"] {
  return ref.kind === "pull" ? "pr" : "issue";
}

function githubRefKey(ref: GithubRef): string {
  return `${githubItemKind(ref)}:${ref.number}`;
}

function attachmentKey(attachment: ComposerAttachment | undefined): string | null {
  if (
    !attachment ||
    attachment.kind === "image" ||
    (attachment.kind !== "github_pr" && attachment.kind !== "github_issue")
  ) {
    return null;
  }
  return `${attachment.item.kind}:${attachment.item.number}`;
}
