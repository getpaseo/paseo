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
import {
  buildForgeSearchQueryOptions,
  forgeSearchClientIdentity,
  type ForgeSearchClient,
} from "@/git/use-forge-search-query";
import { workspaceGitQueryIdentitiesEqual } from "@/git/workspace-git";
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
  supportsForgeSearch?: boolean;
  setAttachments: Dispatch<SetStateAction<UserComposerAttachment[]>>;
  onPullRequestDetected?: () => void;
  onPullRequestAdded?: (item: ForgeSearchItem) => void;
}

interface ComposerGithubAutoAttachResult {
  isResolving: boolean;
  markGithubAttachmentRemoved: (attachment: ComposerAttachment | undefined) => void;
}

interface ActiveGithubLookup {
  invalidate: (keys: readonly string[]) => void;
  invalidateIrrelevant: (current: ComposerGithubAutoAttachInput) => void;
  hasPending: (key: string) => boolean;
}

export function useComposerGithubAutoAttach(
  params: ComposerGithubAutoAttachInput,
): ComposerGithubAutoAttachResult {
  const queryClient = useQueryClient();
  const latestRef = useRef(params);
  const removedRefKeysRef = useRef(new Set<string>());
  const presentPullRequestKeysRef = useRef(new Set<string>());
  const activeLookupsRef = useRef(new Set<ActiveGithubLookup>());
  const previousTargetRef = useRef({ serverId: params.serverId, client: params.client });
  const [resolvingRefCounts, setResolvingRefCounts] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  latestRef.current = params;
  const lookupCandidateKey = getLookupCandidateKey(params, removedRefKeysRef.current);
  const lookupRelevanceKey = getLookupRelevanceKey(params, removedRefKeysRef.current);
  const presentPullRequestKey = getPresentPullRequestKey(params);
  const hasClient = params.client !== null;

  useEffect(() => {
    notifyNewPullRequestRefs({
      params: latestRef.current,
      presentPullRequestKeysRef,
    });
  }, [presentPullRequestKey]);

  useEffect(() => {
    const current = latestRef.current;
    for (const activeLookup of activeLookupsRef.current) {
      activeLookup.invalidateIrrelevant(current);
    }
  }, [
    lookupRelevanceKey,
    params.remoteUrl,
    hasClient,
    params.isConnected,
    params.serverId,
    params.client,
  ]);

  useEffect(() => {
    const initial = latestRef.current;
    const removedRefKeys = removedRefKeysRef.current;
    suppressRefsCarriedAcrossTargets({
      params: initial,
      previousTargetRef,
      removedRefKeys,
    });
    const refs = refsReadyForLookup({
      params: latestRef.current,
      removedRefKeys,
      activeLookups: activeLookupsRef.current,
    });
    if (refs.length === 0) {
      return;
    }

    const refKeys = refs.map(githubRefKey);
    setResolvingRefCounts((current) => addKeys(current, refKeys));
    const unreleasedRefKeys = new Set(refKeys);
    let lookupStarted = false;
    let lookup: ActiveGithubLookup | null = null;
    const releaseResolving = (keys: readonly string[]) => {
      const keysToRelease = keys.filter((key) => unreleasedRefKeys.delete(key));
      if (keysToRelease.length === 0) return;
      clearResolvingKeys(setResolvingRefCounts, keysToRelease);
    };

    const timerId = setTimeout(() => {
      lookupStarted = true;
      lookup = attachRefs({
        refs,
        initial,
        queryClient,
        latestRef,
        removedRefKeys,
        onSettled: (key) => releaseResolving([key]),
        onComplete: (completedLookup) => activeLookupsRef.current.delete(completedLookup),
      });
      activeLookupsRef.current.add(lookup);
    }, AUTO_ATTACH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timerId);
      if (!lookupStarted) {
        releaseResolving([...unreleasedRefKeys]);
        return;
      }
      const current = latestRef.current;
      if (didLookupSourceOrderChange(refKeys, current, removedRefKeys)) {
        lookup?.invalidate(refKeys);
      } else {
        lookup?.invalidateIrrelevant(current);
      }
    };
  }, [
    lookupCandidateKey,
    params.remoteUrl,
    hasClient,
    params.isConnected,
    params.serverId,
    params.client,
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
      isResolving: resolvingRefCounts.size > 0,
      markGithubAttachmentRemoved,
    }),
    [markGithubAttachmentRemoved, resolvingRefCounts.size],
  );
}

function getLookupCandidateKey(
  params: ComposerGithubAutoAttachInput,
  removedRefKeys: ReadonlySet<string>,
): string {
  return getLookupCandidateRefs(params, removedRefKeys).map(githubRefKey).join("|");
}

