# Coding Standards

The core instinct: AI-generated code hedges — it covers every case, layers over instead of cutting in, scatters uncertainty everywhere, wraps in case. A senior engineer commits — to a shape, a boundary, a name, a happy path, a type — and lets everything else fall into place. Every rule below catches a different form of indecision.

For testing rules, see [testing.md](testing.md).

## Core principles

- **Zero complexity budget** — every abstraction must justify itself with a specific, current benefit.
- **YAGNI** — build features and abstractions only when needed. A function called once is indirection, not abstraction.
- **No "while I'm at it" cleanups** — make the change you came for. Drive-by edits hide in the diff.
- **Functional and declarative** over object-oriented.
- **`function` declarations** over arrow function assignments.
- **`interface`** over `type` when both work.
- **No `index.ts` barrel files** that only re-export — they create indirection and circular-dep risk. Import from the source.

## Comments and noise

- Delete any comment where removing it loses zero information. Comments explain _why_, not _what_.
- No tutorial comments explaining language features (`// Use destructuring to...`).
- No decorative section dividers (`// ===== Helpers =====`). Use files and modules to organize, not ASCII art.
- No hedging comments (`// might need to revisit`, `// should work for most cases`). If you're unsure, investigate.
- No commented-out code. Git remembers.
- No `console.log` / `debugger` left behind. No `TODO: implement` stubs — if it needs to exist, write it.

## Confidence: commit to a shape

- Validate at boundaries (network, IPC, user input, file I/O), trust types internally. After the parse, the value is what its type says.
- Every `?.` and `??` past the validation boundary is unconfident code — either the boundary should resolve it, or the type should reflect reality.
- No defensive checks for conditions the type system already rules out (`if (!agent) return` on a non-nullable parameter).
- No `try/catch` "just in case." If you can't say what you're catching and why, don't catch.
- Optionality is a design decision, not a migration shortcut. Distinct valid states → discriminated union. Intentionally empty → explicit `null`. Keep optionality at real boundaries.

## Types

- No `any`. No `as` casts to bypass errors. No `@ts-ignore` / `@ts-expect-error`. Narrow with `if` / schema validation; let the compiler check harder, not less.
- If a Zod schema exists, the TypeScript type is `z.infer<typeof schema>`. Never hand-write a parallel type.
- One canonical type per concept. Layer-specific views are `Pick` / `Omit`, not duplicated fields.
- Name multi-property object shapes — no inline `Array<{ ... }>` or `Promise<{ ... }>` in signatures, returns, or generic args.
- Use string literal unions, not raw `string`, when the value is one of a known set. Catches typos at compile time.
- Object parameters past the obvious-name threshold: 3+ args, any boolean arg, any optional arg → object. `(thing, true, false, true)` is unreadable at the call site.
- Make impossible states impossible — discriminated unions over `{ isLoading; error?; data? }` bags.

## Errors

- Throw typed error classes that carry the fields a caller would want to read. Plain `Error("Provider X not found")` collapses structured info into a string.
- Catch blocks branch on `instanceof` for what they can handle; rethrow the rest. No `catch (e) { return null }`.
- Separate user-facing copy from log/debug strings — don't make one string serve telemetry, logs, and the UI.
- Fail explicitly. If the caller asked for X and X isn't available, throw — don't silently substitute Y.

## Density

- Nested ternaries are forbidden. A single ternary is fine only when both branches are a single identifier or trivial access (`x ? a : b`).
- Boolean expressions with 2+ clauses or mixed concerns → name the conditions.
- Object literals assemble pre-computed values; don't pack branching and lookups into property positions.
- Operations wrapping operations (`Object.fromEntries(arr.filter(...).map(...))`, `Math.max(...xs.map(...))`) → break into named intermediates.
- Max 3 levels of nesting (callbacks, JSX, control flow). Above that, extract.

## Structure and modules

- A directory is a module, not a namespace. One intentional public surface; internal files stay internal.
- Path is part of the name — prefer `provider/registry.ts` over `provider/provider-registry.ts`. If the filename has to do double duty, deepen the path.
- Filenames ending in `-utils`, `-helpers`, `-manager`, `-handler`, `-controller`, `-formatter`, `-builder` are a smell — the path didn't carry enough domain.
- Boundary returns answer the caller's question (`getActiveAgents()`), not "here's my storage" (`getAgents().filter(...)` repeated everywhere).
- One adapter means a hypothetical seam; two adapters means a real one. Don't define a port until something actually varies across it.
- Pass-through modules fail the deletion test — if removing the module makes callers go straight to what they wanted, delete it.
- Centralize policy. The same discriminator (`plan`, `provider`, `kind`, `status`) branched in 3+ files → policy table, not another `else if` per case.
- New features get a home before implementation. A feature smeared across 5 shared files is the same slop as a flat-peer namespace.
- Don't drop new files at the nearest root just because placement is unclear — say so and ask.

## Refactoring is a bolt-on test

- A change should look like a thoughtful edit to existing code, not a new layer next to it. New coordinator wrapping a coordinator, new flag bypassing the normal path, new helper duplicating an existing selector — stop and reshape instead.
- Refactors preserve behavior by default. No removing features to simplify code without explicit approval.
- Have a verification plan _before_ refactoring — name the invariants, confirm a test holds them, write one if not. See [testing.md](testing.md).
- Migrate all callers and remove old paths in the same refactor. No fallback behavior unless explicitly designed.

## React

- `useEffect` is for synchronizing with external systems (DOM, network, timers, subscriptions). Not for transforming React state. Derived state → compute in render or `useMemo`.
- No effect cascades — chains of effects setting state that triggers more effects almost always want React Query or a reducer.
- `useRef` is for DOM refs and non-rendering identities (timer IDs, AbortController, latest-callback caches). If the value affects what renders next, it's state — model it explicitly with `useReducer` and a discriminated union.
- Server state goes through React Query. Manual `useState` + `useEffect` + `isLoading` + `error` for fetched data is always worse.
- Components render and dispatch — they don't compute transitions. Two-plus interacting `useState`s → extract a reducer.
- Never define components inside other components. Module-scope only.
- Subscribe narrowly: select primitives from stores, pass `status` not `agent`, use `useShallow` / deep-equal when returning derived arrays/objects.
- Stable references for props that cross `memo` boundaries or feed dependency arrays. Static literals at module scope `as const`; derived with `useMemo`; handlers with `useCallback` only when there's a memoized beneficiary.
- Use stable ids for `key`, never array index for reorderable/filterable lists.
- Context for stable values (theme, auth). Store with selectors for state that changes.

## Naming

- Names describe meaning, not mechanics. `submitForm` over `handleOnClickButtonSubmit`. `running` over `filteredArrayOfRunningAgents`.
- The right length is the shortest unambiguous in context. Inside `AgentManager`, methods are `start`, `stop`, `list`.
- Match the surrounding code's vocabulary. If the codebase uses `getX`, don't introduce `fetchX` / `retrieveX` for the same shape.
- Don't leak implementation into names — `getAgent`, not `queryPostgresForAgent`. If swapping the impl would force a rename, the name is wrong.
- Booleans read as yes/no questions: `isX`, `hasX`, `canX`. Avoid negative booleans (`isNotConnected`).
- `data`, `result`, `info`, `manager`, `temp` are smells — say what the thing _is_.
