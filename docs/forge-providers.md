# Adding a Git Forge to Paseo

Paseo's forge layer is a registry/manifest system. A forge is a runtime concern:
shared protocol messages carry neutral/open facts, the server adapter owns
behavior, and the app owns bundled presentation/runtime interpretation.

The maintainer litmus test is the rule of thumb:

> Adding a new forge means adding files in a new directory/module that implement
> an interface, plus one entry in the centralized registry/manifest for that
> package.

## The Three Registrations

For forge `acme`, the expected end state is:

1. **Protocol manifest** - optional, only when the forge should be presented by
   shared manifest data. Add one `ForgeDefinition` to
   `packages/protocol/src/forge-manifest.ts`.

2. **Server adapter** - add `packages/server/src/services/acme-service.ts`
   implementing `ForgeService`, any adapter-owned fact types/guards/constants
   beside it, and one `defaultForgeRegistry` entry in
   `packages/server/src/services/forge-registry.ts`.

3. **App modules** - a forge splits into a pure logic half and a view half so
   logic consumers (URL builders, merge-capability, native checks, and the
   Node-based e2e harness) never pull the client rendering stack:
   - `packages/app/src/git/forges/acme.ts` - logic: `id`, optional `urlGrammar`,
     optional `facts` (schema, merge-capability, native-check fallbacks). No
     React/React-Native imports. Register in `CLIENT_FORGE_LOGIC_MODULES` in
     `packages/app/src/git/forges/index.ts`.
   - `packages/app/src/git/forges/acme.view.tsx` - view: `icon` (SVG component
     under `packages/app/src/components/icons/`), optional `brandColor`, optional
     `paneContributions`. Register in `CLIENT_FORGE_VIEW_MODULES` in
     `packages/app/src/git/forges/view.ts`.

There should be no protocol typed-union arm, no central app icon/color/url/facts
map, and no central server union of known forge facts.

## Protocol

`forgeSpecific` on PR status is an open envelope:

```ts
z.object({ forge: z.string() }).passthrough();
```

The `forgeSpecific.forge` field is a **facts-family tag**, not the workspace
brand id. Gitea, Forgejo, and Codeberg can all emit `forgeSpecific.forge ===
"gitea"` when they share the same facts shape, while top-level `status.forge`
keeps the brand id (`"gitea"`, `"forgejo"`, `"codeberg"`).

Protocol does not validate per-forge fact fields. Consumers that understand a
facts family validate at runtime with their own schema/guard. Unknown or
schema-mismatched facts render neutrally instead of failing the whole message
parse. This is the version-skew win: an old client can receive facts from a
newer forge and still show the PR/MR in a neutral state.

Shipped GitHub compatibility stays separate:

- `status.github` remains accepted for released peers.
- The server keeps the `COMPAT(forgeSpecific)` mirror that copies GitHub facts
  into `status.github` for older clients.
- Do not add a compatibility shim unless a released peer (<= 0.1.102) can
  actually produce the state.

## Server

The server-wide status type only promises:

```ts
type ForgeSpecificStatusFacts = { forge: string } & Record<string, unknown>;
```

Adapter-owned files define the typed shapes and guards, for example
`github-facts.ts`, `gitlab-facts.ts`, and `gitea-facts.ts`. The adapter can keep
strong internal types for construction and command guards, but shared server
code must not grow a central list of forge fact arms.

Register the adapter in `defaultForgeRegistry` with:

- `createService`
- `matchesHost` from manifest `cloudHosts`
- `probeHost` when self-hosted/Enterprise detection is supported

Current change-request lookup uses two identities deliberately:

- An open PR/MR belongs to the checkout when its head branch and head repository
  match. Its remote head SHA may differ because the checkout can be ahead,
  behind, or contain commits that have not been pushed yet.
- A merged or closed PR/MR belongs to the checkout only when its recorded head
  SHA exactly matches the checkout's current `HEAD`. Branch names are reusable;
  selecting the newest terminal request by branch alone can silently attach an
  old promotion or feature request to new work.

Thread the checkout head SHA through adapter cache and poll identities as well
as the lookup itself. Otherwise a commit made on the same branch can inherit the
previous commit's cached terminal status until the cache expires.

### The poll budget is shared

`retainCurrentPullRequestStatusPoll` is per workspace, but the API quota behind it
is per account. One retained poll per workspace, each running its own timer and its
own request, does not survive a couple of dozen open workspaces: GitHub's GraphQL
quota is 5000 points per hour for the whole daemon, and the unbatched lookup spent
58 requests refreshing 20 workspaces once.

So an adapter that can address change requests by repository owes the shared
scheduler, not a timer per target. The GitHub adapter keeps one timer for every
retained target, collects whichever ones are due, groups them by resolved host
(GH_HOST is per workspace, and a GitHub Enterprise workspace must never ride along
in a github.com request), and sends one aliased document per group. The same 20
workspaces then cost 2 points in one request.

Three things that fall out of batching and are easy to get wrong:

- **Address repositories from data you already have.** The caller passes
  `remoteUrl`, so the adapter parses owner/name instead of asking the API, or even
  git, which repository a workspace points at.
