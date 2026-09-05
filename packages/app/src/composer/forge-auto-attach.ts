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
import { extractForgeRefs, type ForgeRef } from "@/git/forge-refs";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import { isAttachmentSelectedForForgeItem, toggleForgeAttachment } from "./actions";

const AUTO_ATTACH_DEBOUNCE_MS = 300;

interface ComposerForgeAutoAttachInput {
  text: string;
  remoteUrl: string | null | undefined;
  attachments: UserComposerAttachment[];
  client: ForgeSearchClient | null;
  isConnected: boolean;
  serverId: string;
  cwd: string;
  supportsForgeSearch?: boolean;
  setAttachments: Dispatch<SetStateAction<UserComposerAttachment[]>>;
  onChangeRequestDetected?: () => void;
  onChangeRequestAdded?: (item: ForgeSearchItem) => void;
}

interface ComposerForgeAutoAttachResult {
  isResolving: boolean;
  markForgeAttachmentRemoved: (attachment: ComposerAttachment | undefined) => void;
}

interface ActiveForgeLookup {
  invalidate: (keys: readonly string[]) => void;
  invalidateIrrelevant: (current: ComposerForgeAutoAttachInput) => void;
  hasPending: (key: string) => boolean;
}

export function useComposerForgeAutoAttach(
  params: ComposerForgeAutoAttachInput,
): ComposerForgeAutoAttachResult {
  const queryClient = useQueryClient();
  const latestRef = useRef(params);
  const removedRefKeysRef = useRef(new Set<string>());
  const presentChangeRequestKeysRef = useRef(new Set<string>());
  const activeLookupsRef = useRef(new Set<ActiveForgeLookup>());
  const previousTargetRef = useRef({ serverId: params.serverId, cwd: params.cwd });
  const [resolvingRefCounts, setResolvingRefCounts] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  latestRef.current = params;
  const lookupCandidateKey = getLookupCandidateKey(params, removedRefKeysRef.current);
  const lookupRelevanceKey = getLookupRelevanceKey(params, removedRefKeysRef.current);
  const presentChangeRequestKey = getPresentChangeRequestKey(params);
  const hasClient = params.client !== null;

  useEffect(() => {
    notifyNewChangeRequestRefs({
      params: latestRef.current,
      presentChangeRequestKeysRef,
    });
  }, [presentChangeRequestKey]);

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
    params.cwd,
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

    const refKeys = refs.map(forgeRefKey);
    setResolvingRefCounts((current) => addKeys(current, refKeys));
    const unreleasedRefKeys = new Set(refKeys);
    let lookupStarted = false;
    let lookup: ActiveForgeLookup | null = null;
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
    params.cwd,
    queryClient,
  ]);

  const markForgeAttachmentRemoved = useCallback((attachment: ComposerAttachment | undefined) => {
    const key = attachmentKey(attachment);
    if (key) {
      removedRefKeysRef.current.add(key);
    }
  }, []);

  return useMemo(
    () => ({
      isResolving: resolvingRefCounts.size > 0,
      markForgeAttachmentRemoved,
    }),
    [markForgeAttachmentRemoved, resolvingRefCounts.size],
  );
}

function getLookupCandidateKey(
  params: ComposerForgeAutoAttachInput,
  removedRefKeys: ReadonlySet<string>,
): string {
  return getLookupCandidateRefs(params, removedRefKeys).map(forgeRefKey).join("|");
}

function getLookupCandidateRefs(
  params: ComposerForgeAutoAttachInput,
  removedRefKeys: ReadonlySet<string>,
): ForgeRef[] {
  return extractForgeRefs(params.text, params.remoteUrl).filter((ref) => {
    const key = forgeRefKey(ref);
    return !removedRefKeys.has(key) && !hasForgeAttachment(params.attachments, ref);
  });
}