function getLookupCandidateRefs(
  params: ComposerGithubAutoAttachInput,
  removedRefKeys: ReadonlySet<string>,
): GithubRef[] {
  return extractGithubRefs(params.text, params.remoteUrl).filter((ref) => {
    const key = githubRefKey(ref);
    return !removedRefKeys.has(key) && !hasGithubAttachment(params.attachments, ref);
  });
}

function didLookupSourceOrderChange(
  originalKeys: readonly string[],
  current: ComposerGithubAutoAttachInput,
  removedRefKeys: ReadonlySet<string>,
): boolean {
  const currentKeys = getLookupCandidateRefs(current, removedRefKeys).map(githubRefKey);
  const currentKeySet = new Set(currentKeys);
  const retainedOriginalKeys = originalKeys.filter((key) => currentKeySet.has(key));
  return currentKeys.join("|") !== retainedOriginalKeys.join("|");
}

function getLookupRelevanceKey(
  params: ComposerGithubAutoAttachInput,
  removedRefKeys: ReadonlySet<string>,
): string {
  return extractGithubRefs(params.text, params.remoteUrl)
    .map(githubRefKey)
    .filter((key) => !removedRefKeys.has(key))
    .sort()
    .join("|");
}

function getPresentPullRequestKey(params: ComposerGithubAutoAttachInput): string {
  return extractGithubRefs(params.text, params.remoteUrl)
    .filter((ref) => ref.kind === "pull")
    .map(githubRefKey)
    .sort()
    .join("|");
}

function isLookupContextStillRelevant({
  ref,
  initial,
  current,
  removedRefKeys,
}: {
  ref: GithubRef;
  initial: ComposerGithubAutoAttachInput;
  current: ComposerGithubAutoAttachInput;
  removedRefKeys: ReadonlySet<string>;
}): boolean {
  return (
    current.client !== null &&
    current.isConnected &&
    !removedRefKeys.has(githubRefKey(ref)) &&
    isSameLookupTarget(initial, current) &&
    isRefStillPresent(ref, current)
  );
}

function suppressRefsCarriedAcrossTargets({
  params,
  previousTargetRef,
  removedRefKeys,
}: {
  params: ComposerGithubAutoAttachInput;
  previousTargetRef: RefObject<{
    serverId: string;
    client: ForgeSearchClient | null;
  }>;
  removedRefKeys: Set<string>;
}): void {
  const previous = previousTargetRef.current;
  const targetChanged =
    previous.client !== null &&
    params.client !== null &&
    previous.client.cwd.trim().length > 0 &&
    params.client.cwd.trim().length > 0 &&
    (previous.serverId !== params.serverId ||
      !workspaceGitQueryIdentitiesEqual(
        forgeSearchClientIdentity(previous.client),
        forgeSearchClientIdentity(params.client),
      ) ||
      previous.client.cwd !== params.client.cwd);
  previousTargetRef.current = { serverId: params.serverId, client: params.client };
  if (!targetChanged) return;

  for (const ref of extractGithubRefs(params.text, params.remoteUrl)) {
    removedRefKeys.add(githubRefKey(ref));
  }
}

function notifyNewPullRequestRefs({
  params,
  presentPullRequestKeysRef,
}: {
  params: ComposerGithubAutoAttachInput;
  presentPullRequestKeysRef: RefObject<Set<string>>;
}): void {
  const currentKeys = new Set(
    extractGithubRefs(params.text, params.remoteUrl)
      .filter((ref) => ref.kind === "pull")
      .map(githubRefKey),
  );
  for (const key of currentKeys) {
    if (!presentPullRequestKeysRef.current.has(key)) {
      params.onPullRequestDetected?.();
    }
  }
  presentPullRequestKeysRef.current = currentKeys;
}

function addKeys(
  current: ReadonlyMap<string, number>,
  keys: readonly string[],
): ReadonlyMap<string, number> {
  const nextCounts = new Map(current);
  for (const key of keys) nextCounts.set(key, (nextCounts.get(key) ?? 0) + 1);
  return nextCounts;
}

function removeKeys(
  current: ReadonlyMap<string, number>,
  keys: readonly string[],
): ReadonlyMap<string, number> {
  const next = new Map(current);
  for (const key of keys) {
    const count = next.get(key) ?? 0;
    if (count <= 1) next.delete(key);
    else next.set(key, count - 1);
  }
  return next;
}

function clearResolvingKeys(
  setResolvingRefCounts: Dispatch<SetStateAction<ReadonlyMap<string, number>>>,
  keys: readonly string[],
): void {
  setResolvingRefCounts((current) => removeKeys(current, keys));
}