- **A failing alias must not fail the batch.** `gh api graphql` exits non-zero when
  any aliased field errors, and still prints the partial `data` next to an `errors`
  array whose `path[0]` names the alias. Read `stdout` off the error, report only
  the named targets, and deliver everyone else's status.
- **A fork holds no pull requests.** A pull request belongs to its base repository,
  so `pullRequests(headRefName:)` on a fork is always empty while the same field on
  the parent returns fork branches too, tagged with `headRepositoryOwner`. Redirect
  a fork to its parent once and remember it per repository.

Watch the quota rather than discovering it is gone: select `rateLimit` in the batch
and stretch every cadence to the error-backoff cap once the remaining points get
close to what user-driven reads need.

Cloud hosts in the manifest are a bounded public-host list, not a self-host
allowlist. Self-hosted detection is a trust gate: Paseo only talks to a forge
host that is either a known cloud host or one the CLI is already authenticated
to. Adapter probes must not make anonymous HTTP requests to remote-derived
hosts, and adapters must not route credentials to an unauthenticated host.

## App

Each app forge splits into two modules so pure logic never imports the client
rendering stack:

`acme.ts` exports a `ClientForgeLogicModule`:

- `id`
- optional `urlGrammar`
- optional `facts` registration (schema, merge-capability, native-check fallbacks)

`acme.view.tsx` exports a `ClientForgeViewModule`:

- `id`
- `icon`
- `brandColor` (`null` for neutral; GitHub intentionally uses `null`)
- optional `paneContributions`

Two registries live under `packages/app/src/git/forges/`:
`CLIENT_FORGE_LOGIC_MODULES` (`index.ts`) drives URL grammar, merge-capability
derivation, and native fallback checks; `CLIENT_FORGE_VIEW_MODULES` (`view.ts`)
drives icon/color lookup and PR-pane contributions. Logic consumers must import
the logic registry only — importing the view registry (or a `.view.tsx` module)
from a logic path pulls react-native and breaks the Node-based e2e harness.

Per-forge brand colors live on the module, not in `styles/theme.ts`. Use the
Unistyles-safe pattern from `docs/unistyles.md`: no `useUnistyles()`. Brand icon
call sites use `withUnistyles` and a `uniProps` mapping such as:

```ts
(theme) => ({ color: theme.colorScheme === "light" ? colors.light : colors.dark });
```

Facts modules use one source of truth: a Zod schema. Helpers like
`defineForgeFacts`, `defineNativeFallbackCheck`, and `definePaneContribution`
derive guards from `schema.safeParse` and re-parse before invoking typed
derivers/renderers. That keeps typed derivers away from the open wire envelope.

## Checklist

To add `acme`:

1. Add `acme` to `FORGE_DEFINITIONS` if the shared manifest should know its
   label, nouns, icon kind, sign-in CLI, or cloud hosts.
2. Add `acme-service.ts` implementing `ForgeService`.
3. Add `acme-facts.ts` beside the adapter if it reports native facts.
4. Add one `defaultForgeRegistry` entry.
5. Add `packages/app/src/git/forges/acme.ts` (logic) and
   `packages/app/src/git/forges/acme.view.tsx` (view).
6. Add one `CLIENT_FORGE_LOGIC_MODULES` entry (`index.ts`) and one
   `CLIENT_FORGE_VIEW_MODULES` entry (`view.ts`).
7. Add/update the icon component only if the client bundle should show a brand
   mark.
8. If the forge's CI/data model does not fit an existing required
   `ForgeService` field, widen the shared interface (plus the protocol schema
   and its guards) instead of faking a value — e.g. Gitea Actions runs carry no
   check-run id, so `GetCheckDetailsOptions.checkRunId` became optional with
   `workflowRunId` as the alternative address. Expect this step to touch
   `forge-service.ts`, `messages.ts`, and the call-site guards of the other
   adapters. Widening a shared field is not forge-local: it also affects the
   already-shipped forges/GitHub call sites and the capability-gated RPC (e.g.
   `forgeCheckDetails`), so verify every consumer rather than assuming the change
   only reaches the new adapter.
9. Run targeted tests: manifest/registry/resolver, the adapter test, protocol
   checkout PR schema, app forge URL/presentation tests, app merge capability,
   and any PR-pane native data tests touched.

Run `npm run typecheck` after each implementation slice. If protocol or client
declarations are stale, run `npm run build:client`; if server/CLI declarations
are stale, run `npm run build:server`.

## Gotchas

- GitHub is a normal registry entry plus released compatibility shims. Keep all
  real shims tagged with `COMPAT(name)`.
- Gitea-family facts use `forgeSpecific.forge === "gitea"` even when the
  top-level brand is Forgejo or Codeberg.
- Brand icons are bundled React components, so they cannot come from protocol
  manifest data.
- Source URL grammars are app-side because blob/tree path syntax is
  forge-specific. If a forge has no grammar, omit the "Open on ..." source link
  rather than constructing a wrong URL.
- GitLab pipeline status constants belong to the GitLab adapter/client module,
  not protocol.