function didLookupSourceOrderChange(
  originalKeys: readonly string[],
  current: ComposerForgeAutoAttachInput,
  removedRefKeys: ReadonlySet<string>,
): boolean {
  const currentKeys = getLookupCandidateRefs(current, removedRefKeys).map(forgeRefKey);
  const currentKeySet = new Set(currentKeys);
  const retainedOriginalKeys = originalKeys.filter((key) => currentKeySet.has(key));
  return currentKeys.join("|") !== retainedOriginalKeys.join("|");
}

function getLookupRelevanceKey(
  params: ComposerForgeAutoAttachInput,
  removedRefKeys: ReadonlySet<string>,
): string {
  return extractForgeRefs(params.text, params.remoteUrl)
    .map(forgeRefKey)
    .filter((key) => !removedRefKeys.has(key))
    .sort()
    .join("|");
}

function getPresentChangeRequestKey(params: ComposerForgeAutoAttachInput): string {
  return extractForgeRefs(params.text, params.remoteUrl)
    .filter((ref) => ref.kind === "change_request")
    .map(forgeRefKey)
    .sort()
    .join("|");
}

function isLookupContextStillRelevant({
  ref,
  initial,
  current,
  removedRefKeys,
}: {
  ref: ForgeRef;
  initial: ComposerForgeAutoAttachInput;
  current: ComposerForgeAutoAttachInput;
  removedRefKeys: ReadonlySet<string>;
}): boolean {
  return (
    current.client !== null &&
    current.isConnected &&
    !removedRefKeys.has(forgeRefKey(ref)) &&
    isSameLookupTarget(initial, current) &&
    isRefStillPresent(ref, current)
  );
}

function suppressRefsCarriedAcrossTargets({
  params,
  previousTargetRef,
  removedRefKeys,
}: {
  params: ComposerForgeAutoAttachInput;
  previousTargetRef: RefObject<{ serverId: string; cwd: string }>;
  removedRefKeys: Set<string>;
}): void {
  const previous = previousTargetRef.current;
  const targetChanged =
    previous.cwd.trim().length > 0 &&
    params.cwd.trim().length > 0 &&
    (previous.serverId !== params.serverId || previous.cwd !== params.cwd);
  previousTargetRef.current = { serverId: params.serverId, cwd: params.cwd };
  if (!targetChanged) return;

  for (const ref of extractForgeRefs(params.text, params.remoteUrl)) {
    removedRefKeys.add(forgeRefKey(ref));
  }
}

function notifyNewChangeRequestRefs({
  params,
  presentChangeRequestKeysRef,
}: {
  params: ComposerForgeAutoAttachInput;
  presentChangeRequestKeysRef: RefObject<Set<string>>;
}): void {
  const currentKeys = new Set(
    extractForgeRefs(params.text, params.remoteUrl)
      .filter((ref) => ref.kind === "change_request")
      .map(forgeRefKey),
  );
  for (const key of currentKeys) {
    if (!presentChangeRequestKeysRef.current.has(key)) {
      params.onChangeRequestDetected?.();
    }
  }
  presentChangeRequestKeysRef.current = currentKeys;
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
  refs: ForgeRef[];
  initial: ComposerForgeAutoAttachInput;
  queryClient: QueryClient;
  latestRef: RefObject<ComposerForgeAutoAttachInput>;
  removedRefKeys: Set<string>;
  onSettled: (key: string) => void;
  onComplete: (lookup: ActiveForgeLookup) => void;
}): ActiveForgeLookup {
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
            removedRefKeys.has(forgeRefKey(ref)) ||
            isAttachmentSelectedForForgeItem(attachments, item)
          ) {
            return attachments;
          }
          return toggleForgeAttachment(attachments, item);
        });
      }
      if (item?.kind === "change_request") {
        latestRef.current.onChangeRequestAdded?.(item);
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
    const key = forgeRefKey(ref);
    void attachRef({ ref, key, queryClient, latestRef, removedRefKeys })
      .then((item) => settleOutcome(index, item))
      .finally(() => {
        onSettled(key);
      });
  });

  const lookup: ActiveForgeLookup = {
    invalidate(keys) {
      const invalidKeys = new Set(keys);
      const newlySettledKeys: string[] = [];
      refs.forEach((ref, index) => {
        const key = forgeRefKey(ref);
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
          (outcomes[index].settled || !hasForgeAttachment(current.attachments, ref))
            ? []
            : [forgeRefKey(ref)],
        ),
      );
    },
    hasPending(key) {
      const index = refs.findIndex((ref) => forgeRefKey(ref) === key);
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
  ref: ForgeRef;
  key: string;
  queryClient: QueryClient;
  latestRef: RefObject<ComposerForgeAutoAttachInput>;
  removedRefKeys: Set<string>;
}): Promise<ForgeSearchItem | null> {
  const snapshot = latestRef.current;
  if (!snapshot.client || !snapshot.isConnected || !isRefStillPresent(ref, snapshot)) {
    return null;
  }

  const search = await fetchForgeRefSearch({ ref, snapshot, queryClient });
  if (!search) {
    return null;
  }
  const item = search.items.find((candidate) => forgeItemMatchesRef(candidate, ref));
  const current = latestRef.current;
  if (
    !item ||
    removedRefKeys.has(key) ||
    !isSameLookupTarget(snapshot, current) ||
    !isRefStillPresent(ref, current)
  ) {
    return null;
  }

  if (isAttachmentSelectedForForgeItem(current.attachments, item)) {
    return null;
  }
  return item;
}

