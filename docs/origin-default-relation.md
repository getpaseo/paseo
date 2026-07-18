# Origin default relation

`originDefaultRelation` describes how a checkout's `HEAD` relates to the resolved
**origin default tip** (prefer `refs/remotes/origin/HEAD`, else the repository's
default branch under `origin/`). It is additive protocol data so already-landed
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
protected: sidebar/archive copy says it is patch-equivalent and **not ancestral**,
and auto-archive will not remove it on that evidence alone.

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
3. Clean working tree
4. Named branch (not detached)
5. Verifiable `originDefaultRelation` with state `exact` or `included`
6. Non-null relation `ahead` and no unique-patch risk (`uniquePatchCount` not `> 0`)
7. Not ahead of the branch upstream when `aheadOfOrigin` is a positive number
8. Paseo-owned worktree (founder / non-Paseo checkouts are never auto-archived)
9. Successful workspace resolution and archive path (errors skip, never force)

Missing relation (old daemon shape), `null` ahead, `ahead`,
`patch_equivalent_not_included`, `diverged_with_unique_commits`, `unverifiable`,
dirty trees, or archive failures **skip**. Inclusion is evidence used **only after**
the explicit auto-archive setting; it never initiates archive by itself.

## Cross-worktree refresh

Worktrees that share a git common directory share remote-default refs
(`refs/remotes/origin/*`, `packed-refs`, local default under `refs/heads`).
`WorkspaceGitService` watches those paths once per common dir and refreshes every
registered workspace snapshot so a main-sync or Queue publish in one checkout
updates `originDefaultRelation` (and `checkout_status_update` / `gitRuntime`) for
siblings promptly, without a separate polling subsystem.
