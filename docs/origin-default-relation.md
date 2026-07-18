# Origin default relation

`originDefaultRelation` describes how a checkout's `HEAD` relates to the resolved
**origin default tip**. Resolution requires authoritative
`refs/remotes/origin/HEAD` evidence: a valid symbolic-ref whose target is under
`refs/remotes/origin/*` and whose target ref exists. Missing, malformed,
wrong-namespace, or dangling targets yield `unverifiable` with null
counts/ref as appropriate — there is **no** fall back to local `main`/`master`
for this safety field (local heuristics remain only for unrelated non-safety
base operations such as `baseRef`). It is additive protocol data so already-landed
work is not treated as unpushed risk.

## Ancestry vs patch equivalence

| State                           | Meaning                                                                          | Safety for auto-archive          |
| ------------------------------- | -------------------------------------------------------------------------------- | -------------------------------- |
| `exact`                         | `HEAD` OID equals the origin default tip                                         | Safe evidence (with other gates) |
| `included`                      | `HEAD` is an ancestor of origin default                                          | Safe evidence (with other gates) |
| `ahead`                         | Origin default is an ancestor of `HEAD`; unique commits remain                   | Not safe                         |
| `patch_equivalent_not_included` | Same tree / no unique patches, but **not** ancestral inclusion (e.g. squash tip) | Not safe — still protected       |
| `diverged_with_unique_commits`  | Diverged with unique patch content                                               | Not safe                         |
| `unverifiable`                  | Missing remote default, detached ambiguity, or proof budget exceeded             | Not safe                         |

**Ancestral inclusion** (`exact` / `included`) means every commit on `HEAD` is
already reachable from origin default. The work has landed in the history sense.

**Patch equivalence** is weaker. A squash merge can leave a feature tip with a
different commit graph that happens to produce the same tree (or cherry-equivalent
patches). That is **not** ancestral inclusion. The branch is still treated as
protected: sidebar/archive copy says changes landed on the default tip while the
branch itself is not merged, and auto-archive will not remove it on that evidence
alone.

Legacy `aheadOfOrigin` / `behindOfOrigin` continue to mean "ahead of the branch's
configured upstream," not "ahead of origin default." Do not conflate the two.

## Explicit archive authority

### Manual archive

The user always retains archive authority. Confirmation still runs when the
worktree is dirty or carries unique / unpushed risk. Inclusion may suppress a
stale "N unpushed commits" warning, but never forces an archive.

### Auto-archive after merge

Auto-archive is **fail closed**. All of the following are required:

1. Explicit setting `autoArchiveAfterMerge === true`
2. Merged pull request observed for that checkout
3. **Forced fresh** git snapshot (`force: true`, `includeForge: false`, reason
   `auto-archive-on-merge`) — never gate on a cached snapshot
4. Clean working tree — `isDirty === false` (null/undefined is unknown and fails)
5. Named branch (not detached)
6. Verifiable `originDefaultRelation` with state `exact` or `included`
7. Relation `ahead === 0` (null/undefined/nonzero fail)
8. Relation `uniquePatchCount === 0` (null/undefined/nonzero fail)
9. Branch upstream `aheadOfOrigin === 0` (null/undefined/nonzero fail)
10. Paseo-owned worktree (founder / non-Paseo checkouts are never auto-archived)
11. Successful workspace resolution and archive path (errors skip, never force)

Unknown fields never pass: missing relation (old daemon shape), `null`/`undefined`
counts, non-zero ahead, non-safe relation states (`ahead`,
`patch_equivalent_not_included`, `diverged_with_unique_commits`, `unverifiable`),
dirty or unknown dirty trees, or archive failures **skip**. Inclusion is evidence
used **only after** the explicit auto-archive setting; it never initiates archive
by itself.

## Cross-worktree refresh

Worktrees that share a git common directory share remote-default refs
(`refs/remotes/origin/*`, `packed-refs`, local default under `refs/heads`).
`WorkspaceGitService` watches those paths once per common dir and schedules a
**forced** debounced refresh (`force: true`, `includeForge: false`, reason
`common-dir-refs`) for every registered workspace so a main-sync or Queue publish
in one checkout updates `originDefaultRelation` (and `checkout_status_update` /
`gitRuntime`) for siblings promptly. Force bypasses the 2s non-forced internal
throttle while debounce still coalesces watcher storms; no forge/network work.
