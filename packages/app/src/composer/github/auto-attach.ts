import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import { buildForgeSearchQueryOptions, type ForgeSearchClient } from "@/git/use-forge-search-query";
import { extractGithubRefs, type GithubRef } from "@/utils/github-refs";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import { isAttachmentSelectedForGithubItem, toggleGithubAttachment } from "../actions";

const AUTO_ATTACH_DEBOUNCE_MS = 300;

interface ComposerGithubAutoAttachInput {
  text: string;
  remoteUrl: string | null | undefined;
  attachments: UserComposerAttachment[];
  client: ForgeSearchClient | null;
  isConnected: boolean;
  serverId: string;
  cwd: string;
  supportsForgeSearch?: boolean;
  setAttachments: Dispatch<SetStateAction<UserComposerAttachment[]>>;
}

interface ComposerGithubAutoAttachResult {
  isResolving: boolean;
  markGithubAttachmentRemoved: (attachment: ComposerAttachment | undefined) => void;
}

export function useComposerGithubAutoAttach(
  params: ComposerGithubAutoAttachInput,
): ComposerGithubAutoAttachResult {
  const queryClient = useQueryClient();
  const latestRef = useRef(params);
  const removedRefKeysRef = useRef(new Set<string>());
  const pendingRefKeysRef = useRef(new Set<string>());
  const [resolvingRefKeys, setResolvingRefKeys] = useState<ReadonlySet<string>>(() => new Set());

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

    const refKeys = refs.map(githubRefKey);
    setResolvingRefKeys((current) => addKeys(current, refKeys));
    let lookupStarted = false;

    const timerId = setTimeout(() => {
      lookupStarted = true;
      void attachRefs({
        refs,
        queryClient,
        latestRef,
        removedRefKeys: removedRefKeysRef.current,
        pendingRefKeys: pendingRefKeysRef.current,
      }).finally(() => {
        clearResolvingKeys(setResolvingRefKeys, refKeys);
      });
    }, AUTO_ATTACH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timerId);
      if (!lookupStarted) {
        clearResolvingKeys(setResolvingRefKeys, refKeys);
      }
    };
  }, [
    params.text,
    params.remoteUrl,
    params.attachments,
    params.client,
    params.isConnected,
    params.serverId,
    params.cwd,
    params.supportsForgeSearch,
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
      isResolving: resolvingRefKeys.size > 0,
      markGithubAttachmentRemoved,
    }),
    [markGithubAttachmentRemoved, resolvingRefKeys.size],
  );
}

function addKeys(current: ReadonlySet<string>, keys: readonly string[]): ReadonlySet<string> {
  if (keys.every((key) => current.has(key))) return current;
  const next = new Set(current);
  for (const key of keys) next.add(key);
  return next;
}

function removeKeys(current: ReadonlySet<string>, keys: readonly string[]): ReadonlySet<string> {
  if (keys.every((key) => !current.has(key))) return current;
  const next = new Set(current);
  for (const key of keys) next.delete(key);
  return next;
}

function clearResolvingKeys(
  setResolvingRefKeys: Dispatch<SetStateAction<ReadonlySet<string>>>,
  keys: readonly string[],
): void {
  setResolvingRefKeys((current) => removeKeys(current, keys));
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
      buildForgeSearchQueryOptions({
        client: snapshot.client,
        serverId: snapshot.serverId,
        cwd: snapshot.cwd,
        query: String(ref.number),
        supportsForgeSearch: snapshot.supportsForgeSearch,
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

function githubItemMatchesRef(item: ForgeSearchItem, ref: GithubRef): boolean {
  return item.kind === githubItemKind(ref) && item.number === ref.number;
}

function githubItemKind(ref: GithubRef): ForgeSearchItem["kind"] {
  return ref.kind === "pull" ? "change_request" : "issue";
}

function githubRefKey(ref: GithubRef): string {
  return `${githubItemKind(ref)}:${ref.number}`;
}

function attachmentKey(attachment: ComposerAttachment | undefined): string | null {
  if (
    !attachment ||
    attachment.kind === "image" ||
    (attachment.kind !== "forge_change_request" &&
      attachment.kind !== "forge_issue" &&
      attachment.kind !== "github_pr" &&
      attachment.kind !== "github_issue")
  ) {
    return null;
  }
  return `${attachment.item.kind}:${attachment.item.number}`;
}