function attachRefs({
  refs,
  initial,
  queryClient,
  latestRef,
  removedRefKeys,
  onSettled,
  onComplete,
}: {
  refs: GithubRef[];
  initial: ComposerGithubAutoAttachInput;
  queryClient: QueryClient;
  latestRef: RefObject<ComposerGithubAutoAttachInput>;
  removedRefKeys: Set<string>;
  onSettled: (key: string) => void;
  onComplete: (lookup: ActiveGithubLookup) => void;
}): ActiveGithubLookup {
  const outcomes = refs.map(() => ({
    settled: false,
    item: null as ForgeSearchItem | null,
  }));
  let nextOutcomeIndex = 0;
  let didComplete = false;
  const drainOutcomes = () => {
    while (outcomes[nextOutcomeIndex]?.settled) {
      const item = outcomes[nextOutcomeIndex].item;
      const ref = refs[nextOutcomeIndex];
      nextOutcomeIndex += 1;
      if (item) {
        latestRef.current.setAttachments((attachments) => {
          if (
            removedRefKeys.has(githubRefKey(ref)) ||
            isAttachmentSelectedForGithubItem(attachments, item)
          ) {
            return attachments;
          }
          return toggleGithubAttachment(attachments, item);
        });
      }
      if (item?.kind === "change_request") {
        latestRef.current.onPullRequestAdded?.(item);
      }
    }
    if (!didComplete && nextOutcomeIndex === outcomes.length) {
      didComplete = true;
      onComplete(lookup);
    }
  };
  const settleOutcome = (index: number, item: ForgeSearchItem | null): boolean => {
    if (outcomes[index].settled) return false;
    outcomes[index] = { settled: true, item };
    drainOutcomes();
    return true;
  };

  refs.forEach((ref, index) => {
    const key = githubRefKey(ref);
    void attachRef({ ref, key, queryClient, latestRef, removedRefKeys })
      .then((item) => settleOutcome(index, item))
      .finally(() => {
        onSettled(key);
      });
  });

  const lookup: ActiveGithubLookup = {
    invalidate(keys) {
      const invalidKeys = new Set(keys);
      const newlySettledKeys: string[] = [];
      refs.forEach((ref, index) => {
        const key = githubRefKey(ref);
        if (!invalidKeys.has(key) || index < nextOutcomeIndex) return;
        if (!outcomes[index].settled) newlySettledKeys.push(key);
        outcomes[index] = { settled: true, item: null };
      });
      for (const key of newlySettledKeys) onSettled(key);
      drainOutcomes();
    },
    invalidateIrrelevant(current) {
      lookup.invalidate(
        refs.flatMap((ref, index) =>
          isLookupContextStillRelevant({ ref, initial, current, removedRefKeys }) &&
          (outcomes[index].settled || !hasGithubAttachment(current.attachments, ref))
            ? []
            : [githubRefKey(ref)],
        ),
      );
    },
    hasPending(key) {
      const index = refs.findIndex((ref) => githubRefKey(ref) === key);
      return index >= 0 && !outcomes[index].settled;
    },
  };
  return lookup;
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
}): Promise<ForgeSearchItem | null> {
  const snapshot = latestRef.current;
  if (!snapshot.client || !snapshot.isConnected || !isRefStillPresent(ref, snapshot)) {
    return null;
  }

  const search = await fetchGithubRefSearch({ ref, snapshot, queryClient });
  if (!search) {
    return null;
  }
  const item = search.items.find((candidate) => githubItemMatchesRef(candidate, ref));
  const current = latestRef.current;
  if (
    !item ||
    removedRefKeys.has(key) ||
    !isSameLookupTarget(snapshot, current) ||
    !isRefStillPresent(ref, current)
  ) {
    return null;
  }

  if (isAttachmentSelectedForGithubItem(current.attachments, item)) {
    return null;
  }
  return item;
}

function refsReadyForLookup({
  params,
  removedRefKeys,
  activeLookups,
}: {
  params: ComposerGithubAutoAttachInput;
  removedRefKeys: Set<string>;
  activeLookups: ReadonlySet<ActiveGithubLookup>;
}): GithubRef[] {
  if (!params.client || !params.isConnected || params.client.cwd.trim().length === 0) {
    return [];
  }

  return extractGithubRefs(params.text, params.remoteUrl).filter((ref) => {
    const key = githubRefKey(ref);
    return (
      !removedRefKeys.has(key) &&
      ![...activeLookups].some((lookup) => lookup.hasPending(key)) &&
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

function isSameLookupTarget(
  initial: ComposerGithubAutoAttachInput,
  current: ComposerGithubAutoAttachInput,
): boolean {
  return (
    initial.serverId === current.serverId &&
    (initial.client === null || current.client === null
      ? initial.client === current.client
      : workspaceGitQueryIdentitiesEqual(
          forgeSearchClientIdentity(initial.client),
          forgeSearchClientIdentity(current.client),
        )) &&
    initial.client?.cwd === current.client?.cwd &&
    initial.remoteUrl === current.remoteUrl
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