function refsReadyForLookup({
  params,
  removedRefKeys,
  activeLookups,
}: {
  params: ComposerForgeAutoAttachInput;
  removedRefKeys: Set<string>;
  activeLookups: ReadonlySet<ActiveForgeLookup>;
}): ForgeRef[] {
  if (!params.client || !params.isConnected || params.cwd.trim().length === 0) {
    return [];
  }

  return extractForgeRefs(params.text, params.remoteUrl).filter((ref) => {
    const key = forgeRefKey(ref);
    return (
      !removedRefKeys.has(key) &&
      ![...activeLookups].some((lookup) => lookup.hasPending(key)) &&
      !hasForgeAttachment(params.attachments, ref)
    );
  });
}

async function fetchForgeRefSearch({
  ref,
  snapshot,
  queryClient,
}: {
  ref: ForgeRef;
  snapshot: ComposerForgeAutoAttachInput;
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

function isRefStillPresent(ref: ForgeRef, params: ComposerForgeAutoAttachInput): boolean {
  return extractForgeRefs(params.text, params.remoteUrl).some(
    (candidate) => forgeRefKey(candidate) === forgeRefKey(ref),
  );
}

function isSameLookupTarget(
  initial: ComposerForgeAutoAttachInput,
  current: ComposerForgeAutoAttachInput,
): boolean {
  return (
    initial.serverId === current.serverId &&
    initial.cwd === current.cwd &&
    initial.remoteUrl === current.remoteUrl
  );
}

function hasForgeAttachment(attachments: UserComposerAttachment[], ref: ForgeRef): boolean {
  return attachments.some((attachment) => attachmentKey(attachment) === forgeRefKey(ref));
}

function forgeItemMatchesRef(item: ForgeSearchItem, ref: ForgeRef): boolean {
  return item.kind === forgeItemKind(ref) && item.number === ref.number;
}

function forgeItemKind(ref: ForgeRef): ForgeSearchItem["kind"] {
  return ref.kind === "change_request" ? "change_request" : "issue";
}

function forgeRefKey(ref: ForgeRef): string {
  return `${forgeItemKind(ref)}:${ref.number}`;
}

function attachmentKey(attachment: ComposerAttachment | undefined): string | null {
  if (
    attachment?.kind !== "forge_change_request" &&
    attachment?.kind !== "forge_issue" &&
    attachment?.kind !== "github_pr" &&
    attachment?.kind !== "github_issue"
  ) {
    return null;
  }
  return `${attachment.item.kind}:${attachment.item.number}`;
}
